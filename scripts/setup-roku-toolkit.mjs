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
const setupArgs = process.argv.slice(2);
if (setupArgs.includes("--help") || setupArgs.includes("-h")) {
  console.log("Usage: roku-codex-toolkit setup [--skip-config]");
  process.exit(0);
}
const unknownArgs = setupArgs.filter((argument) => argument !== "--skip-config");
if (unknownArgs.length > 0) {
  throw new Error(`Unknown setup option${unknownArgs.length === 1 ? "" : "s"}: ${unknownArgs.join(", ")}`);
}
const skipConfig = setupArgs.includes("--skip-config");

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
requireSuccess(marketplaces, "Inspecting Codex marketplaces; repair stale marketplace entries before setup");
const marketplaceEntries = JSON.parse(marketplaces.stdout).marketplaces ?? [];
const existingMarketplace = marketplaceEntries.find((entry) => entry.name === marketplaceName);
if (existingMarketplace) {
  throw new Error(
    "The roku-codex-toolkit marketplace is already registered; setup left it unchanged. " +
    "Automatic replacement is intentionally unsupported because Codex does not expose enough state to restore " +
    "a version-pinned marketplace safely. Follow the explicit upgrade steps in README.md.",
  );
}
const desiredSource = sourceCheckout ? repoRoot : marketplaceSource;
const desiredArgs = sourceCheckout
  ? ["plugin", "marketplace", "add", desiredSource]
  : ["plugin", "marketplace", "add", desiredSource, "--ref", `v${packageVersion}`];
const installedThisAttempt = [];

function inspectInstalledPlugins() {
  const plugins = run("codex", ["plugin", "list", "--json"], { capture: true });
  requireSuccess(plugins, "Inspecting installed Roku Codex Toolkit plugins");
  const installed = JSON.parse(plugins.stdout).installed ?? [];
  return installed.filter((entry) => (
    pluginNames.includes(entry.name) && entry.marketplaceName === marketplaceName && entry.installed === true
  )).map((entry) => ({ name: entry.name, enabled: entry.enabled !== false }));
}

function cleanUpFreshInstall() {
  const errors = [];
  const attempt = (description, action) => {
    try {
      requireSuccess(action(), description);
    } catch (error) {
      errors.push(`${description}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  for (const pluginName of [...installedThisAttempt].reverse()) {
    attempt(
      `Removing partially installed ${pluginName}`,
      () => run("codex", ["plugin", "remove", `${pluginName}@${marketplaceName}`]),
    );
  }
  attempt(
    "Removing the failed Roku Codex Toolkit marketplace",
    () => run("codex", ["plugin", "marketplace", "remove", marketplaceName]),
  );
  return errors;
}

function throwWithRollbackErrors(error, rollbackErrors) {
  if (rollbackErrors.length === 0) throw error;
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`${message}\nRollback errors:\n- ${rollbackErrors.join("\n- ")}`, { cause: error });
}

let addMarketplace;
try {
  addMarketplace = run("codex", desiredArgs);
} catch (error) {
  addMarketplace = { status: null, error };
}
if (addMarketplace.status !== 0) {
  let error = addMarketplace.error;
  if (!error) {
    try {
      requireSuccess(addMarketplace, "Adding the Roku Codex Toolkit marketplace");
    } catch (failure) {
      error = failure;
    }
  }
  throwWithRollbackErrors(error, cleanUpFreshInstall());
}

try {
  const orphanedPlugins = inspectInstalledPlugins();
  if (orphanedPlugins.length > 0) {
    throw new Error(
      `Setup found orphaned Roku Codex Toolkit plugin state: ${orphanedPlugins.map((entry) => entry.name).join(", ")}. ` +
      "The temporary marketplace was removed without changing those plugins. Remove or repair the orphaned " +
      "entries explicitly before retrying.",
    );
  }
} catch (error) {
  throwWithRollbackErrors(error, cleanUpFreshInstall());
}

try {
  for (const pluginName of pluginNames) {
    // A timed-out or failed Codex command may have changed persistent plugin
    // state before reporting failure, so rollback must include the in-flight
    // plugin as well as commands that returned successfully.
    installedThisAttempt.push(pluginName);
    requireSuccess(
      run("codex", ["plugin", "add", `${pluginName}@${marketplaceName}`]),
      `Installing ${pluginName}`,
    );
  }
} catch (error) {
  throwWithRollbackErrors(error, cleanUpFreshInstall());
}

if (!skipConfig) {
  requireSuccess(
    run(python.command, [...python.args, configScript], { interactive: true }),
    "Configuring the Roku development device",
  );
}

console.log("\nRoku Codex Toolkit installed. Restart Codex and open a new task.");
