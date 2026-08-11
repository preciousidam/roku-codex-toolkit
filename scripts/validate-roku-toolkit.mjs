#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marketplacePath = path.join(repoRoot, ".agents/plugins/marketplace.json");
const devicePluginRoot = path.join(repoRoot, "plugins/roku-device-toolkit");
const engineeringPluginRoot = path.join(repoRoot, "plugins/roku-engineering");
const pluginRoots = [devicePluginRoot, engineeringPluginRoot];
const manifests = pluginRoots.map((root) => readJson(path.join(root, ".codex-plugin/plugin.json")));
const mcpPath = path.join(devicePluginRoot, ".mcp.json");
const serverPath = path.join(devicePluginRoot, "mcp/server.py");
const launcherPath = path.join(devicePluginRoot, "scripts/launch-mcp.mjs");
const launcherSource = fs.readFileSync(launcherPath, "utf8");
const setupSource = fs.readFileSync(path.join(repoRoot, "scripts/setup-roku-toolkit.mjs"), "utf8");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const marketplace = readJson(marketplacePath);
const mcp = readJson(mcpPath);
assert(marketplace.name === "roku-codex-toolkit", "Unexpected marketplace name.");
for (const [index, manifest] of manifests.entries()) {
  const root = pluginRoots[index];
  const entry = marketplace.plugins?.find((candidate) => candidate.name === manifest.name);
  assert(entry, `Marketplace does not include ${manifest.name}.`);
  assert(entry.source?.path === `./plugins/${manifest.name}`, `${manifest.name} marketplace path is not portable.`);
  assert(path.resolve(repoRoot, entry.source.path) === root, `${manifest.name} marketplace path resolves incorrectly.`);
  assert(/^\d+\.\d+\.\d+(?:\+codex\.[0-9A-Za-z.-]+)?$/.test(manifest.version), `${manifest.name} must use stable semver with at most one Codex cachebuster.`);
  assert(manifest.author?.name === "Ebube Idam", `${manifest.name} author metadata is missing.`);
}
assert(manifests[0].mcpServers === "./.mcp.json", "Device plugin does not reference its MCP configuration.");
assert(!manifests[1].mcpServers, "Only the device plugin may expose the Roku MCP server.");
assert(mcp.mcpServers?.["roku-device"]?.cwd === ".", "MCP server must use plugin-relative cwd.");
assert(mcp.mcpServers?.["roku-device"]?.command === "node", "MCP server must use the portable Node launcher.");
assert(mcp.mcpServers?.["roku-device"]?.args?.[0] === "./scripts/launch-mcp.mjs", "MCP launcher path is invalid.");
assert(launcherSource.includes('for (const signal of ["SIGINT", "SIGTERM"])'), "MCP launcher must handle termination signals.");
assert(launcherSource.includes("child.kill(signal)"), "MCP launcher must forward termination signals to Python.");
for (const [source, label] of [[launcherSource, "launcher"], [setupSource, "setup"]]) {
  assert(source.includes('{ command: "py", args: ["-3"] }'), `Windows py -3 support is missing from the ${label}.`);
}
const skillRoots = pluginRoots.flatMap((root) => fs
  .readdirSync(path.join(root, "skills"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(root, "skills", entry.name)));
assert(skillRoots.length > 0, "Plugin contains no skills.");
for (const skillRoot of skillRoots) {
  const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
  assert(skill.startsWith("---\n"), `${path.basename(skillRoot)} is missing YAML frontmatter.`);
  assert(/\nname: [a-z0-9-]+\n/.test(skill), `${path.basename(skillRoot)} has an invalid skill name.`);
  assert(/\ndescription: .+\n/.test(skill), `${path.basename(skillRoot)} is missing a description.`);
}

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
assert(python, "Python 3.9 or newer is required for validation.");

function spawnPython(args, options = {}) {
  return spawnSync(python.command, [...python.args, ...args], options);
}

const syntaxFiles = [
  serverPath,
  path.join(devicePluginRoot, "scripts/roku_config.py"),
  path.join(devicePluginRoot, "skills/roku-device-operator/scripts/roku_device.py"),
  path.join(devicePluginRoot, "skills/roku-flow-verifier/scripts/run_flow.py"),
  path.join(engineeringPluginRoot, "skills/roku-runtime-log-analyzer/scripts/analyze_roku_log.py"),
];
for (const file of syntaxFiles) {
  const result = spawnPython(
    ["-c", "import ast,sys; ast.parse(open(sys.argv[1], encoding='utf-8').read())", file],
    { encoding: "utf8" },
  );
  assert(result.status === 0, `Python syntax validation failed for ${file}: ${result.stderr}`);
}

const messages = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2099-01-01" } },
  { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  { jsonrpc: "2.0", id: 7, method: "ping", params: {} },
  { id: 8, method: "ping", params: {} },
]
  .map((message) => JSON.stringify(message))
  .join("\n");
const protocol = spawnPython([serverPath], { input: `${messages}\n[]\n{bad\n`, encoding: "utf8" });
assert(protocol.status === 0, `MCP server failed: ${protocol.stderr}`);
const responses = protocol.stdout.trim().split("\n").map(JSON.parse);
const initializeResponse = responses.find((response) => response.id === 1);
const toolsResponse = responses.find((response) => response.id === 2);
const invalidEnvelopeResponse = responses.find((response) => response.id === 8);
assert(initializeResponse?.result?.serverInfo?.name === "roku-device-toolkit", "MCP initialize response is invalid.");
assert(initializeResponse?.result?.protocolVersion === "2025-06-18", "MCP server claimed an unsupported protocol version.");
assert(invalidEnvelopeResponse?.error?.code === -32600, "MCP server accepted a request without jsonrpc 2.0.");
const toolNames = new Set(toolsResponse?.result?.tools?.map((tool) => tool.name));
for (const required of ["configure_target", "device_info", "take_screenshot", "run_flow"]) {
  assert(toolNames.has(required), `MCP tool is missing: ${required}`);
}
for (const toolName of ["take_screenshot", "collect_logs", "run_flow"]) {
  const tool = toolsResponse?.result?.tools?.find((candidate) => candidate.name === toolName);
  assert(tool?.annotations?.readOnlyHint === false, `${toolName} must be declared writable.`);
  assert(tool?.annotations?.destructiveHint === true, `${toolName} must disclose overwrite behavior.`);
}
assert(responses.some((response) => response.id === null && response.error?.code === -32700), "Malformed JSON must return an unassociated parse error.");
assert(responses.some((response) => response.id === null && response.error?.code === -32600), "Non-object JSON-RPC input must return Invalid Request.");
const launchedProtocol = spawnSync("node", [launcherPath], { input: `${messages}\n`, encoding: "utf8" });
assert(launchedProtocol.status === 0, `Portable MCP launcher failed: ${launchedProtocol.stderr}`);
assert(launchedProtocol.stdout.trim().split("\n").map(JSON.parse).some((response) => response.id === 1 && response.result?.protocolVersion === "2025-06-18"), "Portable MCP launcher returned an invalid response.");

const deviceSource = fs.readFileSync(path.join(devicePluginRoot, "skills/roku-device-operator/scripts/roku_device.py"), "utf8");
assert(deviceSource.includes('KEY_ALIASES = {"ok": "Select"}'), "Device operator must normalize OK to Select.");
assert(deviceSource.includes('"--connect-timeout"') && deviceSource.includes('"--max-time"'), "Developer-mode curl requests must be bounded.");
assert(deviceSource.includes("ProxyHandler({})"), "ECP requests must bypass configured proxies.");
assert(deviceSource.includes('"--noproxy", "*"'), "Developer-mode requests must bypass configured proxies.");
const serverSource = fs.readFileSync(serverPath, "utf8");
assert(serverSource.includes("ThreadPoolExecutor"), "MCP requests must remain dispatchable during console capture.");
assert(deviceSource.includes('["/pkgs/dev.png"] if output.suffix.lower() == ".png"'), "Screenshot endpoint must match the requested extension.");
assert(deviceSource.includes('header.startswith(b"\\xff\\xd8\\xff")'), "Screenshot downloads must validate image signatures.");

const validationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roku-toolkit-"));
try {
  const scenarioPath = path.join(validationRoot, "dry-run.json");
  const evidencePath = path.join(validationRoot, "evidence");
  const deviceToolPath = path.join(devicePluginRoot, "skills/roku-device-operator/scripts/roku_device.py");
  const flowEnvironment = { ...process.env, ROKU_DEVICE_TOOL: deviceToolPath };
  fs.writeFileSync(scenarioPath, JSON.stringify({ steps: [{ action: "screenshot", save: "checkpoints/sidebar.jpg" }] }));
  const flowPath = path.join(devicePluginRoot, "skills/roku-flow-verifier/scripts/run_flow.py");
  const dryRun = spawnPython(
    [flowPath, "--scenario", scenarioPath, "--evidence-dir", evidencePath, "--host", "127.0.0.1", "--dry-run"],
    { encoding: "utf8", env: flowEnvironment },
  );
  assert(dryRun.status === 0, `Flow dry-run failed: ${dryRun.stderr}`);
  const report = readJson(path.join(evidencePath, "report.json"));
  assert(report.verified === false && report.passed === false, "Dry-run report must not claim runtime verification.");
  assert(report.steps?.[0]?.status === "skipped", "Dry-run steps must be marked skipped.");

  const previewPath = path.join(validationRoot, "preview.json");
  const previewEvidence = path.join(validationRoot, "preview-evidence");
  fs.writeFileSync(previewPath, JSON.stringify({ steps: [{ action: "press", keys: [null] }, null, { action: "screenshot", save: "preview.jpg" }] }));
  const preview = spawnPython(
    [flowPath, "--scenario", previewPath, "--evidence-dir", previewEvidence, "--host", "127.0.0.1", "--dry-run"],
    { encoding: "utf8", env: flowEnvironment },
  );
  assert(preview.status !== 0, "Invalid dry-run must return a failure status.");
  const previewReport = readJson(path.join(previewEvidence, "report.json"));
  assert(previewReport.steps?.length === 3, "Dry-run did not validate every scenario step.");
  assert(previewReport.steps?.[0]?.status === "invalid", "Non-string remote key was not rejected.");
  assert(previewReport.steps?.[1]?.status === "invalid", "Malformed scenario step was not reported as invalid.");

  const invalidContinuationPath = path.join(validationRoot, "invalid-continuation.json");
  fs.writeFileSync(invalidContinuationPath, JSON.stringify({
    continue_on_failure: "false",
    steps: [{ action: "screenshot", save: "screen.jpg" }],
  }));
  const invalidContinuation = spawnPython(
    [flowPath, "--scenario", invalidContinuationPath, "--evidence-dir", path.join(validationRoot, "invalid-continuation-evidence"), "--host", "127.0.0.1", "--dry-run"],
    { encoding: "utf8", env: flowEnvironment },
  );
  assert(invalidContinuation.status !== 0, "A non-boolean continue_on_failure flag was accepted.");

  const invalidLaunchPath = path.join(validationRoot, "invalid-launch.json");
  const invalidLaunchEvidence = path.join(validationRoot, "invalid-launch-evidence");
  fs.writeFileSync(invalidLaunchPath, JSON.stringify({ steps: [
    { action: "launch", channel_id: null },
    { action: "screenshot", save: "screen.jpg" },
  ] }));
  const invalidLaunch = spawnPython(
    [flowPath, "--scenario", invalidLaunchPath, "--evidence-dir", invalidLaunchEvidence, "--host", "127.0.0.1", "--dry-run"],
    { encoding: "utf8", env: flowEnvironment },
  );
  assert(invalidLaunch.status !== 0, "A non-string launch channel ID was accepted.");
  assert(readJson(path.join(invalidLaunchEvidence, "report.json")).steps?.[0]?.status === "invalid", "Invalid launch channel ID was not reported on its step.");

  const invalidDeepLinkPath = path.join(validationRoot, "invalid-deep-link.json");
  const invalidDeepLinkEvidence = path.join(validationRoot, "invalid-deep-link-evidence");
  fs.writeFileSync(invalidDeepLinkPath, JSON.stringify({ steps: [
    { action: "launch", channel_id: "dev", content_id: { id: 1 }, media_type: true },
    { action: "screenshot", save: "screen.jpg" },
  ] }));
  const invalidDeepLink = spawnPython(
    [flowPath, "--scenario", invalidDeepLinkPath, "--evidence-dir", invalidDeepLinkEvidence, "--host", "127.0.0.1", "--dry-run"],
    { encoding: "utf8", env: flowEnvironment },
  );
  assert(invalidDeepLink.status !== 0, "Non-string deep-link fields were accepted.");
  assert(readJson(path.join(invalidDeepLinkEvidence, "report.json")).steps?.[0]?.status === "invalid", "Invalid deep-link fields were not reported on their step.");

  const unknownStepFieldPath = path.join(validationRoot, "unknown-step-field.json");
  const unknownStepFieldEvidence = path.join(validationRoot, "unknown-step-field-evidence");
  fs.writeFileSync(unknownStepFieldPath, JSON.stringify({ steps: [
    { action: "launch", channel_id: "dev", contentID: "movie-1" },
    { action: "screenshot", save: "screen.jpg" },
  ] }));
  const unknownStepField = spawnPython(
    [flowPath, "--scenario", unknownStepFieldPath, "--evidence-dir", unknownStepFieldEvidence, "--host", "127.0.0.1", "--dry-run"],
    { encoding: "utf8", env: flowEnvironment },
  );
  assert(unknownStepField.status !== 0, "Unknown flow step field was silently ignored.");
  assert(readJson(path.join(unknownStepFieldEvidence, "report.json")).steps?.[0]?.error?.includes("contentID"), "Unknown flow step field was not identified in the report.");

  const unknownScenarioFieldPath = path.join(validationRoot, "unknown-scenario-field.json");
  fs.writeFileSync(unknownScenarioFieldPath, JSON.stringify({
    hots: "wrong-roku",
    steps: [{ action: "screenshot", save: "screen.jpg" }],
  }));
  const unknownScenarioField = spawnPython(
    [flowPath, "--scenario", unknownScenarioFieldPath, "--evidence-dir", path.join(validationRoot, "unknown-scenario-field-evidence"), "--host", "127.0.0.1", "--dry-run"],
    { encoding: "utf8", env: flowEnvironment },
  );
  assert(unknownScenarioField.status !== 0 && unknownScenarioField.stderr.includes("hots"), "Unknown top-level scenario field was silently ignored.");

  const emptyHost = spawnPython(
    [flowPath, "--scenario", scenarioPath, "--evidence-dir", path.join(validationRoot, "empty-host-evidence"), "--host", "", "--dry-run"],
    { encoding: "utf8", env: flowEnvironment },
  );
  assert(emptyHost.status !== 0 && emptyHost.stderr.includes("non-empty string"), "An explicitly empty flow host fell back to another target.");

  const reservedPath = path.join(validationRoot, "reserved.json");
  const reservedEvidence = path.join(validationRoot, "reserved-evidence");
  fs.writeFileSync(reservedPath, JSON.stringify({ steps: [{ action: "query", kind: "active-app", save: "report.json", contains: "dev" }] }));
  const reserved = spawnPython(
    [flowPath, "--scenario", reservedPath, "--evidence-dir", reservedEvidence, "--host", "127.0.0.1", "--dry-run"],
    { encoding: "utf8", env: flowEnvironment },
  );
  assert(reserved.status !== 0, "A step was allowed to overwrite report.json.");

  const normalizedReservedPath = path.join(validationRoot, "normalized-reserved.json");
  const normalizedReservedEvidence = path.join(validationRoot, "normalized-reserved-evidence");
  fs.writeFileSync(normalizedReservedPath, JSON.stringify({ steps: [{ action: "query", kind: "active-app", save: "nested/../report.json", contains: "dev" }] }));
  const normalizedReserved = spawnPython(
    [flowPath, "--scenario", normalizedReservedPath, "--evidence-dir", normalizedReservedEvidence, "--host", "127.0.0.1", "--dry-run"],
    { encoding: "utf8", env: flowEnvironment },
  );
  assert(normalizedReserved.status !== 0, "A normalized artifact path was allowed to overwrite report.json.");

  const invalidQuerySavePath = path.join(validationRoot, "invalid-query-save.json");
  const invalidQuerySaveEvidence = path.join(validationRoot, "invalid-query-save-evidence");
  fs.writeFileSync(invalidQuerySavePath, JSON.stringify({ steps: [
    { action: "query", kind: "active-app", save: true, contains: "dev" },
  ] }));
  const invalidQuerySave = spawnPython(
    [flowPath, "--scenario", invalidQuerySavePath, "--evidence-dir", invalidQuerySaveEvidence, "--host", "127.0.0.1", "--dry-run"],
    { encoding: "utf8", env: flowEnvironment },
  );
  assert(invalidQuerySave.status !== 0, "A non-string query artifact path was accepted.");

  const directoryArtifactPath = path.join(validationRoot, "directory-artifact.json");
  const directoryArtifactEvidence = path.join(validationRoot, "directory-artifact-evidence");
  fs.mkdirSync(directoryArtifactEvidence);
  fs.writeFileSync(directoryArtifactPath, JSON.stringify({ steps: [
    { action: "query", kind: "active-app", save: ".", contains: "dev" },
  ] }));
  const directoryArtifact = spawnPython(
    [flowPath, "--scenario", directoryArtifactPath, "--evidence-dir", directoryArtifactEvidence, "--host", "127.0.0.1", "--dry-run"],
    { encoding: "utf8", env: flowEnvironment },
  );
  assert(directoryArtifact.status !== 0, "A query artifact was allowed to resolve to the evidence directory.");

  const duplicatePath = path.join(validationRoot, "duplicate.json");
  const duplicateEvidence = path.join(validationRoot, "duplicate-evidence");
  fs.writeFileSync(duplicatePath, JSON.stringify({ steps: [
    { action: "query", kind: "active-app", save: "state.txt" },
    { action: "query", kind: "player", save: "state.txt", contains: "play" },
  ] }));
  const duplicate = spawnPython(
    [flowPath, "--scenario", duplicatePath, "--evidence-dir", duplicateEvidence, "--host", "127.0.0.1", "--dry-run"],
    { encoding: "utf8", env: flowEnvironment },
  );
  assert(duplicate.status !== 0, "Duplicate artifact destinations were accepted.");

  const nullAssertionPath = path.join(validationRoot, "null-assertion.json");
  const nullAssertionEvidence = path.join(validationRoot, "null-assertion-evidence");
  fs.writeFileSync(nullAssertionPath, JSON.stringify({ steps: [{ action: "query", kind: "active-app", contains: null }] }));
  const nullAssertion = spawnPython(
    [flowPath, "--scenario", nullAssertionPath, "--evidence-dir", nullAssertionEvidence, "--host", "127.0.0.1", "--dry-run"],
    { encoding: "utf8", env: flowEnvironment },
  );
  assert(nullAssertion.status !== 0, "A null query assertion was accepted.");
  assert(readJson(path.join(nullAssertionEvidence, "report.json")).checkpoint_count === 0, "A null assertion counted as a checkpoint.");

  const textPreviewPath = path.join(validationRoot, "text-preview.json");
  const textPreviewEvidence = path.join(validationRoot, "text-preview-evidence");
  fs.writeFileSync(textPreviewPath, JSON.stringify({ steps: [{ action: "text", value: "-hello" }, { action: "screenshot", save: "screen.jpg" }] }));
  const textPreview = spawnPython(
    [flowPath, "--scenario", textPreviewPath, "--evidence-dir", textPreviewEvidence, "--host", "127.0.0.1", "--dry-run"],
    { encoding: "utf8", env: flowEnvironment },
  );
  assert(textPreview.status === 0, `Valid text dry-run failed: ${textPreview.stderr}`);
  assert(textPreview.stdout.includes(" -- -hello"), "Flow text did not terminate options before a leading-hyphen value.");

  const launchPreviewPath = path.join(validationRoot, "launch-preview.json");
  const launchPreviewEvidence = path.join(validationRoot, "launch-preview-evidence");
  fs.writeFileSync(launchPreviewPath, JSON.stringify({ steps: [
    { action: "launch", channel_id: "-h" },
    { action: "screenshot", save: "screen.jpg" },
  ] }));
  const launchPreview = spawnPython(
    [flowPath, "--scenario", launchPreviewPath, "--evidence-dir", launchPreviewEvidence, "--host", "127.0.0.1", "--dry-run"],
    { encoding: "utf8", env: flowEnvironment },
  );
  assert(launchPreview.status === 0, `Valid launch dry-run failed: ${launchPreview.stderr}`);
  assert(launchPreview.stdout.includes("launch -- -h"), "Flow launch did not terminate options before a leading-hyphen channel ID.");

  const invalidDelayPath = path.join(validationRoot, "invalid-delay.json");
  const invalidDelayEvidence = path.join(validationRoot, "invalid-delay-evidence");
  fs.writeFileSync(invalidDelayPath, JSON.stringify({ steps: [
    { action: "press", keys: ["Home"], delay: "bogus" },
    { action: "screenshot", save: "screen.jpg" },
  ] }));
  const invalidDelay = spawnPython(
    [flowPath, "--scenario", invalidDelayPath, "--evidence-dir", invalidDelayEvidence, "--host", "127.0.0.1", "--dry-run"],
    { encoding: "utf8", env: flowEnvironment },
  );
  assert(invalidDelay.status !== 0, "A nonnumeric delay passed dry-run validation.");
  assert(readJson(path.join(invalidDelayEvidence, "report.json")).steps?.[0]?.status === "invalid", "Invalid delay was not reported on its step.");

  if (process.platform !== "win32") {
    const symlinkEvidence = path.join(validationRoot, "symlink-evidence");
    const outsideReport = path.join(validationRoot, "outside-report.txt");
    fs.mkdirSync(symlinkEvidence);
    fs.writeFileSync(outsideReport, "keep me");
    fs.symlinkSync(outsideReport, path.join(symlinkEvidence, "report.json"));
    const symlinkFlow = spawnPython(
      [flowPath, "--scenario", scenarioPath, "--evidence-dir", symlinkEvidence, "--host", "127.0.0.1", "--dry-run"],
      { encoding: "utf8", env: flowEnvironment },
    );
    assert(symlinkFlow.status === 0, `Flow could not safely replace a symlinked report: ${symlinkFlow.stderr}`);
    assert(fs.readFileSync(outsideReport, "utf8") === "keep me", "Flow report followed a symlink outside its evidence directory.");
    assert(!fs.lstatSync(path.join(symlinkEvidence, "report.json")).isSymbolicLink(), "Flow report remained a symlink.");
  }

  const actionOnlyPath = path.join(validationRoot, "action-only.json");
  const actionOnlyEvidence = path.join(validationRoot, "action-only-evidence");
  fs.writeFileSync(actionOnlyPath, JSON.stringify({ steps: [{ action: "pause", seconds: 0 }] }));
  const actionOnly = spawnPython(
    [flowPath, "--scenario", actionOnlyPath, "--evidence-dir", actionOnlyEvidence, "--host", "127.0.0.1", "--dry-run"],
    { encoding: "utf8", env: flowEnvironment },
  );
  assert(actionOnly.status !== 0, "A flow without a verification checkpoint must be rejected.");
  const actionOnlyReport = readJson(path.join(actionOnlyEvidence, "report.json"));
  assert(actionOnlyReport.checkpoint_count === 0 && actionOnlyReport.verified === false, "Action-only flow claimed verification.");

  const invalidPausePath = path.join(validationRoot, "invalid-pause.json");
  const invalidPauseEvidence = path.join(validationRoot, "invalid-pause-evidence");
  fs.writeFileSync(invalidPausePath, JSON.stringify({ steps: [
    { action: "pause", seconds: "nan" },
    { action: "screenshot", save: "screen.jpg" },
  ] }));
  const invalidPause = spawnPython(
    [flowPath, "--scenario", invalidPausePath, "--evidence-dir", invalidPauseEvidence, "--host", "127.0.0.1", "--dry-run"],
    { encoding: "utf8", env: flowEnvironment },
  );
  assert(invalidPause.status !== 0, "A non-finite pause duration passed dry-run validation.");
  assert(readJson(path.join(invalidPauseEvidence, "report.json")).steps?.[0]?.status === "invalid", "Invalid pause duration was not reported on its step.");

  const caseReportPath = path.join(validationRoot, "case-report.json");
  const caseReportEvidence = path.join(validationRoot, "case-report-evidence");
  fs.writeFileSync(caseReportPath, JSON.stringify({ steps: [
    { action: "query", kind: "active-app", contains: "dev", save: "nested/../REPORT.JSON" },
  ] }));
  const caseReport = spawnPython(
    [flowPath, "--scenario", caseReportPath, "--evidence-dir", caseReportEvidence, "--host", "127.0.0.1", "--dry-run"],
    { encoding: "utf8", env: flowEnvironment },
  );
  assert(caseReport.status !== 0, "Case-variant report artifact was accepted.");

  const preflightMarker = path.join(validationRoot, "preflight-device-called");
  const preflightTool = path.join(validationRoot, "preflight-device.py");
  fs.writeFileSync(preflightTool, `import pathlib\npathlib.Path(${JSON.stringify(preflightMarker)}).write_text("called")\n`);
  const preflightPath = path.join(validationRoot, "preflight.json");
  const preflightEvidence = path.join(validationRoot, "preflight-evidence");
  fs.writeFileSync(preflightPath, JSON.stringify({ steps: [
    { action: "launch", channel_id: "dev" },
    { action: "pause", seconds: "invalid" },
    { action: "screenshot", save: "screen.jpg" },
  ] }));
  const preflight = spawnPython(
    [flowPath, "--scenario", preflightPath, "--evidence-dir", preflightEvidence, "--host", "127.0.0.1"],
    { encoding: "utf8", env: { ...process.env, ROKU_DEVICE_TOOL: preflightTool } },
  );
  assert(preflight.status !== 0 && !fs.existsSync(preflightMarker), "Flow operated the device before all steps passed preflight.");

  const scenarioCollisionEvidence = path.join(validationRoot, "scenario-collision-evidence");
  fs.mkdirSync(scenarioCollisionEvidence);
  const scenarioCollisionPath = path.join(scenarioCollisionEvidence, "scenario.json");
  const scenarioCollisionSource = JSON.stringify({ steps: [
    { action: "query", kind: "active-app", contains: "dev", save: "scenario.json" },
  ] });
  fs.writeFileSync(scenarioCollisionPath, scenarioCollisionSource);
  const scenarioCollision = spawnPython(
    [flowPath, "--scenario", scenarioCollisionPath, "--evidence-dir", scenarioCollisionEvidence, "--host", "127.0.0.1", "--dry-run"],
    { encoding: "utf8", env: flowEnvironment },
  );
  assert(scenarioCollision.status !== 0, "Flow allowed an artifact to overwrite its scenario.");
  assert(fs.readFileSync(scenarioCollisionPath, "utf8") === scenarioCollisionSource, "Flow modified its scenario during collision handling.");

  const reportScenarioEvidence = path.join(validationRoot, "report-scenario-evidence");
  fs.mkdirSync(reportScenarioEvidence);
  const reportScenarioPath = path.join(reportScenarioEvidence, "report.json");
  const reportScenarioSource = JSON.stringify({ steps: [{ action: "screenshot", save: "screen.jpg" }] });
  fs.writeFileSync(reportScenarioPath, reportScenarioSource);
  const reportScenario = spawnPython(
    [flowPath, "--scenario", reportScenarioPath, "--evidence-dir", reportScenarioEvidence, "--host", "127.0.0.1", "--dry-run"],
    { encoding: "utf8", env: flowEnvironment },
  );
  assert(reportScenario.status !== 0 && fs.readFileSync(reportScenarioPath, "utf8") === reportScenarioSource, "Flow replaced a scenario named report.json.");

  const failedScreenshotTool = path.join(validationRoot, "failed-screenshot.py");
  fs.writeFileSync(failedScreenshotTool, "import sys\nraise SystemExit(1)\n");
  const failedScreenshotEvidence = path.join(validationRoot, "failed-screenshot-evidence");
  fs.mkdirSync(failedScreenshotEvidence);
  const priorScreenshot = path.join(failedScreenshotEvidence, "screen.jpg");
  fs.writeFileSync(priorScreenshot, "prior evidence");
  const failedScreenshotScenario = path.join(validationRoot, "failed-screenshot.json");
  fs.writeFileSync(failedScreenshotScenario, JSON.stringify({ steps: [{ action: "screenshot", save: "screen.jpg" }] }));
  const failedScreenshot = spawnPython(
    [flowPath, "--scenario", failedScreenshotScenario, "--evidence-dir", failedScreenshotEvidence, "--host", "127.0.0.1"],
    { encoding: "utf8", env: { ...process.env, ROKU_DEVICE_TOOL: failedScreenshotTool } },
  );
  const failedScreenshotReport = readJson(path.join(failedScreenshotEvidence, "report.json"));
  assert(failedScreenshot.status !== 0 && fs.readFileSync(priorScreenshot, "utf8") === "prior evidence", "Failed capture destroyed prior screenshot evidence.");
  assert(!failedScreenshotReport.steps?.[0]?.artifact, "Failed capture reported stale screenshot evidence as current.");

  const failedQueryTool = path.join(validationRoot, "failed-query.py");
  fs.writeFileSync(failedQueryTool, "import sys\nraise SystemExit(1)\n");
  const failedQueryEvidence = path.join(validationRoot, "failed-query-evidence");
  fs.mkdirSync(failedQueryEvidence);
  const priorQuery = path.join(failedQueryEvidence, "state.xml");
  fs.writeFileSync(priorQuery, "<prior/>");
  const failedQueryScenario = path.join(validationRoot, "failed-query.json");
  fs.writeFileSync(failedQueryScenario, JSON.stringify({ steps: [
    { action: "query", kind: "active-app", contains: "dev", save: "state.xml" },
  ] }));
  const failedQuery = spawnPython(
    [flowPath, "--scenario", failedQueryScenario, "--evidence-dir", failedQueryEvidence, "--host", "127.0.0.1"],
    { encoding: "utf8", env: { ...process.env, ROKU_DEVICE_TOOL: failedQueryTool } },
  );
  const failedQueryReport = readJson(path.join(failedQueryEvidence, "report.json"));
  assert(failedQuery.status !== 0 && fs.readFileSync(priorQuery, "utf8") === "<prior/>", "Failed query destroyed prior saved output.");
  assert(!failedQueryReport.steps?.[0]?.artifact, "Failed query reported stale saved output as current.");

  const fakeDeviceTool = path.join(validationRoot, "fake-device.py");
  fs.writeFileSync(
    fakeDeviceTool,
    "import pathlib,sys\nif '--output' in sys.argv:\n output=pathlib.Path(sys.argv[sys.argv.index('--output')+1]); output.write_bytes(b'\\xff\\xd8\\xffjpeg'); print(output)\nelse:\n print('<active-app>dev</active-app>')\n",
  );
  const captureEvidence = path.join(validationRoot, "capture-evidence");
  const captureFlow = spawnPython(
    [flowPath, "--scenario", scenarioPath, "--evidence-dir", captureEvidence, "--host", "127.0.0.1"],
    { encoding: "utf8", env: { ...process.env, ROKU_DEVICE_TOOL: fakeDeviceTool } },
  );
  assert(captureFlow.status !== 0, "Screenshot-only flow claimed automated verification.");
  const capturedScreenshot = path.join(captureEvidence, "checkpoints/sidebar.jpg");
  assert(fs.existsSync(capturedScreenshot), "Nested screenshot directory was not created.");
  const captureReport = readJson(path.join(captureEvidence, "report.json"));
  assert(captureReport.verified === false && captureReport.passed === false, "Screenshot capture was reported as verified.");
  assert(captureReport.steps?.[0]?.status === "pending_visual_review", "Screenshot capture was not left pending visual review.");
  assert(captureReport.steps?.[0]?.passed === false && captureReport.steps?.[0]?.capture_succeeded === true, "Screenshot capture was treated as a passed visual assertion.");
  assert(captureReport.steps?.[0]?.visual_review_required === true, "Screenshot report omitted its visual-review requirement.");
  const mixedScenario = path.join(validationRoot, "mixed-screenshot.json");
  const mixedEvidence = path.join(validationRoot, "mixed-screenshot-evidence");
  fs.writeFileSync(mixedScenario, JSON.stringify({ steps: [
    { action: "screenshot", save: "screen.jpg" },
    { action: "query", kind: "active-app", contains: "dev" },
  ] }));
  const mixedFlow = spawnPython(
    [flowPath, "--scenario", mixedScenario, "--evidence-dir", mixedEvidence, "--host", "127.0.0.1"],
    { encoding: "utf8", env: { ...process.env, ROKU_DEVICE_TOOL: fakeDeviceTool } },
  );
  const mixedReport = readJson(path.join(mixedEvidence, "report.json"));
  assert(mixedFlow.status !== 0 && mixedReport.verified === true && mixedReport.passed === false, "Mixed screenshot flow passed before visual review.");
  assert(mixedReport.pending_visual_review === true, "Mixed screenshot flow omitted its pending visual-review state.");
  if (process.platform !== "win32") {
    assert((fs.statSync(captureEvidence).mode & 0o777) === 0o700, "New evidence directory is not private.");
    assert((fs.statSync(capturedScreenshot).mode & 0o777) === 0o600, "Screenshot artifact is not private.");
    assert((fs.statSync(path.join(captureEvidence, "report.json")).mode & 0o777) === 0o600, "Flow report is not private.");
  }

  const emptyPath = path.join(validationRoot, "empty.json");
  fs.writeFileSync(emptyPath, JSON.stringify({ steps: [] }));
  const emptyFlow = spawnPython(
    [flowPath, "--scenario", emptyPath, "--evidence-dir", path.join(validationRoot, "empty"), "--host", "127.0.0.1", "--dry-run"],
    { encoding: "utf8", env: flowEnvironment },
  );
  assert(emptyFlow.status !== 0, "An empty flow must be rejected.");

  const analyzerScript = path.join(engineeringPluginRoot, "skills/roku-runtime-log-analyzer/scripts/analyze_roku_log.py");
  const runtimeLog = path.join(validationRoot, "runtime.log");
  fs.writeFileSync(runtimeLog, "AuthGate: request intent=premium_subscription\nFocusManager: setFocus HomeGrid\nParseJSON completed successfully\nDRM license acquired successfully\nPlaybackError: player failed\n");
  const analysis = spawnPython([analyzerScript, runtimeLog, "--json"], { encoding: "utf8" });
  assert(analysis.status === 0, `Runtime log analysis failed: ${analysis.stderr}`);
  assert(JSON.parse(analysis.stdout)[0]?.first_actionable?.category === "playback", "Routine AuthGate routing was treated as a failure.");
  const authFailureLog = path.join(validationRoot, "auth-failure.log");
  fs.writeFileSync(authFailureLog, "Entitlement: request_failed code=401 reason=Not authorized missing_token\n");
  const authAnalysis = spawnPython([analyzerScript, authFailureLog, "--json"], { encoding: "utf8" });
  assert(authAnalysis.status === 0, `Authentication log analysis failed: ${authAnalysis.stderr}`);
  assert(JSON.parse(authAnalysis.stdout)[0]?.first_actionable?.category === "auth_entitlement", "Authentication failure was classified as a generic request failure.");
  const numericMetricLog = path.join(validationRoot, "numeric-metric.log");
  fs.writeFileSync(numericMetricLog, "metrics response_bytes=401 cache_hit=true\nPlaybackError: player failed\n");
  const numericMetricAnalysis = spawnPython([analyzerScript, numericMetricLog, "--json"], { encoding: "utf8" });
  assert(numericMetricAnalysis.status === 0, `Numeric metric log analysis failed: ${numericMetricAnalysis.stderr}`);
  assert(JSON.parse(numericMetricAnalysis.stdout)[0]?.first_actionable?.category === "playback", "A standalone numeric metric was classified as authentication failure.");
  const priorityLog = path.join(validationRoot, "priority.log");
  fs.writeFileSync(priorityLog, "PlaybackError: generic failure\nBacktrace:\n");
  const priorityAnalysis = spawnPython([analyzerScript, priorityLog, "--json"], { encoding: "utf8" });
  assert(priorityAnalysis.status === 0, `Priority log analysis failed: ${priorityAnalysis.stderr}`);
  assert(JSON.parse(priorityAnalysis.stdout)[0]?.first_actionable?.category === "backtrace", "Analyzer ignored causal-event priority.");
  const secretLog = path.join(validationRoot, "secret.log");
  fs.writeFileSync(secretLog, "PlaybackError Authorization: Bearer top-secret access_token=access-secret licenseUrl=https://license.test/key?token=license-secret accountId=private-account\n" +
    '{"message":"PlaybackError","Authorization":"Bearer json-secret","access_token":"json-access"}\n' +
    'request_failed payload={\\"Authorization\\":\\"Bearer escaped-secret\\",\\"refresh_token\\":\\"escaped-refresh\\"}\n' +
    'DRM license=https://license.example/key?token=bare-license-secret request failed\n' +
    'request_failed id_token=identity-secret client_secret=client-secret api_key=api-secret cookie=cookie-secret\n');
  const secretAnalysis = spawnPython([analyzerScript, secretLog, "--json"], { encoding: "utf8" });
  assert(secretAnalysis.status === 0, `Secret log analysis failed: ${secretAnalysis.stderr}`);
  for (const secret of ["top-secret", "access-secret", "license-secret", "private-account", "json-secret", "json-access", "escaped-secret", "escaped-refresh", "bare-license-secret", "identity-secret", "client-secret", "api-secret", "cookie-secret"]) {
    assert(!secretAnalysis.stdout.includes(secret), `Runtime analyzer exposed ${secret}.`);
  }
  assert(secretAnalysis.stdout.includes("<redacted>"), "Runtime analyzer did not mark redacted fields.");
  const taskFailureLog = path.join(validationRoot, "task-failure.log");
  fs.writeFileSync(taskFailureLog, "CatalogTask: http_failed code=500\nCatalogTask: timeout\n");
  const taskFailureAnalysis = spawnPython([analyzerScript, taskFailureLog, "--json"], { encoding: "utf8" });
  assert(taskFailureAnalysis.status === 0, `Task failure log analysis failed: ${taskFailureAnalysis.stderr}`);
  assert(JSON.parse(taskFailureAnalysis.stdout)[0]?.events?.length === 2, "Task http_failed or timeout labels were not classified as request failures.");

  const infiniteLogs = spawnPython(
    [deviceToolPath, "--host", "127.0.0.1", "logs", "--seconds", "inf", "--output", path.join(validationRoot, "infinite.log")],
    { encoding: "utf8" },
  );
  assert(infiniteLogs.status !== 0 && infiniteLogs.stderr.includes("between 0.1 and 120"), "Infinite direct log capture duration was accepted.");
  const infiniteEcpTimeout = spawnPython(
    [deviceToolPath, "--host", "127.0.0.1", "--timeout", "inf", "info"],
    { encoding: "utf8" },
  );
  assert(infiniteEcpTimeout.status !== 0 && infiniteEcpTimeout.stderr.includes("between 0.1 and 60"), "Infinite direct ECP timeout was accepted.");
  for (const command of ["press", "text"]) {
    const value = command === "press" ? "Down" : "hello";
    const infiniteDelay = spawnPython(
      [deviceToolPath, "--host", "127.0.0.1", command, "--delay", "inf", "--", value],
      { encoding: "utf8" },
    );
    assert(infiniteDelay.status !== 0 && infiniteDelay.stderr.includes("between 0 and 10"), `Infinite direct ${command} delay was accepted.`);
  }

  const relativeConfig = spawnPython(
    ["-c", "import os,sys;sys.path.insert(0,sys.argv[1]);import roku_config;os.environ['ROKU_TOOLKIT_CONFIG']='relative.json';roku_config.config_path()", path.join(devicePluginRoot, "scripts")],
    { encoding: "utf8" },
  );
  assert(relativeConfig.status !== 0 && relativeConfig.stderr.includes("absolute path"), "Relative ROKU_TOOLKIT_CONFIG override was accepted.");

  const configBehavior = spawnPython(
    [
      "-c",
      [
        "import importlib.util,json,os,pathlib,sys",
        "config_path=pathlib.Path(sys.argv[1]).resolve(); root=pathlib.Path(sys.argv[2]).resolve(); root.mkdir()",
        "spec=importlib.util.spec_from_file_location('roku_config_compatibility',config_path)",
        "module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)",
        "module.DEFAULT_CONFIG=root/'config.json'",
        "module.DEFAULT_CONFIG.write_text(json.dumps({'target':'roku.local'}))",
        "os.environ.pop(module.CONFIG_ENV,None)",
        "assert module.configuration_status()['config_path']==str(module.DEFAULT_CONFIG)",
        "os.environ['ROKU_DEV_TARGET']='configured-roku'",
        "try: module.resolve_target('')",
        "except ValueError: pass",
        "else: raise AssertionError('empty explicit host fell back to configured target')",
        "os.environ['ROKU_DEV_TARGET']='   '",
        "assert module.resolve_target()=='roku.local'",
        "assert module.configuration_status()['target']=='roku.local'",
        "module.DEFAULT_CONFIG.write_text(json.dumps({'target':True}))",
        "try: module.resolve_target()",
        "except ValueError: pass",
        "else: raise AssertionError('non-string saved target was accepted')",
      ].join("\n"),
      path.join(devicePluginRoot, "scripts/roku_config.py"),
      path.join(validationRoot, "config-compatibility"),
    ],
    { encoding: "utf8" },
  );
  assert(configBehavior.status === 0, `Configuration behavior validation failed: ${configBehavior.stderr}`);

  const keychainBehavior = spawnPython(
    [
      "-c",
      [
        "import importlib.util,pathlib,sys",
        "config_path=pathlib.Path(sys.argv[1]).resolve()",
        "spec=importlib.util.spec_from_file_location('roku_config_validation',config_path)",
        "module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)",
        "calls=[]",
        "class Result: returncode=0; stderr=''",
        "module.sys.platform='darwin'",
        "module.subprocess.run=lambda command,**kwargs: calls.append((command,kwargs)) or Result()",
        "module.store_keychain_password('secret')",
        "assert calls[0][0][-1:]==['-w']",
        "assert 'secret' not in calls[0][0]",
        "assert calls[0][1]['input']=='secret\\n'",
      ].join("\n"),
      path.join(devicePluginRoot, "scripts/roku_config.py"),
    ],
    { encoding: "utf8" },
  );
  assert(keychainBehavior.status === 0, `Keychain password invocation validation failed: ${keychainBehavior.stderr}`);

  const deviceBehavior = spawnPython(
    [
      "-c",
      [
        "import importlib.util,pathlib,stat,sys",
        "tool=pathlib.Path(sys.argv[1]).resolve()",
        "archive=pathlib.Path(sys.argv[2]); archive.write_bytes(b'zip')",
        "spec=importlib.util.spec_from_file_location('roku_device_validation',tool)",
        "module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)",
        "assert '<device-info' in module.pretty_xml(b'<device-info><model>Roku</model></device-info>','device-info')",
        "for payload in (b'not xml',b'<html><body>login</body></html>'):",
        "    try: module.pretty_xml(payload,'device-info')",
        "    except SystemExit: pass",
        "    else: raise AssertionError('malformed or unexpected ECP query payload was accepted')",
        "assert module.trusted_developer_host('192.168.1.50')=='192.168.1.50'",
        "try: module.trusted_developer_host('8.8.8.8')",
        "except SystemExit: pass",
        "else: raise AssertionError('public developer target was trusted')",
        "module.curl_digest=lambda *args,**kwargs:'Install Failure: Compilation Failed'",
        "try: module.sideload('roku',archive,True)",
        "except SystemExit: pass",
        "else: raise AssertionError('failed install was reported successful')",
        "module.curl_digest=lambda *args,**kwargs:'Install Success.'",
        "module.sideload('roku',archive,True)",
        "module.curl_digest=lambda host,path,extra,output=None: pathlib.Path(output).write_bytes(b'\\xff\\xd8\\xffjpeg') if output else ''",
        "screenshot=archive.parent/'roku-screen.jpg'",
        "module.take_screenshot('roku',screenshot)",
        "assert screenshot.read_bytes()==b'\\xff\\xd8\\xffjpeg'",
        "assert sys.platform=='win32' or stat.S_IMODE(screenshot.stat().st_mode)==0o600",
        "module.curl_digest=lambda host,path,extra,output=None: pathlib.Path(output).write_bytes(b'<html>error</html>') if output else ''",
        "try: module.take_screenshot('roku',screenshot)",
        "except SystemExit as error: assert 'valid image' in str(error).lower()",
        "else: raise AssertionError('non-image screenshot response was accepted')",
        "assert screenshot.read_bytes()==b'\\xff\\xd8\\xffjpeg'",
        "directory_output=archive.parent/'directory.jpg'; directory_output.mkdir()",
        "calls=[]; module.curl_digest=lambda *args,**kwargs:calls.append(args)",
        "try: module.take_screenshot('roku',directory_output)",
        "except SystemExit: pass",
        "else: raise AssertionError('screenshot directory output was accepted')",
        "assert calls==[]",
        "unsupported_output=archive.parent/'screen.gif'",
        "try: module.take_screenshot('roku',unsupported_output)",
        "except SystemExit as error: assert '.jpg' in str(error).lower()",
        "else: raise AssertionError('unsupported screenshot extension was accepted')",
        "assert calls==[]",
        "log=archive.parent/'roku-console.log'",
        "module.write_private_text(log,'token-bearing log')",
        "assert sys.platform=='win32' or stat.S_IMODE(log.stat().st_mode)==0o600",
        "clock=[0.0]",
        "class SlowConnection:",
        "    def __enter__(self): return self",
        "    def __exit__(self,*args): pass",
        "    def setblocking(self,value): pass",
        "slow_connection=SlowConnection()",
        "def slow_connect(*args,**kwargs): clock[0]=8.0; return slow_connection",
        "def ticking_time(): value=clock[0]; clock[0]+=1.0; return value",
        "module.socket.create_connection=slow_connect",
        "module.select.select=lambda *args,**kwargs:([],[],[])",
        "module.time.monotonic=ticking_time",
        "timed=archive.parent/'timed-console.log'",
        "module.collect_logs('roku',10,timed)",
        "assert clock[0] >= 18.0",
        "class FakeConnection:",
        "    def __init__(self): self.reads=iter((b'partial log',b''))",
        "    def __enter__(self): return self",
        "    def __exit__(self,*args): pass",
        "    def setblocking(self,value): pass",
        "    def recv(self,size): return next(self.reads)",
        "connection=FakeConnection()",
        "module.socket.create_connection=lambda *args,**kwargs:connection",
        "module.select.select=lambda *args,**kwargs:([connection],[],[])",
        "module.time.monotonic=lambda:0.0",
        "partial=archive.parent/'partial-console.log'",
        "try: module.collect_logs('roku',10,partial)",
        "except SystemExit as error: assert 'disconnected' in str(error).lower()",
        "else: raise AssertionError('early console disconnect was reported successful')",
        "assert partial.read_text()=='partial log'",
        "prior=archive.parent/'prior-console.log'; prior.write_text('prior evidence')",
        "empty_connection=FakeConnection(); empty_connection.reads=iter((b'',))",
        "module.socket.create_connection=lambda *args,**kwargs:empty_connection",
        "module.select.select=lambda *args,**kwargs:([empty_connection],[],[])",
        "try: module.collect_logs('roku',10,prior)",
        "except SystemExit as error: assert 'prior output was preserved' in str(error).lower()",
        "else: raise AssertionError('empty early disconnect was reported successful')",
        "assert prior.read_text()=='prior evidence'",
        "log_directory=archive.parent/'capture.log'; log_directory.mkdir()",
        "connection_attempted=[False]",
        "module.socket.create_connection=lambda *args,**kwargs:connection_attempted.__setitem__(0,True)",
        "try: module.collect_logs('roku',10,log_directory)",
        "except SystemExit: pass",
        "else: raise AssertionError('log directory output was accepted')",
        "assert connection_attempted==[False]",
        "class ResetConnection(FakeConnection):",
        "    def __init__(self): self.reads=iter((b'partial before reset',))",
        "    def recv(self,size):",
        "        try: return next(self.reads)",
        "        except StopIteration: raise ConnectionResetError('reset')",
        "reset_connection=ResetConnection()",
        "module.socket.create_connection=lambda *args,**kwargs:reset_connection",
        "module.select.select=lambda *args,**kwargs:([reset_connection],[],[])",
        "reset_log=archive.parent/'reset-console.log'",
        "try: module.collect_logs('roku',10,reset_log)",
        "except SystemExit as error: assert 'partial logs were preserved' in str(error).lower()",
        "else: raise AssertionError('socket reset was reported successful')",
        "assert reset_log.read_text()=='partial before reset'",
        "try: module.resolve_target('192.168.1.50:8060')",
        "except ValueError: pass",
        "else: raise AssertionError('port-qualified Roku target was accepted')",
      ].join("\n"),
      deviceToolPath,
      path.join(validationRoot, "app.zip"),
    ],
    { encoding: "utf8" },
  );
  assert(deviceBehavior.status === 0, `Sideload response validation failed: ${deviceBehavior.stderr}`);

  const serverBehavior = spawnPython(
    [
      "-c",
      [
        "import importlib.util,os,pathlib,stat,sys,threading,time",
        "server_path=pathlib.Path(sys.argv[1]).resolve()",
        "scenario=pathlib.Path(sys.argv[2]).resolve()",
        "evidence=pathlib.Path(sys.argv[3]).resolve()",
        "temporary_root=pathlib.Path(sys.argv[4]).resolve()",
        "temporary_root.mkdir()",
        "spec=importlib.util.spec_from_file_location('roku_server_validation',server_path)",
        "module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)",
        "module.resolve_target=lambda explicit=None: explicit or 'roku.test'",
        "module.socket.getaddrinfo=lambda *args,**kwargs:[(module.socket.AF_INET,module.socket.SOCK_STREAM,6,'',('192.168.1.50',0))]",
        "executions=[]",
        "original_execute=module.execute",
        "module.host_args=lambda arguments:['--host','roku']",
        "module.execute=lambda command,timeout=30,*args,**kwargs: executions.append((command,timeout)) or {'command_succeeded':True,'return_code':0,'stdout':'','stderr':''}",
        "module.call_tool('enter_text',{'text':'-hello'})",
        "assert executions[0][0][-2:]==['--','-hello']",
        "assert executions[0][1] >= 90",
        "module.call_tool('press',{'keys':['-h']})",
        "assert executions[1][0][-4:]==['--delay','0.35','--','-h']",
        "assert executions[1][1] >= 40",
        "try: module.call_tool('press',{'keys':[' ']})",
        "except ValueError: pass",
        "else: raise AssertionError('whitespace-only MCP key was accepted')",
        "invalid_numbers=(('press',{'keys':['Down'],'delay':-1}),('press',{'keys':['Down'],'delay':True}),('enter_text',{'text':'x','delay':'1'}),('collect_logs',{'seconds':0}),('collect_logs',{'seconds':float('inf')}))",
        "for invalid_name,invalid_arguments in invalid_numbers:",
        "    try: module.call_tool(invalid_name,invalid_arguments)",
        "    except ValueError: pass",
        "    else: raise AssertionError(f'invalid numeric argument was accepted for {invalid_name}')",
        "module.call_tool('launch',{'channel_id':'-h'})",
        "assert executions[2][0][-2:]==['--','-h']",
        "try: module.call_tool('launch',{'channel_id':'dev','content_id':{'id':1}})",
        "except ValueError: pass",
        "else: raise AssertionError('non-string MCP deep-link field was accepted')",
        "try: module.call_tool('launch',{'channel_id':None})",
        "except ValueError: pass",
        "else: raise AssertionError('non-string channel_id was accepted')",
        "try: module.call_tool('configure_target',{'target':None})",
        "except ValueError: pass",
        "else: raise AssertionError('non-string target was accepted')",
        "module.call_tool('run_flow',{'scenario':str(scenario),'evidence_dir':str(evidence)})",
        "assert executions[3][1] >= 4970",
        "for invalid_name,invalid_output in (('take_screenshot',False),('take_screenshot',0),('collect_logs',False),('collect_logs',0)):",
        "    try: module.call_tool(invalid_name,{'output':invalid_output})",
        "    except ValueError: pass",
        "    else: raise AssertionError(f'falsey explicit output was accepted for {invalid_name}')",
        "screenshot_path=temporary_root/'screen.jpg'",
        "module.call_tool('take_screenshot',{'output':str(screenshot_path)})",
        "assert executions[4][1] >= 260",
        "archive=temporary_root/'app.zip'; archive.write_bytes(b'zip')",
        "module.call_tool('sideload',{'archive':str(archive),'confirm_replace_dev_app':True})",
        "assert executions[5][1] >= 140",
        "captured_arguments=[]",
        "original_tool_result=module.tool_result",
        "module.tool_result=lambda name,arguments: captured_arguments.append(arguments) or {}",
        "module.handle({'jsonrpc':'2.0','id':99,'method':'tools/call','params':{'name':'collect_logs','arguments':[]}})",
        "assert captured_arguments==[[]]",
        "invalid_envelope=module.handle({'id':100,'method':'tools/call','params':{'name':'collect_logs','arguments':{}}})",
        "assert invalid_envelope['error']['code']==-32600 and captured_arguments==[[]]",
        "module.tool_result=original_tool_result",
        "cancelled=[]",
        "process=object(); module.IN_FLIGHT[77]=process",
        "module.terminate_process=lambda candidate: cancelled.append(candidate)",
        "module.cancel_request(77)",
        "assert cancelled==[process]",
        "boolean_process=object(); module.IN_FLIGHT[1]=boolean_process",
        "module.cancel_request(True)",
        "assert boolean_process not in cancelled and True not in module.CANCELLED_REQUESTS",
        "boolean_request=module.handle({'jsonrpc':'2.0','id':True,'method':'ping'})",
        "assert boolean_request['error']['code']==-32600 and boolean_request['id'] is None",
        "process_two=object(); module.IN_FLIGHT[78]=process_two; module.PENDING_REQUESTS.add(78)",
        "module.cancel_all_requests()",
        "assert process_two in cancelled",
        "process_three=object(); module.IN_FLIGHT[79]=process_three; module.PENDING_REQUESTS.add(79)",
        "try: module.handle_shutdown_signal(module.signal.SIGTERM,None)",
        "except SystemExit as error: assert error.code==128+module.signal.SIGTERM",
        "else: raise AssertionError('server shutdown signal did not terminate the process')",
        "assert module.SHUTDOWN_REQUESTED.is_set()",
        "assert process_three not in cancelled",
        "module.cancel_all_requests()",
        "assert process_three in cancelled",
        "module.PENDING_REQUESTS.add(88)",
        "module.cancel_request(88)",
        "assert 88 in module.CANCELLED_REQUESTS",
        "token=module.CURRENT_REQUEST_ID.set(88)",
        "try:",
        "    try: original_execute(['must-not-run'])",
        "    except module.RequestCancelled: pass",
        "    else: raise AssertionError('cancelled queued request executed')",
        "finally: module.CURRENT_REQUEST_ID.reset(token)",
        "try: module.call_tool('run_flow',{'scenario':str(scenario),'evidence_dir':str(evidence),'dry_run':'true'})",
        "except ValueError: pass",
        "else: raise AssertionError('non-boolean dry_run was accepted')",
        "try: module.call_tool('run_flow',{'scenario':str(scenario),'evidence_dir':str(evidence),'host':''})",
        "except ValueError: pass",
        "else: raise AssertionError('empty run_flow host was accepted')",
        "unknown_flow=module.tool_result('run_flow',{'scenario':str(scenario),'evidence_dir':str(evidence),'dryrun':True})",
        "assert unknown_flow['isError'] is True and 'dryrun' in unknown_flow['content'][0]['text']",
        "unknown_press=module.tool_result('press',{'keys':['Down'],'hosst':'roku-b'})",
        "assert unknown_press['isError'] is True and 'hosst' in unknown_press['content'][0]['text']",
        "module.tempfile.tempdir=str(temporary_root)",
        "outside=temporary_root/'outside'; outside.mkdir()",
        "trap=temporary_root/'roku-device-mcp'",
        "trap.symlink_to(outside,target_is_directory=True) if sys.platform!='win32' else None",
        "artifact=module.default_artifact('.log')",
        "assert artifact.parent != trap and not artifact.parent.is_symlink()",
        "assert sys.platform=='win32' or stat.S_IMODE(artifact.stat().st_mode)==0o600",
        "assert sys.platform=='win32' or stat.S_IMODE(artifact.parent.stat().st_mode)==0o700",
        "artifact.unlink()",
        "try: module.path_arg('relative/file.log','output')",
        "except ValueError: pass",
        "else: raise AssertionError('relative MCP path was accepted')",
        "directory_output=temporary_root/'capture.log'; directory_output.mkdir()",
        "try: module.path_arg(str(directory_output),'output')",
        "except ValueError: pass",
        "else: raise AssertionError('directory MCP output was accepted as a file')",
        "if sys.platform!='win32': (temporary_root/'explicit-target').write_text('safe')",
        "if sys.platform!='win32': (temporary_root/'explicit.log').symlink_to(temporary_root/'explicit-target')",
        "if sys.platform!='win32':",
        "    try: module.path_arg(str(temporary_root/'explicit.log'),'output')",
        "    except ValueError: pass",
        "    else: raise AssertionError('symlinked explicit artifact was accepted')",
        "evidence.mkdir(parents=True,exist_ok=True)",
        "flow_report=evidence/'report.json'; flow_report.write_text('{\"passed\":true}')",
        "module.execute=lambda *args,**kwargs: (_ for _ in ()).throw(module.CommandFailure('invalid scenario',{'command_succeeded':False,'return_code':1,'stdout':'','stderr':'invalid scenario'}))",
        "stale_flow_failure=module.tool_result('run_flow',{'scenario':str(scenario),'evidence_dir':str(evidence)})",
        "assert 'artifact' not in stale_flow_failure['structuredContent']",
        "def fail_flow(command,timeout=30,*args,**kwargs):",
        "    flow_report.write_text('{\"passed\":false,\"current\":true}')",
        "    raise module.CommandFailure('checkpoint failed',{'command_succeeded':False,'return_code':1,'stdout':'','stderr':'checkpoint failed'})",
        "module.execute=fail_flow",
        "flow_failure=module.tool_result('run_flow',{'scenario':str(scenario),'evidence_dir':str(evidence)})",
        "assert flow_failure['isError'] is True",
        "assert flow_failure['structuredContent']['artifact']==str(flow_report)",
        "stale_log=temporary_root/'stale.log'; stale_log.write_text('old capture')",
        "module.execute=lambda *args,**kwargs: (_ for _ in ()).throw(module.CommandFailure('connection failed',{'command_succeeded':False,'return_code':1,'stdout':'','stderr':'connection failed'}))",
        "stale_log_failure=module.tool_result('collect_logs',{'output':str(stale_log)})",
        "assert 'artifact' not in stale_log_failure['structuredContent']",
        "assert stale_log.read_text()=='old capture'",
        "partial_artifact=temporary_root/'partial-default.log'",
        "module.default_artifact=lambda suffix:partial_artifact",
        "def fail_with_partial(command,timeout=30,*args,**kwargs):",
        "    partial_artifact.write_text('partial')",
        "    raise module.CommandFailure('console disconnected',{'command_succeeded':False,'return_code':1,'stdout':str(partial_artifact),'stderr':'console disconnected'})",
        "module.execute=fail_with_partial",
        "failure=module.tool_result('collect_logs',{})",
        "assert failure['isError'] is True",
        "assert failure['structuredContent']['artifact']==str(partial_artifact)",
        "assert str(partial_artifact) in failure['content'][0]['text']",
        "active=[0]; maximum=[0]; concurrency_guard=threading.Lock()",
        "def concurrent_call(name,arguments):",
        "    with concurrency_guard:",
        "        active[0]+=1; maximum[0]=max(maximum[0],active[0])",
        "    time.sleep(0.05)",
        "    with concurrency_guard: active[0]-=1",
        "    return {'command_succeeded':True,'stdout':'','stderr':''}",
        "module.call_tool=concurrent_call",
        "module.socket.getaddrinfo=lambda *args,**kwargs:[(module.socket.AF_INET,module.socket.SOCK_STREAM,6,'',('192.168.1.50',0))]",
        "workers=[threading.Thread(target=module.tool_result,args=('press',{'host':host,'keys':['Down']})) for host in ('roku.local','192.168.1.50')]",
        "[worker.start() for worker in workers]",
        "[worker.join() for worker in workers]",
        "assert maximum[0]==1",
        "resolved=['roku-a']",
        "module.resolve_target=lambda explicit=None: explicit or resolved[0]",
        "dispatched=[]",
        "def snapshot_call(name,arguments): resolved[0]='roku-b'; dispatched.append(module.RESOLVED_DEVICE_TARGET.get()); return {'command_succeeded':True,'stdout':'','stderr':''}",
        "module.call_tool=snapshot_call",
        "module.tool_result('press',{'keys':['Down']})",
        "assert dispatched==['roku-a']",
      ].join("\n"),
      serverPath,
      (() => {
        const longFlow = path.join(validationRoot, "long-flow.json");
        fs.writeFileSync(longFlow, JSON.stringify({ steps: [
          { action: "pause", seconds: 3600 },
          { action: "press", keys: Array(40).fill("Down"), delay: 10 },
          { action: "screenshot", save: "screen.jpg" },
        ] }));
        return longFlow;
      })(),
      path.join(validationRoot, "long-flow-evidence"),
      path.join(validationRoot, "server-temporary-root"),
    ],
    { encoding: "utf8" },
  );
  assert(serverBehavior.status === 0, `MCP text/artifact behavior validation failed: ${serverBehavior.stderr}`);
} finally {
  fs.rmSync(validationRoot, { recursive: true, force: true });
}

console.log(`Validated ${manifests.length} Roku plugins: ${skillRoots.length} skills, ${toolNames.size} MCP tools.`);
