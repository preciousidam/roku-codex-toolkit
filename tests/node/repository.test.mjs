import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertSchemaValid, compileSchema } from "./schema-validator.mjs";
import {
  buildWindowsShimInvocation,
  commandStatus,
  requireSupportedNode,
} from "../../scripts/runtime-support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pluginRoots = ["roku-device-toolkit", "roku-engineering"].map((name) => path.join(root, "plugins", name));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function markdownFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(absolute);
    return entry.isFile() && entry.name.endsWith(".md") ? [absolute] : [];
  });
}

test("documentation links resolve and onboarding preserves public safety boundaries", () => {
  const markdown = [path.join(root, "README.md"), path.join(root, "CONTRIBUTING.md"), ...markdownFiles(path.join(root, "docs"))];
  for (const file of markdown) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (/^(?:https?:|mailto:|#)/.test(target)) continue;
      const [relative] = target.split("#", 1);
      assert.ok(fs.existsSync(path.resolve(path.dirname(file), relative)), `${path.relative(root, file)} -> ${target}`);
    }
  }

  const gettingStarted = fs.readFileSync(path.join(root, "docs", "getting-started.md"), "utf8");
  const troubleshooting = fs.readFileSync(path.join(root, "docs", "troubleshooting.md"), "utf8");
  assert.match(gettingStarted, /npx --yes roku-codex-toolkit@latest doctor/);
  assert.match(gettingStarted, /npx --yes roku-codex-toolkit@latest setup/);
  assert.match(gettingStarted, /ROKU_TOOLKIT_INTENTIONAL_MISSING_CHECKPOINT_7B2E/);
  assert.match(gettingStarted, /run first-intentional-failure\.json/);
  assert.match(gettingStarted, /successful screenshot capture proves only/i);
  assert.match(gettingStarted, /physical Roku required/i);
  assert.match(gettingStarted, /Network access.*Permissive/is);
  assert.doesNotMatch(gettingStarted, /(?:https?:\/\/)?(?:\d{1,3}\.){3}\d{1,3}/);
  assert.match(troubleshooting, /py -3/);
  assert.match(troubleshooting, /On Windows it probes `py -3`, `python`, then `python3`/);
  assert.match(troubleshooting, /Windows command shims/);
  assert.match(troubleshooting, /port `8060`/);
  assert.match(troubleshooting, /port `8085`/);
});

test("published-package smoke matrix preserves host-only release evidence", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8").replaceAll("\r\n", "\n");
  const publishWorkflow = fs.readFileSync(path.join(root, ".github", "workflows", "publish.yml"), "utf8").replaceAll("\r\n", "\n");
  const smokeJob = workflow.match(/^  published-package-smoke:\n([\s\S]*?)(?=^  [a-z][a-z-]+:\n|(?![\s\S]))/m)?.[0] ?? "";
  const publishedSmokeJob = publishWorkflow.match(/^  published-package-smoke:\n([\s\S]*?)(?=^  [a-z][a-z-]+:\n|(?![\s\S]))/m)?.[0] ?? "";
  const script = fs.readFileSync(path.join(root, "scripts", "smoke-published-package.mjs"), "utf8");
  const report = fs.readFileSync(path.join(root, "docs", "clean-install-smoke.md"), "utf8");
  const metadata = readJson(path.join(root, "package.json"));
  assert.match(smokeJob, /os: ubuntu-latest/);
  assert.match(smokeJob, /os: macos-latest/);
  assert.match(smokeJob, /os: windows-latest/);
  assert.match(smokeJob, /node: 18[\s\S]*python: "3\.9"/);
  assert.match(smokeJob, /smoke-published-package\.mjs --version 0\.2\.0/);
  assert.match(publishedSmokeJob, /needs: publish/);
  assert.match(publishedSmokeJob, /smoke-published-package\.mjs --version/);
  assert.match(publishWorkflow, /smoke-published-package\.mjs --version[^\n]+--check-contract[\s\S]*npm publish/);
  assert.match(script, /publishedContracts/);
  assert.match(script, /"0\.2\.0": \{[\s\S]*toolNames:/);
  assert.match(script, /"0\.3\.0": \{[\s\S]*toolNames:/);
  assert.match(script, /No published-package contract is defined/);
  assert.match(script, /Published-package contract \$\{version\} matches \$\{toolCount\} checkout tools/);
  assert.match(script, /new Set\(toolNames\)\.size !== expectedToolNames\.length/);
  assert.match(script, /doctorLines\.length !== expectedDoctorChecks\.length/);
  assert.match(script, /terminateProcessTree\(\)/);
  assert.match(script, /taskkill/);
  assert.match(script, /process\.kill\(-child\.pid, "SIGTERM"\)/);
  assert.match(script, /await terminateProcessTree\(\);\s*throw new Error\(`Packaged MCP initialize returned an invalid result/);
  assert.match(script, /npm_config_ignore_scripts: "true"/);
  assert.match(script, /"-c", "core\.autocrlf=false",\s*"clone",[\s\S]*"--branch", `v\$\{version\}`/);
  for (const runtimeTree of ["bin", "scripts"]) {
    assert.match(script, new RegExp(`assertIdenticalPackagedTree\\(installedRoot, taggedCheckout, metadata, "${runtimeTree}"\\)`));
  }
  assert.match(script, /assertIdenticalTree\(installedRoot, taggedCheckout, "plugins"\)/);
  assert.ok(script.includes("Published npm ${relative} inventory differs from package.json files"));
  assert.match(script, /taggedMcpTools: taggedToolCount/);
  assert.match(script, /Packaged MCP launcher emitted malformed JSON/);
  assert.match(script, /Packaged MCP launcher emitted an unsolicited response/);
  assert.doesNotMatch(script, /const responses = new Map/);
  assert.match(script, /message === null \|\| typeof message !== "object" \|\| Array\.isArray\(message\)/);
  assert.match(script, /initializeResult\?\.protocolVersion !== "2025-06-18"/);
  assert.match(script, /typeof initializeResult\.capabilities\.tools !== "object"/);
  assert.match(script, /expected\.some\(\(command\) => JSON\.stringify\(args\) === JSON\.stringify\(command\)\)/);
  assert.match(script, /"dependencies", "optionalDependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"/);
  assert.match(script, /message\.jsonrpc !== "2\.0"/);
  assert.match(script, /hasResult === hasError/);
  assert.match(script, /if \(protocolFailure\) throw await protocolFailure/);
  assert.match(script, /tool\.inputSchema\.type !== "object"/);
  assert.match(script, /Packaged MCP server exposed invalid tool descriptors/);
  assert.match(script, /schemaValidator\.compile\(tool\.inputSchema\)/);
  assert.match(script, /Packaged MCP tool \$\{tool\.name\} exposed an invalid input schema/);
  assert.match(script, /waitForPublishedPackage/);
  assert.match(script, /assertMarketplaceManifest\(taggedCheckout/);
  assert.match(script, /Packaged MCP launcher did not exit after stdin closed/);
  assert.match(script, /method: "notifications\/initialized"/);
  assert.match(script, /protocolVersion: "2025-06-18"/);
  assert.match(script, /ROKU_SMOKE_ALLOW_REMOVALS !== "1"/);
  assert.match(script, /state\.marketplace\?\.name !== "roku-codex-toolkit"/);
  assert.match(script, /child\.stdin\.on\("error"/);
  assert.match(script, /roku-device-toolkit@roku-codex-toolkit/);
  assert.match(script, /JSON\.stringify\(args\) !== JSON\.stringify\(expected\)/);
  assert.match(script, /assertDeviceConfigAbsent\(\)/);
  assert.match(script, /async function terminateChildTree/);
  assert.match(script, /await terminateChildTree\(child, exit\)/);
  assert.match(script, /marketplace\.ref !== `v\$\{version\}`/);
  assert.match(script, /lifecycleScriptsAbsent: "pass"/);
  assert.match(script, /Published package defines an unexpected implicit node-gyp install hook/);
  assert.match(script, /metadata\.engines\.node !== ">=18"/);
  assert.match(script, /metadata\.engines\.python !== ">=3\.9"/);
  assert.match(script, /Published package declares unexpected runtime engines/);
  assert.match(script, /Object\.keys\(metadata\.bin \?\? \{\}\)\.join\(","\) !== packageName/);
  assert.match(script, /Published package declares unexpected executable mappings/);
  assert.match(report, /manual Codex confirmation/i);
  assert.match(report, /Physical Roku evidence[\s\S]*Not in scope/i);
  assert.doesNotMatch(report, /(?:https?:\/\/)?(?:\d{1,3}\.){3}\d{1,3}/);
  assert.ok(!metadata.files.includes("scripts/smoke-published-package.mjs"));

  const orchestrator = fs.readFileSync(path.join(root, "scripts", "validate-roku-toolkit.mjs"), "utf8");
  assert.match(orchestrator, /if \(!nodeOnly && !pythonOnly\) \{[\s\S]*smoke-published-package\.mjs[\s\S]*--check-contract/);
  const smokeScript = path.join(root, "scripts", "smoke-published-package.mjs");
  const unknownContract = spawnSync(
    process.execPath,
    [smokeScript, "--version", "99.0.0", "--check-contract"],
    { encoding: "utf8" },
  );
  assert.notEqual(unknownContract.status, 0);
  assert.match(unknownContract.stderr, /No published-package contract is defined for 99\.0\.0/);
});

test("packed-package doctor coverage avoids ambient Windows Codex installations", () => {
  const script = fs.readFileSync(path.join(root, "scripts", "test-packed-package.mjs"), "utf8");
  const doctorInvocations = [...script.matchAll(/\[cli, "doctor"([^\]]*)\]/g)];
  assert.ok(doctorInvocations.some((invocation) => /"--no-codex"/.test(invocation[1])));
  assert.ok(doctorInvocations.some((invocation) => invocation[1] === ""));
  assert.match(script, /if \(process\.platform !== "win32"\)/);
});

test("marketplace entries resolve portably to valid plugin manifests", () => {
  const marketplace = readJson(path.join(root, ".agents/plugins/marketplace.json"));
  assert.equal(marketplace.name, "roku-codex-toolkit");
  for (const pluginRoot of pluginRoots) {
    const manifest = readJson(path.join(pluginRoot, ".codex-plugin/plugin.json"));
    const entry = marketplace.plugins.find((item) => item.name === manifest.name);
    assert.ok(entry);
    assert.equal(entry.source.path, `./plugins/${manifest.name}`);
    assert.equal(path.resolve(root, entry.source.path), pluginRoot);
    assert.match(manifest.version, /^\d+\.\d+\.\d+(?:\+codex\.[0-9A-Za-z.-]+)?$/);
  }
});

test("five skills have valid frontmatter", () => {
  const skills = pluginRoots.flatMap((pluginRoot) => fs.readdirSync(path.join(pluginRoot, "skills"))
    .map((name) => path.join(pluginRoot, "skills", name, "SKILL.md")));
  assert.equal(skills.length, 5);
  for (const file of skills) {
    const source = fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n");
    assert.ok(source.startsWith("---\n"));
    assert.match(source, /\nname: [a-z0-9-]+\n/);
    assert.match(source, /\ndescription: .+\n/);
  }
});

test("device plugin exposes the portable launcher", () => {
  const config = readJson(path.join(pluginRoots[0], ".mcp.json"));
  assert.deepEqual(config.mcpServers["roku-device"].args, ["./scripts/launch-mcp.mjs"]);
  assert.equal(config.mcpServers["roku-device"].cwd, ".");
  assert.equal(config.mcpServers["roku-device"].command, "node");
  const launcher = fs.readFileSync(path.join(pluginRoots[0], "scripts", "launch-mcp.mjs"), "utf8");
  assert.match(launcher, /PYTHONDONTWRITEBYTECODE: "1"/);
});

test("public plugin metadata references sanitized reusable assets", () => {
  for (const pluginRoot of pluginRoots) {
    const manifest = readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"));
    assert.equal(manifest.license, "Apache-2.0");
    assert.match(manifest.interface.websiteURL, /^https:\/\//);
    assert.ok(manifest.interface.defaultPrompt.length <= 3);
    assert.ok(manifest.interface.defaultPrompt.every((prompt) => prompt.length <= 128));
    for (const relative of [
      manifest.interface.composerIcon,
      manifest.interface.logo,
      ...manifest.interface.screenshots,
    ]) {
      assert.match(relative, /^\.\/assets\/.+\.png$/);
      const asset = path.resolve(pluginRoot, relative);
      assert.ok(fs.statSync(asset).isFile(), asset);
      assert.deepEqual(fs.readFileSync(asset).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
  }
  const presentation = fs.readFileSync(path.join(root, "docs", "marketplace.md"), "utf8");
  assert.match(presentation, /two plugins[\s\S]*five skills[\s\S]*13 MCP tools/i);
  assert.match(presentation, /not claim physical Roku coverage/i);
  assert.match(presentation, /does not\s+replace an editor/i);
  assert.doesNotMatch(presentation, /(?:https?:\/\/)?(?:\d{1,3}\.){3}\d{1,3}/);
});

test("flow schemas and examples expose stable public contracts", () => {
  const references = path.join(pluginRoots[0], "skills", "roku-flow-verifier", "references");
  const scenarioSchema = readJson(path.join(references, "flow-scenario.schema.json"));
  const reportSchema = readJson(path.join(references, "flow-report.schema.json"));
  const validateScenario = compileSchema(scenarioSchema);
  const validateReport = compileSchema(reportSchema);
  assert.equal(scenarioSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.match(scenarioSchema.$comment, /--dry-run/);
  assert.equal(reportSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(
    new Set(scenarioSchema.$defs.query.properties.kind.enum),
    new Set(["info", "apps", "active-app", "player"]),
  );
  assert.deepEqual(
    new Set(reportSchema.$defs.stepResult.properties.status.enum),
    new Set(["passed", "failed", "skipped", "invalid", "pending_visual_review"]),
  );
  assert.ok(reportSchema.$defs.stepResult.required.includes("action"));
  assert.ok(reportSchema.$defs.stepResult.required.includes("checkpoint"));
  const baseReport = {
    name: "flow", host: "roku.local", dry_run: false, verified: true,
    checkpoint_count: 1, screenshot_count: 0, pending_visual_review: false,
    passed: true,
    steps: [{
      index: 1, action: "query", checkpoint: true, passed: true,
      status: "passed", return_code: 0, duration_seconds: 0,
    }],
  };
  assertSchemaValid(validateReport, baseReport, "consistent passed report");
  for (const invalid of [
    { ...baseReport, dry_run: true },
    { ...baseReport, verified: false },
    { ...baseReport, pending_visual_review: true },
    { ...baseReport, verification_error: "contradiction" },
    { ...baseReport, name: "" },
    { ...baseReport, name: "   " },
    { ...baseReport, host: "" },
    { ...baseReport, host: "   " },
    { ...baseReport, passed: false },
    { ...baseReport, pending_visual_review: undefined },
    { ...baseReport, steps: [{ ...baseReport.steps[0], passed: false }] },
    { ...baseReport, steps: [{ ...baseReport.steps[0], status: "failed" }] },
    {
      ...baseReport,
      steps: [
        baseReport.steps[0],
        { ...baseReport.steps[0], index: 2, passed: false, status: "failed" },
      ],
    },
    {
      ...baseReport,
      passed: false,
      steps: [{ ...baseReport.steps[0], checkpoint: false, passed: false, status: "failed" }],
    },
    { ...baseReport, passed: false, dry_run: true },
    {
      ...baseReport,
      passed: false,
      pending_visual_review: false,
      steps: [{
        index: 1, action: "screenshot", checkpoint: false, passed: false,
        status: "pending_visual_review", duration_seconds: 0,
      }],
    },
    {
      ...baseReport,
      steps: [{ ...baseReport.steps[0], action: "screenshot" }],
    },
    {
      ...baseReport,
      steps: [{ ...baseReport.steps[0], action: "screenshot", checkpoint: false }],
    },
    { ...baseReport, passed: false, verified: false },
    { ...baseReport, passed: false, verified: false, dry_run: true },
    { ...baseReport, passed: false, verified: false, steps: [] },
    { ...baseReport, checkpoint_count: 0 },
    {
      ...baseReport,
      passed: false,
      verified: false,
      checkpoint_count: 0,
      verification_error: "",
    },
    { ...baseReport, steps: [{ ...baseReport.steps[0], return_code: 1 }] },
    { ...baseReport, steps: [{ ...baseReport.steps[0], return_code: undefined }] },
    {
      ...baseReport,
      passed: false,
      verified: false,
      pending_visual_review: true,
      steps: [{ ...baseReport.steps[0], passed: false, status: "failed" }],
    },
    {
      ...baseReport,
      passed: false,
      verified: false,
      pending_visual_review: true,
      steps: [{
        index: 1, action: "launch", checkpoint: false, passed: false,
        status: "pending_visual_review", duration_seconds: 0,
      }],
    },
    {
      ...baseReport,
      passed: false,
      verified: false,
      screenshot_count: 1,
      pending_visual_review: true,
      verification_error: "Captured screenshots still require visual review.",
      steps: [{
        index: 1, action: "screenshot", checkpoint: false, passed: false,
        status: "pending_visual_review", duration_seconds: 0,
        artifact: "/tmp/screen.png", capture_succeeded: true, visual_review_required: true,
      }],
    },
    {
      ...baseReport,
      passed: false,
      verified: false,
      screenshot_count: 1,
      pending_visual_review: true,
      verification_error: "Captured screenshots still require visual review.",
      steps: [{
        index: 1, action: "screenshot", checkpoint: false, passed: false,
        status: "pending_visual_review", return_code: 1, duration_seconds: 0,
        artifact: "/tmp/screen.png", capture_succeeded: true, visual_review_required: true,
      }],
    },
    {
      ...baseReport,
      passed: false,
      verified: false,
      dry_run: true,
      steps: [{
        index: 1, action: "launch", checkpoint: false, passed: false,
        status: "failed", duration_seconds: 0,
      }],
    },
    {
      ...baseReport,
      passed: false,
      verified: false,
      steps: [{
        index: 1, action: "launch", checkpoint: false, passed: false,
        status: "invalid", duration_seconds: 0,
      }],
    },
    {
      ...baseReport,
      passed: false,
      verified: false,
      steps: [{
        index: 1, action: "bogus", checkpoint: false, passed: false,
        status: "failed", duration_seconds: 0,
      }],
    },
    {
      ...baseReport,
      passed: false,
      verified: false,
      checkpoint_count: 0,
      screenshot_count: 0,
      pending_visual_review: true,
      steps: [{
        index: 1, action: "screenshot", checkpoint: false, passed: false,
        status: "pending_visual_review", duration_seconds: 0,
      }],
    },
    {
      ...baseReport,
      steps: [baseReport.steps[0], {
        index: 2, action: null, checkpoint: false, passed: true,
        status: "passed", duration_seconds: 0,
      }],
    },
  ]) {
    if (invalid.pending_visual_review === undefined) delete invalid.pending_visual_review;
    assert.equal(validateReport(invalid), false, JSON.stringify(invalid));
  }
  assertSchemaValid(validateReport, {
    ...baseReport,
    passed: false,
    verified: false,
    screenshot_count: 1,
    pending_visual_review: true,
    verification_error: "Captured screenshots still require visual review.",
    steps: [{
      index: 1, action: "screenshot", checkpoint: false, passed: false,
      status: "pending_visual_review", return_code: 0, duration_seconds: 0,
      artifact: "/tmp/screen.png", capture_succeeded: true, visual_review_required: true,
    }],
  }, "pending screenshot report");
  const pendingWithoutExplanation = {
    ...baseReport,
    passed: false,
    screenshot_count: 1,
    pending_visual_review: true,
    steps: [{
      index: 1, action: "query", checkpoint: true, passed: true,
      status: "passed", return_code: 0, duration_seconds: 0,
    }, {
      index: 2, action: "screenshot", checkpoint: false, passed: false,
      status: "pending_visual_review", return_code: 0, duration_seconds: 0,
      artifact: "/tmp/screen.png", capture_succeeded: true, visual_review_required: true,
    }],
  };
  assert.equal(validateReport(pendingWithoutExplanation), false);
  for (const name of fs.readdirSync(path.join(root, "examples", "flow"))) {
    const example = readJson(path.join(root, "examples", "flow", name));
    assertSchemaValid(validateScenario, example, name);
  }
  for (const save of [
    "../escape.jpg", "/tmp/output.jpg", "C:\\output.jpg", "report.json",
    "./report.json", ".\\report.json", "././REPORT.JSON", ".//report.json",
    ".\\\\REPORT.JSON", "report.jſon", "./REPORT.JſON", "./.", ".\\.", ".//.",
    "query\u0000.xml", "screen\u0000.jpg",
    "screen?.jpg", "screen<1>.jpg", "folder|name/screen.jpg", "folder/name. ",
    "CON.jpg", "aux", "nested/PRN.xml", "nested\\LPT9.png",
    "COM¹.png", "nested/COM².jpg", "nested\\LPT³.png",
    "CONIN$.jpg", "CONOUT$.png", "CON .txt", "nested/PRN .xml",
    "screen\uD800.png", "nested/screen\uDFFF.jpg",
    "\u00a0",
  ]) {
    const invalid = {
      steps: [{ action: "query", kind: "active-app", contains: "dev", save }],
    };
    assert.equal(validateScenario(invalid), false, save);
  }
  for (const save of [
    "screen.jpg", "screen.JPEG", "screen.png", "screen.PNG", "./screen.png",
    "nested/screens/screen-01.png", "nested\\screens\\screen_01.jpg",
    ".screen.png", "capture\u2028one.png", "capture\u2029one.jpg",
  ]) {
    const valid = { steps: [{ action: "screenshot", save }] };
    assertSchemaValid(validateScenario, valid, save);
  }
  for (const save of [
    "screen.gif", "screen.bmp", "screen.png.tmp", "screen\u0000.jpg",
    ".jpg", ".jpeg", ".png", "..jpg", "...png",
    "captures/.png", "captures\\.jpg", "captures/..png", "captures\\...jpg",
    "screen.png/", "screen.png/.", "screen.jpg\\", "screen.jpg\\.",
  ]) {
    const invalid = { steps: [{ action: "screenshot", save }] };
    assert.equal(validateScenario(invalid), false, save);
  }
  for (const host of [
    "roku.local", "roku.local.", "192.168.1.50", " roku.local ", "\tdevice.local\n",
  ]) {
    const valid = { host, steps: [{ action: "screenshot", save: "screen.png" }] };
    assertSchemaValid(validateScenario, valid, host);
  }
  assertSchemaValid(validateScenario, {
    host: null,
    steps: [{ action: "screenshot", save: "screen.png" }],
  }, "nullable host");
  assertSchemaValid(validateScenario, {
    name: "\uFEFF",
    steps: [{ action: "screenshot", save: "screen.png" }],
  }, "Python-nonblank byte order mark");
  assertSchemaValid(validateScenario, {
    name: "flow\u0000name",
    steps: [
      { action: "query", kind: "active-app", contains: "dev\u0000" },
      { action: "screenshot", save: "screen.png" },
    ],
  }, "control characters in non-command metadata");
  for (const host of [
    "", "http://roku.local", "roku.local:8060", "roku.local/path",
    "roku.local?query", "roku.local#fragment", "user@roku.local", "\u001c", "\u00a0",
    "roku\u0000.local", "roku local", "roku\tlocal", "roku\u0001.local",
    "[roku.local", "roku.local]", "roku_local", "-", ".", "roku..local",
    "-roku.local", "roku-.local", ".roku.local",
  ]) {
    const invalid = { host, steps: [{ action: "screenshot", save: "screen.png" }] };
    assert.equal(validateScenario(invalid), false, host);
  }
  for (const invalid of [
    { name: "\u001c", steps: [{ action: "screenshot", save: "screen.png" }] },
    { steps: [{ action: "query", kind: "active-app", contains: "\u001d" }] },
    { steps: [{ action: "launch", channel_id: "\u001e" }, { action: "screenshot", save: "screen.png" }] },
    { steps: [{ action: "press", keys: ["\u001f"] }, { action: "screenshot", save: "screen.png" }] },
    { steps: [{ action: "launch", channel_id: "dev\u0000" }, { action: "screenshot", save: "screen.png" }] },
    { steps: [{ action: "press", keys: ["Home\u0000"] }, { action: "screenshot", save: "screen.png" }] },
    { steps: [{ action: "text", value: "hello\u0000" }, { action: "screenshot", save: "screen.png" }] },
    { steps: [{ action: "launch", channel_id: "dev", content_id: "item\u0000" }, { action: "screenshot", save: "screen.png" }] },
    { steps: [{ action: "launch", channel_id: "dev", media_type: "movie\u0000" }, { action: "screenshot", save: "screen.png" }] },
    { steps: [{ action: "launch", channel_id: "dev\uD800" }, { action: "screenshot", save: "screen.png" }] },
    { steps: [{ action: "press", keys: ["Home\uDFFF"] }, { action: "screenshot", save: "screen.png" }] },
    { steps: [{ action: "text", value: "hello\uD800" }, { action: "screenshot", save: "screen.png" }] },
    { steps: [{ action: "launch", channel_id: "dev", content_id: "item\uDFFF" }, { action: "screenshot", save: "screen.png" }] },
    { steps: [{ action: "launch", channel_id: "dev", media_type: "movie\uD800" }, { action: "screenshot", save: "screen.png" }] },
  ]) {
    assert.equal(validateScenario(invalid), false, JSON.stringify(invalid));
  }
  assertSchemaValid(validateScenario, {
    steps: [
      { action: "launch", channel_id: "dev", content_id: null, media_type: null },
      { action: "screenshot", save: "screen.png" },
    ],
  }, "nullable launch metadata");
  for (const metadata of [
    { content_id: 123 }, { content_id: {} }, { media_type: 123 }, { media_type: {} },
  ]) {
    const invalid = {
      steps: [
        { action: "launch", channel_id: "dev", ...metadata },
        { action: "screenshot", save: "screen.png" },
      ],
    };
    assert.equal(validateScenario(invalid), false, JSON.stringify(metadata));
  }
});

test("npm metadata exposes a side-effect-free public CLI package", () => {
  const metadata = readJson(path.join(root, "package.json"));
  assert.equal(metadata.private, undefined);
  assert.equal(metadata.bin["roku-codex-toolkit"], "./bin/roku-codex-toolkit.mjs");
  assert.equal(metadata.publishConfig.access, "public");
  assert.equal(metadata.publishConfig.provenance, true);
  assert.equal(metadata.scripts.postinstall, undefined);
  assert.ok(!metadata.files.includes("bin/"));
  assert.ok(metadata.files.includes("bin/roku-codex-toolkit.mjs"));
  assert.ok(!metadata.files.includes("plugins/"));
  const trackedPluginFiles = execFileSync("git", ["ls-files", "--", "plugins"], {
    cwd: root,
    encoding: "utf8",
  }).trim().split(/\r?\n/).filter(Boolean);
  for (const file of trackedPluginFiles) {
    assert.ok(metadata.files.includes(file), `package inventory omits ${file}`);
  }
  assert.ok(!metadata.files.includes("tests/"));
  for (const pluginRoot of pluginRoots) {
    assert.equal(readJson(path.join(pluginRoot, ".codex-plugin/plugin.json")).version, metadata.version);
  }
  assert.match(
    fs.readFileSync(path.join(pluginRoots[0], "mcp", "server.py"), "utf8"),
    /"serverInfo": \{"name": "roku-device-toolkit", "version": PLUGIN_VERSION\}/,
  );
});

test("release metadata and publication workflow enforce a single version", () => {
  const metadata = readJson(path.join(root, "package.json"));
  const releaseTag = `v${metadata.version}`;
  assert.doesNotThrow(() => execFileSync(
    process.execPath,
    [path.join(root, "scripts", "verify-release.mjs"), releaseTag],
    { cwd: root, encoding: "utf8", stdio: "pipe" },
  ));
  assert.throws(() => execFileSync(
    process.execPath,
    [path.join(root, "scripts", "verify-release.mjs"), "v9.9.9"],
    { cwd: root, encoding: "utf8", stdio: "pipe" },
  ));

  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "publish.yml"), "utf8");
  assert.match(workflow, /release:\s*\n\s+types: \[published\]/);
  assert.match(workflow, /environment: npm/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /!github\.event\.release\.prerelease/);
  assert.doesNotMatch(workflow, /ref: \$\{\{ github\.event\.release\.tag_name \}\}/);
  assert.match(workflow, /RELEASE_TAG: \$\{\{ github\.event\.release\.tag_name \}\}/);
  assert.match(workflow, /npm run verify:release -- "\$RELEASE_TAG"/);
  assert.doesNotMatch(workflow, /run:.*\$\{\{ github\.event\.release\.tag_name \}\}/);
  assert.match(workflow, /npm publish --access public/);
});

test("setup runtime rejects unsupported Node versions", () => {
  const original = process.versions.node;
  Object.defineProperty(process.versions, "node", { configurable: true, value: "17.9.1" });
  try {
    assert.throws(() => requireSupportedNode(), /Node\.js 18 or newer/);
  } finally {
    Object.defineProperty(process.versions, "node", { configurable: true, value: original });
  }
});

test("Windows shim arguments use fixed environment placeholders", () => {
  const invocation = buildWindowsShimInvocation(
    "C:\\work & tools\\codex.cmd",
    ["plugin", "100% ready"],
  );
  assert.equal(
    invocation.script,
    "$rokuToolkitArgs = @($env:ROKU_TOOLKIT_SHIM_1, $env:ROKU_TOOLKIT_SHIM_2); & $env:ROKU_TOOLKIT_SHIM_0 @rokuToolkitArgs",
  );
  assert.deepEqual(invocation.environment, {
    ROKU_TOOLKIT_SHIM_0: "C:\\work & tools\\codex.cmd",
    ROKU_TOOLKIT_SHIM_1: "plugin",
    ROKU_TOOLKIT_SHIM_2: "100% ready",
  });
});

test("Windows shim execution preserves literal percent signs", { skip: process.platform !== "win32" }, () => {
  const temporary = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? process.cwd(), "roku-shim-"));
  try {
    const recorder = path.join(temporary, "record-args.mjs");
    const shimDirectory = path.join(temporary, "100% & tools");
    fs.mkdirSync(shimDirectory);
    const shim = path.join(shimDirectory, "record.cmd");
    fs.writeFileSync(recorder, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${recorder}" %*\r\n`);
    const expected = ["100% ready", "work & tools"];
    const result = commandStatus(shim, expected, { windowsShim: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), expected);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
