const marketplaceName = "roku-codex-toolkit";
const pluginNames = ["roku-device-toolkit", "roku-engineering"];
const canonicalSources = new Set([
  "preciousidam/roku-codex-toolkit",
  "https://github.com/preciousidam/roku-codex-toolkit",
  "https://github.com/preciousidam/roku-codex-toolkit.git",
]);

export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value ?? "");
  return match ? match.slice(1).map(Number) : undefined;
}

export function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function refuse(reason) {
  return { disposition: "refuse", reason };
}

export function checkoutIsClean(statusOutput, ignoredOutput) {
  const statusEntries = statusOutput.split("\0").filter(Boolean);
  if (statusEntries.some((entry) => entry !== "?? .codex-marketplace-install.json")) return false;
  const disposableCache = /^plugins\/(?:roku-device-toolkit|roku-engineering)\/(?:[^/\r\n]+\/)*__pycache__\/[^/\r\n]+\.py[co]$/;
  return ignoredOutput.split("\0").filter(Boolean).every((entry) => disposableCache.test(entry));
}

export function inferReceiptFromCheckout({ marketplaceSource, origin, tags, head, plugins }) {
  if (
    marketplaceSource?.sourceType !== "git" ||
    !canonicalSources.has(marketplaceSource.source) ||
    origin !== marketplaceSource.source ||
    !/^[0-9a-f]{40}$/.test(head ?? "") ||
    !Array.isArray(tags) ||
    !Array.isArray(plugins)
  ) return undefined;
  const stableTags = [...new Set(tags.filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag)))];
  if (stableTags.length !== 1) return undefined;
  const version = stableTags[0].slice(1);
  const toolkitPlugins = plugins.filter((entry) => entry?.marketplaceName === marketplaceName);
  if (
    toolkitPlugins.length !== 2 ||
    new Set(toolkitPlugins.map((entry) => entry.name)).size !== 2 ||
    toolkitPlugins.some((entry) => !pluginNames.includes(entry.name) || entry.version !== version)
  ) return undefined;
  return {
    source_type: "git",
    source: marketplaceSource.source,
    ref_name: stableTags[0],
    sparse_paths: [],
    revision: head,
    inferred: true,
  };
}

export function classifyUpgradeState({ marketplaces, plugins, receipt, checkout, targetVersion }) {
  if (!Array.isArray(marketplaces) || !Array.isArray(plugins)) {
    return refuse("Codex marketplace or plugin inventory is malformed.");
  }
  const toolkitMarketplaces = marketplaces.filter((entry) => entry?.name === marketplaceName);
  const toolkitPlugins = plugins.filter((entry) => entry?.marketplaceName === marketplaceName);
  if (toolkitMarketplaces.length === 0 && toolkitPlugins.length === 0) {
    return refuse("No existing toolkit installation was found; use setup instead.");
  }
  if (toolkitMarketplaces.length !== 1) return refuse("Toolkit marketplace state is missing or ambiguous.");
  if (
    toolkitPlugins.length !== 2 ||
    new Set(toolkitPlugins.map((entry) => entry.name)).size !== 2 ||
    toolkitPlugins.some((entry) => !pluginNames.includes(entry.name))
  ) {
    return refuse("Toolkit plugin state is partial, duplicated, or orphaned.");
  }
  const marketplace = toolkitMarketplaces[0];
  const source = marketplace.marketplaceSource;
  if (source?.sourceType !== "git" || !canonicalSources.has(source.source)) {
    return refuse("Toolkit marketplace is not the canonical public Git source.");
  }
  if (toolkitPlugins.some((entry) => entry.installed !== true)) {
    return refuse("Toolkit plugin installed state is ambiguous.");
  }
  if (toolkitPlugins.some((entry) => entry.enabled !== true)) {
    return refuse("Disabled plugin choices cannot currently be restored by the Codex CLI.");
  }
  if (
    receipt?.source_type !== "git" ||
    !canonicalSources.has(receipt?.source) ||
    receipt.source !== source.source ||
    !Array.isArray(receipt.sparse_paths) ||
    receipt.sparse_paths.length !== 0 ||
    !/^v\d+\.\d+\.\d+$/.test(receipt.ref_name ?? "") ||
    !/^[0-9a-f]{40}$/.test(receipt.revision ?? "")
  ) {
    return refuse("Codex marketplace installation receipt is missing, unsafe, or inconsistent.");
  }
  if (!checkout?.clean || checkout.head !== receipt.revision || checkout.refRevision !== receipt.revision) {
    return refuse("Marketplace checkout does not match its recorded immutable revision.");
  }
  const installedVersion = receipt.ref_name.slice(1);
  if (toolkitPlugins.some((entry) => entry.version !== installedVersion)) {
    return refuse("Toolkit plugin versions do not match the marketplace receipt.");
  }
  const installed = parseVersion(installedVersion);
  const target = parseVersion(targetVersion);
  if (!installed || !target) return refuse("Installed or target version is not a stable semantic version.");
  const comparison = compareVersions(target, installed);
  if (comparison < 0) return refuse("The requested target is older than the installed version.");
  const snapshot = {
    source: receipt.source,
    ref: receipt.ref_name,
    revision: receipt.revision,
    version: installedVersion,
    plugins: pluginNames.map((name) => ({ name, enabled: true })),
  };
  return comparison === 0
    ? { disposition: "noop", snapshot }
    : { disposition: "upgrade", snapshot, targetRef: `v${targetVersion}` };
}

export const upgradeInventory = { marketplaceName, pluginNames };

export const mutationPlan = [
  { action: "removePlugin", value: "roku-engineering" },
  { action: "removePlugin", value: "roku-device-toolkit" },
  { action: "removeMarketplace", value: marketplaceName },
  { action: "addMarketplace", value: undefined },
  { action: "addPlugin", value: "roku-device-toolkit" },
  { action: "addPlugin", value: "roku-engineering" },
];

export async function executeUpgradeTransaction({ classification, operations, verifyTarget, verifySnapshot }) {
  if (classification.disposition !== "upgrade") {
    throw new Error("An upgrade transaction requires a supported upgrade state.");
  }
  let mutationStarted = false;
  try {
    for (const step of mutationPlan) {
      mutationStarted = true;
      const value = step.action === "addMarketplace" ? classification.targetRef : step.value;
      await operations[step.action](value);
    }
    await verifyTarget();
  } catch (error) {
    if (!mutationStarted) throw error;
    const rollbackErrors = [];
    operations.beginRollback?.();
    const attempt = async (description, action) => {
      try {
        await action();
      } catch (rollbackError) {
        rollbackErrors.push(`${description}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    };
    let interruptedState;
    await attempt("Inspecting interrupted state", async () => { interruptedState = await operations.inspect(); });
    const installedNames = Array.isArray(interruptedState?.plugins)
      ? interruptedState.plugins.filter((entry) => (
        entry?.marketplaceName === marketplaceName && entry?.installed === true && pluginNames.includes(entry?.name)
      ))
        .map((entry) => entry.name)
      : undefined;
    for (const pluginName of [...pluginNames].reverse()) {
      if (installedNames && !installedNames.includes(pluginName)) continue;
      await attempt(`Removing ${pluginName}`, () => operations.removePlugin(pluginName));
    }
    const marketplacePresent = Array.isArray(interruptedState?.marketplaces)
      ? interruptedState.marketplaces.some((entry) => entry?.name === marketplaceName)
      : undefined;
    if (marketplacePresent !== false) {
      await attempt("Removing marketplace", () => operations.removeMarketplace(marketplaceName));
    }
    await attempt(
      "Restoring marketplace",
      () => operations.addMarketplace(classification.snapshot.ref, classification.snapshot.source),
    );
    for (const pluginName of pluginNames) {
      await attempt(`Restoring ${pluginName}`, () => operations.addPlugin(pluginName));
    }
    await attempt("Verifying restored state", verifySnapshot);
    const initial = error instanceof Error ? error.message : String(error);
    const suffix = rollbackErrors.length === 0
      ? "\nThe previous toolkit version was restored."
      : `\nRollback errors:\n- ${rollbackErrors.join("\n- ")}`;
    throw new Error(`${initial}${suffix}`, { cause: error });
  }
}
