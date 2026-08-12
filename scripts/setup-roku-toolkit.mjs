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
let previouslyInstalledPlugins = [];
if (existingMarketplace) {
  previouslyInstalledPlugins = inspectInstalledPlugins();
  const disabled = previouslyInstalledPlugins.filter((entry) => !entry.enabled).map((entry) => entry.name);
  if (disabled.length > 0) {
    throw new Error(
      `Setup cannot safely replace a marketplace containing disabled plugins: ${disabled.join(", ")}. ` +
      "Enable or remove them explicitly before retrying so their state is not changed by rollback.",
    );
  }
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

function restorePreviousMarketplace() {
  const previous = existingMarketplace?.marketplaceSource;
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
  if (!previous?.source) return errors;
  const restoreArgs = ["plugin", "marketplace", "add", previous.source];
  if (previous.ref) restoreArgs.push("--ref", previous.ref);
  attempt(
    "Restoring the previous Roku Codex Toolkit marketplace",
    () => run("codex", restoreArgs),
  );
  for (const plugin of previouslyInstalledPlugins) {
    attempt(
      `Restoring ${plugin.name}`,
      () => run("codex", ["plugin", "add", `${plugin.name}@${marketplaceName}`]),
    );
  }
  return errors;
}

function throwWithRollbackErrors(error, rollbackErrors) {
  if (rollbackErrors.length === 0) throw error;
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`${message}\nRollback errors:\n- ${rollbackErrors.join("\n- ")}`, { cause: error });
}

if (existingMarketplace) {
  try {
    requireSuccess(
      run("codex", ["plugin", "marketplace", "remove", marketplaceName]),
      "Removing the existing Roku Codex Toolkit marketplace",
    );
  } catch (error) {
    throwWithRollbackErrors(error, restorePreviousMarketplace());
  }
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
  throwWithRollbackErrors(error, restorePreviousMarketplace());
}

if (!existingMarketplace) {
  const orphanedPlugins = inspectInstalledPlugins();
  const disabled = orphanedPlugins.filter((entry) => !entry.enabled).map((entry) => entry.name);
  if (disabled.length > 0) {
    const error = new Error(
      `Setup cannot safely reinstall disabled orphaned plugins: ${disabled.join(", ")}. ` +
      "Enable or remove them explicitly before retrying so setup does not activate them.",
    );
    throwWithRollbackErrors(error, restorePreviousMarketplace());
  }
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
  throwWithRollbackErrors(error, restorePreviousMarketplace());
}

if (!skipConfig) {
  requireSuccess(
    run(python.command, [...python.args, configScript], { interactive: true }),
    "Configuring the Roku development device",
  );
}

console.log("\nRoku Codex Toolkit installed. Restart Codex and open a new task.");
