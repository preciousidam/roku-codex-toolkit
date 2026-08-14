#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

import { findPython } from "./runtime-support.mjs";

const packageName = "roku-codex-toolkit";
const expectedToolNames = [
  "active_app",
  "collect_logs",
  "configuration_status",
  "configure_target",
  "device_info",
  "enter_text",
  "launch",
  "list_apps",
  "player_state",
  "press",
  "run_flow",
  "sideload",
  "take_screenshot",
];
const arguments_ = process.argv.slice(2);
const versionIndex = arguments_.indexOf("--version");
if (versionIndex === -1 || !arguments_[versionIndex + 1] || arguments_.length !== 2) {
  console.error("Usage: node scripts/smoke-published-package.mjs --version <published-version>");
  process.exit(2);
}
const version = arguments_[versionIndex + 1];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error(`Invalid package version: ${version}`);
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "roku-toolkit-published-smoke-"));
const npmCli = [
  process.env.npm_execpath,
  path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
].find((candidate) => candidate && fs.existsSync(candidate));
if (!npmCli) throw new Error("The npm CLI could not be located beside the active Node.js runtime.");
const fakeBin = path.join(temporary, "bin");
const fakeCodex = path.join(fakeBin, "fake-codex.mjs");
const stateFile = path.join(temporary, "codex-state.json");
const eventFile = path.join(temporary, "codex-events.jsonl");
const isolatedHome = path.join(temporary, "home");
const isolatedConfig = path.join(temporary, "config");
const installPrefix = path.join(temporary, "install");
const taggedCheckout = path.join(temporary, "tagged-checkout");
const delimiter = process.platform === "win32" ? ";" : ":";
const closedChildren = new WeakSet();

function waitForChildExit(exit, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    exit.then(() => { clearTimeout(timer); resolve(true); });
  });
}

async function terminateChildTree(child, exit) {
  if (closedChildren.has(child)) return;
  child.stdin?.destroy();
  if (process.platform === "win32") {
    const killed = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (killed.error || killed.status !== 0) child.kill();
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  if (!(await waitForChildExit(exit, 5_000))) {
    if (process.platform === "win32") child.kill();
    else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
    if (!(await waitForChildExit(exit, 5_000))) {
      throw new Error(`process tree ${child.pid} did not exit after forced termination`);
    }
  }
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? temporary,
    detached: process.platform !== "win32",
    env: options.env ?? smokeEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.once("close", () => closedChildren.add(child));
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.on("error", () => {});
  child.stdin.end(options.input);
  const exit = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), options.timeout ?? 120_000);
  });
  const result = await Promise.race([exit, timeout]);
  clearTimeout(timer);
  if (result.timedOut) {
    await terminateChildTree(child, exit);
    throw new Error(`${command} ${args.join(" ")} timed out.\n${stdout}\n${stderr}`);
  }
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.error?.message ?? ""}\n${stdout}\n${stderr}`,
    );
  }
  return { ...result, stdout, stderr };
}

async function npm(args, options = {}) {
  return run(process.execPath, [npmCli, ...args], options);
}

async function waitForPublishedPackage() {
  let lastError;
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      const result = await npm(["view", `${packageName}@${version}`, "version", "--json"], { timeout: 30_000 });
      if (JSON.parse(result.stdout) === version) return;
      lastError = new Error(`npm returned an unexpected version: ${result.stdout.trim()}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < 12) await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  throw new Error(`Package ${packageName}@${version} did not become available: ${lastError?.message}`);
}

async function npx(commandArgs) {
  return npm([
    "exec",
    "--yes",
    `--package=${packageName}@${version}`,
    "--",
    "roku-codex-toolkit",
    ...commandArgs,
  ]);
}

function readState() {
  return JSON.parse(fs.readFileSync(stateFile, "utf8"));
}

async function fakeCodexCommand(args, options = {}) {
  return run(process.execPath, [fakeCodex, ...args], {
    env: {
      ...smokeEnvironment,
      ROKU_SMOKE_ALLOW_REMOVALS: options.allowRemovals ? "1" : "0",
    },
  });
}

function assertFreshInstallState() {
  const state = readState();
  if (state.marketplace?.name !== packageName || state.marketplace?.source !== "preciousidam/roku-codex-toolkit") {
    throw new Error("Setup did not register the expected public marketplace source.");
  }
  if (state.marketplace.ref !== `v${version}`) {
    throw new Error(`Setup registered ${state.marketplace.ref ?? "no ref"}; expected v${version}.`);
  }
  const plugins = [...state.plugins].sort();
  if (plugins.join(",") !== "roku-device-toolkit,roku-engineering") {
    throw new Error(`Setup installed an unexpected plugin set: ${plugins.join(", ") || "none"}.`);
  }
}

function assertDeviceConfigAbsent() {
  for (const config of [
    path.join(isolatedHome, ".config", "roku-device-toolkit", "config.json"),
    path.join(isolatedConfig, "roku-device-toolkit", "config.json"),
  ]) {
    if (fs.existsSync(config)) throw new Error(`Setup --skip-config unexpectedly wrote ${config}.`);
  }
}

function assertMarketplaceManifest(root, contents) {
  const manifest = JSON.parse(contents);
  const expected = ["roku-device-toolkit", "roku-engineering"];
  const names = Array.isArray(manifest.plugins) ? manifest.plugins.map((plugin) => plugin?.name).sort() : [];
  if (manifest.name !== packageName || names.join(",") !== expected.join(",")) {
    throw new Error(`v${version} contains an unexpected marketplace plugin inventory.`);
  }
  for (const name of expected) {
    const entry = manifest.plugins.find((plugin) => plugin.name === name);
    if (entry.source?.source !== "local" || entry.source?.path !== `./plugins/${name}`) {
      throw new Error(`v${version} marketplace contains an invalid source for ${name}.`);
    }
    const pluginManifest = JSON.parse(fs.readFileSync(
      path.join(root, "plugins", name, ".codex-plugin", "plugin.json"),
      "utf8",
    ));
    if (pluginManifest.name !== name) {
      throw new Error(`v${version} marketplace source for ${name} resolves to the wrong plugin manifest.`);
    }
  }
}

function relativeFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(path.relative(root, absolute));
      else throw new Error(`Unexpected non-file entry in release content: ${absolute}`);
    }
  }
  visit(root);
  return files.sort();
}

function assertIdenticalTree(publishedRoot, tagRoot, relative) {
  const published = path.join(publishedRoot, relative);
  const tagged = path.join(tagRoot, relative);
  const publishedFiles = relativeFiles(published);
  const taggedFiles = relativeFiles(tagged);
  if (publishedFiles.join("\n") !== taggedFiles.join("\n")) {
    throw new Error(`Published npm and v${version} ${relative} file inventories differ.`);
  }
  for (const file of publishedFiles) {
    if (!fs.readFileSync(path.join(published, file)).equals(fs.readFileSync(path.join(tagged, file)))) {
      throw new Error(`Published npm and v${version} differ at ${path.join(relative, file)}.`);
    }
  }
}

async function listPackagedTools(launcher) {
  const child = spawn(process.execPath, [launcher], {
    cwd: temporary,
    detached: process.platform !== "win32",
    env: smokeEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.once("close", () => closedChildren.add(child));
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const responses = new Map();
  const waiters = new Map();
  let protocolFailure;
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      failProtocol(new Error(`Packaged MCP launcher emitted malformed JSON: ${JSON.stringify(line)} (${error.message})`));
      return;
    }
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      failProtocol(new Error(`Packaged MCP launcher emitted a non-object JSON-RPC message: ${JSON.stringify(message)}`));
      return;
    }
    const waiter = waiters.get(message.id);
    if (waiter) {
      waiters.delete(message.id);
      clearTimeout(waiter.timer);
      child.off("close", waiter.onExit);
      waiter.resolve(message);
    } else {
      responses.set(message.id, message);
    }
  });
  const exit = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      reject(error);
    });
    child.once("close", resolve);
  });
  child.stdin.on("error", (error) => {
    failProtocol(new Error(`Packaged MCP launcher stdin failed: ${error.message}`));
  });

  async function terminateProcessTree() {
    await terminateChildTree(child, exit);
  }

  function failProtocol(error) {
    if (protocolFailure) return;
    protocolFailure = (async () => {
      try {
        await terminateProcessTree();
        return error;
      } catch (terminationError) {
        return new Error(`${error.message}; termination failed: ${terminationError.message}`);
      }
    })();
    void protocolFailure.then((failure) => {
      for (const [id, waiter] of waiters) {
        clearTimeout(waiter.timer);
        child.off("close", waiter.onExit);
        waiter.reject(failure);
        waiters.delete(id);
      }
    });
  }

  function responseFor(id) {
    if (responses.has(id)) return Promise.resolve(responses.get(id));
    if (protocolFailure) return protocolFailure.then((error) => { throw error; });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.off("close", onExit);
        waiters.delete(id);
        void terminateProcessTree().then(
          () => reject(new Error(`Packaged MCP launcher timed out waiting for response ${id}.`)),
          (error) => reject(new Error(
            `Packaged MCP launcher timed out waiting for response ${id}; termination failed: ${error.message}`,
          )),
        );
      }, 30_000);
      const onExit = (code) => {
        clearTimeout(timer);
        waiters.delete(id);
        reject(new Error(`Packaged MCP launcher exited with ${code} before response ${id}:\n${stderr}`));
      };
      child.once("close", onExit);
      waiters.set(id, { resolve, reject, timer, onExit });
    });
  }

  async function assertResponseEnvelope(message, id) {
    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");
    if (message.jsonrpc !== "2.0" || message.id !== id || hasResult === hasError) {
      await terminateProcessTree();
      throw new Error(`Packaged MCP returned an invalid JSON-RPC response ${id}: ${JSON.stringify(message)}`);
    }
    if (hasError) {
      await terminateProcessTree();
      throw new Error(`Packaged MCP returned an error for request ${id}: ${JSON.stringify(message.error)}`);
    }
  }

  const initialize = responseFor(1);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "roku-codex-toolkit-smoke", version: "1.0.0" },
    },
  })}\n`);
  const initializeResponse = await initialize;
  await assertResponseEnvelope(initializeResponse, 1);
  const initializeResult = initializeResponse.result;
  if (
    initializeResult?.protocolVersion !== "2025-06-18" ||
    initializeResult.capabilities === null ||
    typeof initializeResult.capabilities !== "object" ||
    Array.isArray(initializeResult.capabilities) ||
    typeof initializeResult.serverInfo?.name !== "string" ||
    !initializeResult.serverInfo.name ||
    typeof initializeResult.serverInfo?.version !== "string" ||
    !initializeResult.serverInfo.version
  ) {
    await terminateProcessTree();
    throw new Error(`Packaged MCP initialize returned an invalid result: ${JSON.stringify(initializeResponse)}`);
  }
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  })}\n`);
  const toolsList = responseFor(2);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  const toolsResponse = await toolsList;
  await assertResponseEnvelope(toolsResponse, 2);
  child.stdin.end();
  const exitCode = await Promise.race([
    exit,
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(Symbol.for("shutdown-timeout")), 10_000);
      timer.unref?.();
    }),
  ]);
  if (exitCode === Symbol.for("shutdown-timeout")) {
    await terminateProcessTree();
    throw new Error("Packaged MCP launcher did not exit after stdin closed.");
  }
  if (exitCode !== 0) throw new Error(`Packaged MCP launcher failed:\n${stderr}`);
  const tools = toolsResponse.result?.tools;
  const toolNames = Array.isArray(tools) ? tools.map((tool) => tool?.name).sort() : [];
  if (
    !Array.isArray(tools) ||
    new Set(toolNames).size !== expectedToolNames.length ||
    toolNames.join(",") !== expectedToolNames.join(",")
  ) {
    throw new Error(
      `Packaged MCP server exposed an unexpected tool inventory: ${toolNames.join(", ") || "none"}. ` +
      `Response: ${JSON.stringify(toolsResponse)}`,
    );
  }
  return tools.length;
}

fs.mkdirSync(fakeBin, { recursive: true });
fs.mkdirSync(isolatedHome, { recursive: true });
fs.mkdirSync(isolatedConfig, { recursive: true });
fs.writeFileSync(stateFile, JSON.stringify({ marketplace: null, plugins: [] }));
fs.writeFileSync(fakeCodex, `import fs from "node:fs";
const stateFile = process.env.ROKU_SMOKE_STATE;
const eventFile = process.env.ROKU_SMOKE_EVENTS;
const args = process.argv.slice(2);
const read = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const write = (state) => fs.writeFileSync(stateFile, JSON.stringify(state));
fs.appendFileSync(eventFile, JSON.stringify(args) + "\\n");
if (args[0] === "--version" || args.join(" ") === "plugin marketplace --help") {
  console.log("codex-smoke");
} else if (args.join(" ") === "plugin marketplace list --json") {
  const state = read();
  console.log(JSON.stringify({ marketplaces: state.marketplace ? [{ name: state.marketplace.name, marketplaceSource: { sourceType: "git", source: state.marketplace.source, ref: state.marketplace.ref } }] : [] }));
} else if (args.join(" ") === "plugin list --json") {
  const state = read();
  console.log(JSON.stringify({ installed: state.plugins.map((name) => ({ name, marketplaceName: "roku-codex-toolkit", installed: true, enabled: true })) }));
} else if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
  const expected = ["plugin", "marketplace", "add", "preciousidam/roku-codex-toolkit", "--ref", "v${version}"];
  if (JSON.stringify(args) !== JSON.stringify(expected)) process.exit(2);
  const state = read();
  state.marketplace = { name: "roku-codex-toolkit", source: args[3], ref: args[5] ?? null };
  write(state);
} else if (args.join(" ") === "plugin marketplace remove roku-codex-toolkit") {
  if (process.env.ROKU_SMOKE_ALLOW_REMOVALS !== "1") process.exit(2);
  const state = read();
  state.marketplace = null;
  write(state);
} else if (args[0] === "plugin" && args[1] === "add") {
  const expected = [
    ["plugin", "add", "roku-device-toolkit@roku-codex-toolkit"],
    ["plugin", "add", "roku-engineering@roku-codex-toolkit"],
  ];
  if (!expected.some((command) => JSON.stringify(args) === JSON.stringify(command))) process.exit(2);
  const state = read();
  const name = args[2].split("@")[0];
  if (!state.plugins.includes(name)) state.plugins.push(name);
  write(state);
} else if (args[0] === "plugin" && args[1] === "remove") {
  if (process.env.ROKU_SMOKE_ALLOW_REMOVALS !== "1") process.exit(2);
  const state = read();
  const name = args[2].split("@")[0];
  state.plugins = state.plugins.filter((plugin) => plugin !== name);
  write(state);
} else {
  console.error("Unsupported fake Codex command: " + args.join(" "));
  process.exit(2);
}
`);
if (process.platform === "win32") {
  fs.writeFileSync(path.join(fakeBin, "codex.cmd"), `@echo off\r\n"${process.execPath}" "${fakeCodex}" %*\r\n`);
} else {
  fs.writeFileSync(path.join(fakeBin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${fakeCodex}" "$@"\n`, { mode: 0o755 });
}

const smokeEnvironment = {
  ...process.env,
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  XDG_CONFIG_HOME: isolatedConfig,
  PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
  npm_config_cache: path.join(temporary, "npm-cache"),
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
  npm_config_ignore_scripts: "true",
  ROKU_SMOKE_STATE: stateFile,
  ROKU_SMOKE_EVENTS: eventFile,
  ROKU_SMOKE_ALLOW_REMOVALS: "0",
};

try {
  await waitForPublishedPackage();
  const doctor = await npx(["doctor", "--no-codex"]);
  const doctorLines = doctor.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const expectedDoctorChecks = ["Git", "Node.js >=18", "Python >=3.9"];
  const doctorChecks = doctorLines.map((line) => line.match(/^ok - (.+?) \(/)?.[1]).sort();
  if (
    doctorLines.length !== expectedDoctorChecks.length ||
    doctorChecks.some((name) => !name) ||
    doctorChecks.join(",") !== expectedDoctorChecks.join(",")
  ) {
    throw new Error(`Published doctor reported an unexpected result:\n${doctor.stdout}`);
  }

  const setup = await npx(["setup", "--skip-config"]);
  if (/password|credential/i.test(`${setup.stdout}\n${setup.stderr}`)) {
    throw new Error("Non-interactive setup emitted a credential prompt.");
  }
  assertFreshInstallState();
  assertDeviceConfigAbsent();

  await npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installPrefix, `${packageName}@${version}`]);
  const installedRoot = path.join(installPrefix, "node_modules", packageName);
  const metadata = JSON.parse(fs.readFileSync(path.join(installedRoot, "package.json"), "utf8"));
  for (const lifecycle of ["preinstall", "install", "postinstall", "prepare"]) {
    if (metadata.scripts?.[lifecycle]) throw new Error(`Published package defines an unexpected ${lifecycle} script.`);
  }
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"]) {
    const value = metadata[field];
    const empty = value === undefined ||
      (Array.isArray(value) ? value.length === 0 : value && typeof value === "object" && Object.keys(value).length === 0);
    if (!empty) throw new Error(`Published package defines unexpected ${field}.`);
  }
  if (metadata.version !== version) throw new Error(`Installed ${metadata.version}; expected ${version}.`);
  await run("git", [
    "-c", "core.autocrlf=false",
    "clone",
    "--depth", "1",
    "--single-branch",
    "--branch", `v${version}`,
    "https://github.com/preciousidam/roku-codex-toolkit.git",
    taggedCheckout,
  ]);
  assertIdenticalTree(installedRoot, taggedCheckout, "plugins");
  const publishedMarketplace = fs.readFileSync(path.join(installedRoot, ".agents", "plugins", "marketplace.json"));
  const taggedMarketplace = fs.readFileSync(path.join(taggedCheckout, ".agents", "plugins", "marketplace.json"));
  if (!publishedMarketplace.equals(taggedMarketplace)) {
    throw new Error(`Published npm and v${version} marketplace manifests differ.`);
  }
  assertMarketplaceManifest(taggedCheckout, taggedMarketplace.toString("utf8"));
  const toolCount = await listPackagedTools(path.join(
    installedRoot,
    "plugins",
    "roku-device-toolkit",
    "scripts",
    "launch-mcp.mjs",
  ));
  const taggedToolCount = await listPackagedTools(path.join(
    taggedCheckout,
    "plugins",
    "roku-device-toolkit",
    "scripts",
    "launch-mcp.mjs",
  ));

  for (const plugin of ["roku-device-toolkit", "roku-engineering"]) {
    await fakeCodexCommand(["plugin", "remove", `${plugin}@${packageName}`], { allowRemovals: true });
  }
  await fakeCodexCommand(["plugin", "marketplace", "remove", packageName], { allowRemovals: true });
  const removed = readState();
  if (removed.marketplace || removed.plugins.length !== 0) {
    throw new Error("Documented uninstall commands left toolkit state behind.");
  }
  await npx(["setup", "--skip-config"]);
  assertFreshInstallState();
  assertDeviceConfigAbsent();

  const pythonRuntime = findPython();
  if (!pythonRuntime) throw new Error("Python 3.9 or newer disappeared after doctor completed.");
  const python = await run(pythonRuntime.command, [...pythonRuntime.args, "--version"]);
  const git = await run("git", ["--version"]);
  console.log(JSON.stringify({
    schemaVersion: 1,
    package: `${packageName}@${version}`,
    host: { os: process.platform, release: os.release(), arch: process.arch },
    runtime: {
      node: process.version,
      python: `${python.stdout}${python.stderr}`.trim(),
      git: git.stdout.trim(),
      codex: "isolated contract double; manual UI/account confirmation pending",
    },
    scenarios: {
      doctor: "pass",
      setupWithoutDeviceConfig: "pass",
      versionPinnedMarketplace: "pass",
      twoPluginsInstalled: "pass",
      packagedMcpTools: toolCount,
      taggedMcpTools: taggedToolCount,
      lifecycleScriptsAbsent: "pass",
      credentialPromptAbsent: "pass",
      uninstallAndReinstall: "pass",
      physicalRokuEvidence: "not in scope",
    },
  }, null, 2));
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
