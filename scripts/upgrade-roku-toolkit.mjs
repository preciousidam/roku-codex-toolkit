#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { buildWindowsShimInvocation, requirePython, requireSupportedNode } from "./runtime-support.mjs";
import { acquireToolkitLock } from "./toolkit-lock.mjs";
import {
  checkoutIsClean,
  classifyReceiptEntry,
  classifyUpgradeState,
  executeUpgradeTransaction,
  inferReceiptFromCheckout,
  upgradeInventory,
} from "./upgrade-state.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageVersion = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
const source = "preciousidam/roku-codex-toolkit";
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: roku-codex-toolkit upgrade");
  process.exit(0);
}
if (args.length > 0) throw new Error(`Unknown upgrade option${args.length === 1 ? "" : "s"}: ${args.join(", ")}`);

const controller = new AbortController();
let rollbackMode = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!controller.signal.aborted) controller.abort(new Error(`Upgrade cancelled by ${signal}.`));
  });
}
process.on("message", (message) => {
  if (
    message?.type === "roku-toolkit-cancel" &&
    ["SIGINT", "SIGTERM"].includes(message.signal) &&
    !controller.signal.aborted
  ) {
    controller.abort(new Error(`Upgrade cancelled by ${message.signal}.`));
  }
});

function invocation(command, commandArgs) {
  if (process.platform !== "win32" || !["codex", "git"].includes(command)) {
    return { executable: command, args: commandArgs, env: process.env };
  }
  const shim = buildWindowsShimInvocation(command, commandArgs);
  return {
    executable: "powershell.exe",
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", shim.script],
    env: { ...process.env, ...shim.environment },
  };
}

async function terminateTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
      const timer = setTimeout(() => { killer.kill(); resolve(); }, 5_000);
      const done = () => { clearTimeout(timer); resolve(); };
      killer.once("exit", done);
      killer.once("error", done);
    });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
    const started = Date.now();
    while (Date.now() - started < 3_000) {
      try { process.kill(-child.pid, 0); } catch (error) {
        if (error?.code === "ESRCH") return;
      }
      if (Date.now() - started >= 2_000) {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
}

async function run(command, commandArgs, { cwd = packageRoot, capture = false, timeout = 30_000 } = {}) {
  if (controller.signal.aborted && !rollbackMode) throw controller.signal.reason;
  const resolved = invocation(command, commandArgs);
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.executable, resolved.args, {
      cwd,
      env: resolved.env,
      detached: process.platform !== "win32",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let terminationError;
    let stopping = false;
    child.stdout?.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr?.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    let settled = false;
    const finish = (error, status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else if (status !== 0) reject(new Error(`${command} failed with exit code ${status}.`));
      else resolve({ stdout, stderr });
    };
    const stop = async (error) => {
      if (stopping) return;
      stopping = true;
      terminationError = error;
      await terminateTree(child);
      finish(error);
    };
    const onAbort = () => { void stop(controller.signal.reason); };
    if (!rollbackMode) controller.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { void stop(new Error(`${command} timed out after ${timeout}ms.`)); }, timeout);
    child.once("error", (error) => finish(new Error(`${command} is required but unavailable: ${error.message}`)));
    child.once("exit", (status) => {
      if (!stopping) finish(terminationError, status);
    });
  });
}

async function jsonCommand(commandArgs, description) {
  const result = await run("codex", commandArgs, { capture: true });
  try { return JSON.parse(result.stdout); } catch { throw new Error(`${description} returned malformed JSON.`); }
}

async function inspectState() {
  const marketplaceResult = await jsonCommand(["plugin", "marketplace", "list", "--json"], "Marketplace inspection");
  const pluginResult = await jsonCommand(["plugin", "list", "--json"], "Plugin inspection");
  const marketplaces = marketplaceResult.marketplaces ?? [];
  const plugins = pluginResult.installed ?? [];
  const marketplace = marketplaces.find((entry) => entry?.name === upgradeInventory.marketplaceName);
  if (!marketplace?.root || !path.isAbsolute(marketplace.root)) {
    return { marketplaces, plugins, receipt: undefined, checkout: undefined };
  }
  let root;
  try { root = fs.realpathSync(marketplace.root); } catch { return { marketplaces, plugins }; }
  const receiptPath = path.join(root, ".codex-marketplace-install.json");
  let receipt;
  try {
    if (fs.realpathSync(path.dirname(receiptPath)) !== root) throw new Error("unsafe root");
  } catch {
    return { marketplaces, plugins, receipt: undefined, checkout: undefined };
  }
  let receiptEntry;
  try {
    receiptEntry = fs.lstatSync(receiptPath);
  } catch (error) {
    if (error?.code !== "ENOENT") return { marketplaces, plugins, receipt: undefined, checkout: undefined };
  }
  const receiptEntryType = classifyReceiptEntry(receiptEntry);
  if (receiptEntryType === "unsafe") {
    return { marketplaces, plugins, receipt: undefined, checkout: undefined };
  }
  if (receiptEntryType === "file") {
    try {
      receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    } catch {
      return { marketplaces, plugins, receipt: undefined, checkout: undefined };
    }
  }
  try {
    const common = await Promise.all([
      run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root, capture: true }),
      run("git", ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"], { cwd: root, capture: true }),
      run("git", ["rev-parse", "HEAD"], { cwd: root, capture: true }),
    ]);
    const [status, ignored, headResult] = common;
    const head = headResult.stdout.trim();
    if (receiptEntryType === "missing") {
      const [origin, tags] = await Promise.all([
        run("git", ["config", "--get", "remote.origin.url"], { cwd: root, capture: true }),
        run("git", ["tag", "--points-at", "HEAD", "--list", "v*"], { cwd: root, capture: true }),
      ]);
      receipt = inferReceiptFromCheckout({
        marketplaceSource: marketplace.marketplaceSource,
        origin: origin.stdout.trim(),
        tags: tags.stdout.split(/\r?\n/).filter(Boolean),
        head,
        plugins,
      });
      if (!receipt) return { marketplaces, plugins, receipt: undefined, checkout: undefined };
      return {
        marketplaces,
        plugins,
        receipt,
        checkout: { clean: checkoutIsClean(status.stdout, ignored.stdout), head, refRevision: head },
      };
    }
    const refRevision = await run("git", ["rev-list", "-n", "1", receipt.ref_name], { cwd: root, capture: true });
    return {
      marketplaces,
      plugins,
      receipt,
      checkout: {
        clean: checkoutIsClean(status.stdout, ignored.stdout),
        head,
        refRevision: refRevision.stdout.trim(),
      },
    };
  } catch {
    return { marketplaces, plugins, receipt: undefined, checkout: undefined };
  }
}

function operations() {
  return {
    beginRollback: () => { rollbackMode = true; },
    inspect: inspectState,
    removePlugin: (name) => run("codex", ["plugin", "remove", `${name}@${upgradeInventory.marketplaceName}`]),
    removeMarketplace: () => run("codex", ["plugin", "marketplace", "remove", upgradeInventory.marketplaceName]),
    addMarketplace: (ref, marketplaceSource = source) => run(
      "codex",
      ["plugin", "marketplace", "add", marketplaceSource, "--ref", ref],
    ),
    addPlugin: (name) => run("codex", ["plugin", "add", `${name}@${upgradeInventory.marketplaceName}`]),
  };
}

async function requireClassification(targetVersion) {
  const state = await inspectState();
  return { state, classification: classifyUpgradeState({ ...state, targetVersion }) };
}

async function remoteTagRevision(ref) {
  const remote = await run(
    "git",
    [
      "ls-remote", "--exit-code", "--tags", `https://github.com/${source}.git`,
      `refs/tags/${ref}`, `refs/tags/${ref}^{}`,
    ],
    { capture: true },
  );
  const entries = remote.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [revision, name] = line.split(/\s+/, 2);
    return { revision, name };
  });
  const peeled = entries.find((entry) => entry.name === `refs/tags/${ref}^{}`);
  const direct = entries.find((entry) => entry.name === `refs/tags/${ref}`);
  const revision = (peeled ?? direct)?.revision;
  if (!/^[0-9a-f]{40}$/.test(revision ?? "")) {
    throw new Error(`Release tag ${ref} did not resolve to an immutable revision.`);
  }
  return revision;
}

requireSupportedNode();
requirePython();
const releaseLock = acquireToolkitLock("upgrade");
try {
  const initial = await requireClassification(packageVersion);
  if (initial.classification.disposition === "refuse") throw new Error(initial.classification.reason);
  if (initial.classification.disposition === "noop") {
    console.log(`Roku Codex Toolkit ${packageVersion} is already installed.`);
    process.exitCode = 0;
  } else {
    const snapshotRevision = await remoteTagRevision(initial.classification.snapshot.ref);
    if (snapshotRevision !== initial.classification.snapshot.revision) {
      throw new Error("The installed release tag no longer resolves to its recorded revision; upgrade left it unchanged.");
    }
    const targetRevision = await remoteTagRevision(initial.classification.targetRef);
    await executeUpgradeTransaction({
      classification: initial.classification,
      operations: operations(),
      verifyTarget: async () => {
        const current = await requireClassification(packageVersion);
        if (current.classification.disposition !== "noop" || current.state.receipt?.revision !== targetRevision) {
          throw new Error("The upgraded marketplace failed final state verification.");
        }
      },
      verifySnapshot: async () => {
        const current = await requireClassification(initial.classification.snapshot.version);
        if (
          current.classification.disposition !== "noop" ||
          current.state.receipt?.revision !== initial.classification.snapshot.revision
        ) throw new Error("The previous marketplace state could not be verified.");
      },
    });
    console.log(`Roku Codex Toolkit upgraded to ${packageVersion}. Restart Codex and open a new task.`);
  }
} finally {
  releaseLock();
  if (process.connected) process.disconnect();
}
