import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertSchemaValid, compileSchema } from "./schema-validator.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const pluginRoots = ["roku-device-toolkit", "roku-engineering"].map((name) => path.join(root, "plugins", name));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

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
});

test("flow schemas and examples expose stable public contracts", () => {
  const references = path.join(pluginRoots[0], "skills", "roku-flow-verifier", "references");
  const scenarioSchema = readJson(path.join(references, "flow-scenario.schema.json"));
  const reportSchema = readJson(path.join(references, "flow-report.schema.json"));
  const validateScenario = compileSchema(scenarioSchema);
  compileSchema(reportSchema);
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
  ]) {
    const invalid = { steps: [{ action: "screenshot", save }] };
    assert.equal(validateScenario(invalid), false, save);
  }
  for (const host of ["roku.local", "192.168.1.50", " roku.local ", "\tdevice.local\n"]) {
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
  for (const host of [
    "", "http://roku.local", "roku.local:8060", "roku.local/path",
    "roku.local?query", "roku.local#fragment", "user@roku.local", "\u001c", "\u00a0",
    "roku\u0000.local", "roku local", "roku\tlocal", "roku\u0001.local",
    "[roku.local", "roku.local]", "roku_local",
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
