#!/usr/bin/env node

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { commandStatus, requirePython, requireSupportedNode } from "./runtime-support.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marketplaceName = "roku-codex-toolkit";
const marketplaceSource = "preciousidam/roku-codex-toolkit";
const packageVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
const sourceCheckout = fs.existsSync(path.join(repoRoot, ".git"));
const pluginNames = ["roku-device-toolkit", "roku-engineering"];
const configScript = path.join(repoRoot, "plugins/roku-device-toolkit/scripts/roku_config.py");
const skipConfig = process.argv.includes("--skip-config");
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: roku-codex-toolkit setup [--skip-config]");
  process.exit(0);
}

function run(command, args, options = {}) {
  const result = commandStatus(command, args, {
    cwd: repoRoot,
    stdio: options.capture ? "pipe" : "inherit",
    ...(options.interactive ? {} : { timeout: 30_000 }),
    windowsShim: command === "codex" || command === "git",
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
requireSupportedNode();
const python = requirePython();
if (!sourceCheckout) {
  const remote = run(
    "git",
    ["ls-remote", "--exit-code", "--tags", `https://github.com/${marketplaceSource}.git`, `refs/tags/v${packageVersion}`],
    { capture: true },
  );
  requireSuccess(remote, `Finding marketplace tag v${packageVersion}`);
}
const marketplaces = run("codex", ["plugin", "marketplace", "list", "--json"], { capture: true });
let marketplaceEntries = [];
if (marketplaces.status === 0) {
  marketplaceEntries = JSON.parse(marketplaces.stdout).marketplaces ?? [];
} else {
  // A stale local marketplace can make listing fail; removal by stable name still repairs it.
  run("codex", ["plugin", "marketplace", "remove", marketplaceName]);
}
const existingMarketplace = marketplaceEntries.find((entry) => entry.name === marketplaceName);
let previouslyInstalledPlugins = [];
if (existingMarketplace) {
  const plugins = run("codex", ["plugin", "list", "--json"], { capture: true });
  requireSuccess(plugins, "Inspecting installed Roku Codex Toolkit plugins");
  const installed = JSON.parse(plugins.stdout).installed ?? [];
  previouslyInstalledPlugins = pluginNames.filter((pluginName) => installed.some(
    (entry) => entry.name === pluginName && entry.marketplaceName === marketplaceName && entry.installed === true,
  ));
}
const desiredSource = sourceCheckout ? repoRoot : marketplaceSource;
const desiredArgs = sourceCheckout
  ? ["plugin", "marketplace", "add", desiredSource]
  : ["plugin", "marketplace", "add", desiredSource, "--ref", `v${packageVersion}`];

function restorePreviousMarketplace() {
  const previous = existingMarketplace?.marketplaceSource;
  run("codex", ["plugin", "marketplace", "remove", marketplaceName]);
  if (!previous?.source) return;
  const restoreArgs = ["plugin", "marketplace", "add", previous.source];
  if (previous.ref) restoreArgs.push("--ref", previous.ref);
  requireSuccess(run("codex", restoreArgs), "Restoring the previous Roku Codex Toolkit marketplace");
  for (const pluginName of previouslyInstalledPlugins) {
    requireSuccess(
      run("codex", ["plugin", "add", `${pluginName}@${marketplaceName}`]),
      `Restoring ${pluginName}`,
    );
  }
}

if (existingMarketplace) {
  requireSuccess(
    run("codex", ["plugin", "marketplace", "remove", marketplaceName]),
    "Removing the existing Roku Codex Toolkit marketplace",
  );
}
let addMarketplace;
try {
  addMarketplace = run("codex", desiredArgs);
} catch (error) {
  addMarketplace = { status: null, error };
}
if (addMarketplace.status !== 0) {
  restorePreviousMarketplace();
  if (addMarketplace.error) throw addMarketplace.error;
  requireSuccess(addMarketplace, "Adding the Roku Codex Toolkit marketplace");
}

try {
  for (const pluginName of pluginNames) {
    requireSuccess(
      run("codex", ["plugin", "add", `${pluginName}@${marketplaceName}`]),
      `Installing ${pluginName}`,
    );
  }
} catch (error) {
  restorePreviousMarketplace();
  throw error;
}

if (!skipConfig) {
  requireSuccess(
    run(python.command, [...python.args, configScript], { interactive: true }),
    "Configuring the Roku development device",
  );
}

console.log("\nRoku Codex Toolkit installed. Restart Codex and open a new task.");
