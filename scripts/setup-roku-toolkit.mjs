#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { requirePython } from "./runtime-support.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marketplaceName = "roku-codex-toolkit";
const pluginNames = ["roku-device-toolkit", "roku-engineering"];
const configScript = path.join(repoRoot, "plugins/roku-device-toolkit/scripts/roku_config.py");
const skipConfig = process.argv.includes("--skip-config");
if (process.argv.includes("--help")) {
  console.log("Usage: roku-codex-toolkit setup [--skip-config]");
  process.exit(0);
}

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

// Finish runtime preflight before changing Codex marketplace or plugin state.
const python = requirePython();
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
  requireSuccess(
    run(python.command, [...python.args, configScript]),
    "Configuring the Roku development device",
  );
}

console.log("\nRoku Codex Toolkit installed. Restart Codex and open a new task.");
