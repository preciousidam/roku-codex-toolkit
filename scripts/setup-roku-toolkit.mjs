#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marketplaceName = "roku-codex-toolkit";
const pluginNames = ["roku-device-toolkit", "roku-engineering"];
const configScript = path.join(repoRoot, "plugins/roku-device-toolkit/scripts/roku_config.py");
const skipConfig = process.argv.includes("--skip-config");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) {
    throw new Error(`${command} is required but unavailable: ${result.error.message}`);
  }
  return result;
}

function requireSuccess(result, description) {
  if (result.status !== 0) {
    throw new Error(`${description} failed with exit code ${result.status}.`);
  }
}

const marketplaces = run("codex", ["plugin", "marketplace", "list"], { capture: true });
requireSuccess(marketplaces, "Reading Codex marketplaces");
const marketplaceOutput = `${marketplaces.stdout}\n${marketplaces.stderr}`;
const marketplaceLine = marketplaceOutput
  .split(/\r?\n/)
  .map((line) => line.trim())
  .find((line) => line.startsWith(`${marketplaceName} `));
const registeredRoot = marketplaceLine?.slice(marketplaceName.length).trim();
if (registeredRoot && path.resolve(registeredRoot) !== repoRoot) {
  requireSuccess(
    run("codex", ["plugin", "marketplace", "remove", marketplaceName]),
    "Removing a stale Roku Codex Toolkit marketplace",
  );
}
if (!registeredRoot || path.resolve(registeredRoot) !== repoRoot) {
  requireSuccess(
    run("codex", ["plugin", "marketplace", "add", repoRoot]),
    "Adding the Roku Codex Toolkit marketplace",
  );
}

for (const pluginName of pluginNames) {
  requireSuccess(
    run("codex", ["plugin", "add", `${pluginName}@${marketplaceName}`]),
    `Installing ${pluginName}`,
  );
}

if (!skipConfig) {
  const python = [
    { command: "python3", args: [] },
    { command: "python", args: [] },
    { command: "py", args: ["-3"] },
  ].find((candidate) => {
    const result = spawnSync(
      candidate.command,
      [...candidate.args, "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)"],
      { encoding: "utf8" },
    );
    return !result.error && result.status === 0;
  });
  if (!python) {
    throw new Error("Python 3.9 or newer is required to configure and operate the Roku toolkit.");
  }
  requireSuccess(
    run(python.command, [...python.args, configScript]),
    "Configuring the Roku development device",
  );
}

console.log("\nRoku Codex Toolkit installed. Restart Codex and open a new task.");
