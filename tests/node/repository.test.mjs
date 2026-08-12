import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildWindowsShimInvocation,
  commandStatus,
  requireSupportedNode,
} from "../../scripts/runtime-support.mjs";

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
  assert.ok(!metadata.files.includes("bin/"));
  assert.ok(metadata.files.includes("bin/roku-codex-toolkit.mjs"));
  assert.ok(!metadata.files.includes("plugins/"));
  assert.ok(metadata.files.every((name) => name !== "plugins/"));
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
    ["plugin", "100% ready", "%PATH%"],
  );
  assert.equal(
    invocation.commandLine,
    '\"\"%ROKU_TOOLKIT_SHIM_0%\" \"%ROKU_TOOLKIT_SHIM_1%\" \"%ROKU_TOOLKIT_SHIM_2%\" \"%ROKU_TOOLKIT_SHIM_3%\"\"',
  );
  assert.deepEqual(invocation.environment, {
    ROKU_TOOLKIT_SHIM_0: "C:\\work & tools\\codex.cmd",
    ROKU_TOOLKIT_SHIM_1: "plugin",
    ROKU_TOOLKIT_SHIM_2: "100% ready",
    ROKU_TOOLKIT_SHIM_3: "%PATH%",
  });
});

test("Windows shim execution preserves literal percent signs", { skip: process.platform !== "win32" }, () => {
  const temporary = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? process.cwd(), "roku-100%-"));
  try {
    const recorder = path.join(temporary, "record-args.mjs");
    const shim = path.join(temporary, "record.cmd");
    fs.writeFileSync(recorder, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${recorder}" %*\r\n`);
    const expected = ["100% ready", "%PATH%", "work & tools"];
    const result = commandStatus(shim, expected, { windowsShim: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), expected);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
