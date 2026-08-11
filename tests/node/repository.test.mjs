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
  assert.equal(reportSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(
    new Set(scenarioSchema.$defs.query.properties.kind.enum),
    new Set(["info", "apps", "active-app", "player"]),
  );
  assert.deepEqual(
    new Set(reportSchema.$defs.stepResult.properties.status.enum),
    new Set(["passed", "failed", "skipped", "invalid", "pending_visual_review"]),
  );
  for (const name of fs.readdirSync(path.join(root, "examples", "flow"))) {
    const example = readJson(path.join(root, "examples", "flow", name));
    assertSchemaValid(validateScenario, example, name);
  }
  for (const save of ["../escape.jpg", "/tmp/output.jpg", "C:\\output.jpg", "report.json"]) {
    const invalid = {
      steps: [{ action: "query", kind: "active-app", contains: "dev", save }],
    };
    assert.equal(validateScenario(invalid), false, save);
  }
  for (const save of ["screen.jpg", "screen.JPEG", "screen.png", "screen.PNG"]) {
    const valid = { steps: [{ action: "screenshot", save }] };
    assertSchemaValid(validateScenario, valid, save);
  }
  for (const save of ["screen.gif", "screen.bmp", "screen.png.tmp"]) {
    const invalid = { steps: [{ action: "screenshot", save }] };
    assert.equal(validateScenario(invalid), false, save);
  }
});
