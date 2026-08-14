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

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? temporary,
    encoding: "utf8",
    env: options.env ?? smokeEnvironment,
    input: options.input,
    timeout: options.timeout ?? 120_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

function npm(args, options = {}) {
  return run(process.execPath, [npmCli, ...args], options);
}

function npx(commandArgs) {
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

function fakeCodexCommand(args) {
  return run(process.execPath, [fakeCodex, ...args]);
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
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const responses = new Map();
  const waiters = new Map();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    const waiter = waiters.get(message.id);
    if (waiter) {
      waiters.delete(message.id);
      waiter(message);
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

  async function terminateProcessTree() {
    if (child.exitCode !== null) return;
    child.stdin.destroy();
    const waitForExit = (timeoutMs) => Promise.race([
      exit.then(() => true, () => true),
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
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
    if (!(await waitForExit(5_000))) {
      if (process.platform === "win32") {
        child.kill();
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      if (!(await waitForExit(5_000))) {
        throw new Error(`process tree ${child.pid} did not exit after forced termination`);
      }
    }
  }

  function responseFor(id) {
    if (responses.has(id)) return Promise.resolve(responses.get(id));
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
      waiters.set(id, (message) => {
        clearTimeout(timer);
        child.off("close", onExit);
        resolve(message);
      });
    });
  }

  const initialize = responseFor(1);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  const initializeResponse = await initialize;
  if (!initializeResponse.result) {
    await terminateProcessTree();
    throw new Error(`Packaged MCP initialize failed: ${JSON.stringify(initializeResponse.error)}`);
  }
  const toolsList = responseFor(2);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  const toolsResponse = await toolsList;
  child.stdin.end();
  const exitCode = await exit;
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
  const state = read();
  state.marketplace = { name: "roku-codex-toolkit", source: args[3], ref: args[5] ?? null };
  write(state);
} else if (args.join(" ") === "plugin marketplace remove roku-codex-toolkit") {
  const state = read();
  state.marketplace = null;
  write(state);
} else if (args[0] === "plugin" && args[1] === "add") {
  const state = read();
  const name = args[2].split("@")[0];
  if (!state.plugins.includes(name)) state.plugins.push(name);
  write(state);
} else if (args[0] === "plugin" && args[1] === "remove") {
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
};

try {
  const doctor = npx(["doctor", "--no-codex"]);
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

  const setup = npx(["setup", "--skip-config"]);
  if (/password|credential/i.test(`${setup.stdout}\n${setup.stderr}`)) {
    throw new Error("Non-interactive setup emitted a credential prompt.");
  }
  assertFreshInstallState();

  npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installPrefix, `${packageName}@${version}`]);
  const installedRoot = path.join(installPrefix, "node_modules", packageName);
  const metadata = JSON.parse(fs.readFileSync(path.join(installedRoot, "package.json"), "utf8"));
  for (const lifecycle of ["preinstall", "install", "postinstall", "prepare"]) {
    if (metadata.scripts?.[lifecycle]) throw new Error(`Published package defines an unexpected ${lifecycle} script.`);
  }
  if (metadata.version !== version) throw new Error(`Installed ${metadata.version}; expected ${version}.`);
  run("git", [
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
    fakeCodexCommand(["plugin", "remove", `${plugin}@${packageName}`]);
  }
  fakeCodexCommand(["plugin", "marketplace", "remove", packageName]);
  const removed = readState();
  if (removed.marketplace || removed.plugins.length !== 0) {
    throw new Error("Documented uninstall commands left toolkit state behind.");
  }
  npx(["setup", "--skip-config"]);
  assertFreshInstallState();

  const pythonRuntime = findPython();
  if (!pythonRuntime) throw new Error("Python 3.9 or newer disappeared after doctor completed.");
  const python = run(pythonRuntime.command, [...pythonRuntime.args, "--version"]);
  const git = run("git", ["--version"]);
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
