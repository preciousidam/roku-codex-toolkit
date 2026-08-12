import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { quoteWindowsCommandArg, requireSupportedNode } from "../../scripts/runtime-support.mjs";

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

test("npm metadata exposes a side-effect-free public CLI package", () => {
  const metadata = readJson(path.join(root, "package.json"));
  assert.equal(metadata.private, undefined);
  assert.equal(metadata.bin["roku-codex-toolkit"], "./bin/roku-codex-toolkit.mjs");
  assert.equal(metadata.publishConfig.access, "public");
  assert.equal(metadata.publishConfig.provenance, true);
  assert.equal(metadata.scripts.postinstall, undefined);
  assert.ok(metadata.files.includes("plugins/"));
  assert.ok(!metadata.files.includes("tests/"));
  for (const pluginRoot of pluginRoots) {
    assert.equal(readJson(path.join(pluginRoot, ".codex-plugin/plugin.json")).version, metadata.version);
  }
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

test("Windows shim arguments are quoted as one literal command", () => {
  assert.equal(quoteWindowsCommandArg("C:\\work & tools\\plugin"), '"C:\\work & tools\\plugin"');
  assert.equal(quoteWindowsCommandArg("100% ready"), '"100%% ready"');
  assert.equal(quoteWindowsCommandArg('say "hello"'), '"say \\"hello\\""');
});
