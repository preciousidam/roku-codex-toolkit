#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "roku-toolkit-package-"));
const packageTestEnv = { ...process.env, npm_config_cache: path.join(temporary, "npm-cache") };
const npmCommand = process.platform === "win32" ? process.execPath : "npm";
const npmPrefix = process.platform === "win32"
  ? [process.env.npm_execpath ?? ""]
  : [];
if (process.platform === "win32" && !npmPrefix[0]) {
  throw new Error("npm_execpath is required to run packed-package tests on Windows.");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: options.env ?? packageTestEnv,
    timeout: 60_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

function runExpectFailure(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: options.env ?? packageTestEnv,
    timeout: 60_000,
  });
  if (result.error || result.status === 0) {
    throw new Error(`${command} ${args.join(" ")} unexpectedly succeeded or could not run.`);
  }
  return result;
}

try {
  const packed = JSON.parse(run(
    npmCommand,
    [...npmPrefix, "pack", "--json", "--pack-destination", temporary],
  ).stdout)[0];
  const names = new Set(packed.files.map((file) => file.path.replaceAll("\\", "/")));
  for (const required of [
    "package.json",
    "bin/roku-codex-toolkit.mjs",
    ".agents/plugins/marketplace.json",
    "plugins/roku-device-toolkit/mcp/server.py",
    "plugins/roku-engineering/.codex-plugin/plugin.json",
  ]) {
    if (!names.has(required)) throw new Error(`Packed tarball is missing ${required}`);
  }
  for (const name of names) {
    if (/^(tests|\.github|docs)\//.test(name) || /(^|\/)(__pycache__|node_modules|evidence|artifacts)(\/|$)/.test(name)) {
      throw new Error(`Development-only path leaked into tarball: ${name}`);
    }
    if (/\.(?:log|pyc)$/.test(name)) throw new Error(`Unsafe artifact leaked into tarball: ${name}`);
  }

  const prefix = path.join(temporary, "install");
  const tarball = path.join(temporary, packed.filename);
  run(npmCommand, [
    ...npmPrefix,
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix, tarball,
  ]);
  const installedRoot = path.join(prefix, "node_modules", "roku-codex-toolkit");
  const cli = path.join(installedRoot, "bin", "roku-codex-toolkit.mjs");
  run(process.execPath, [cli, "doctor", "--no-codex"], { cwd: temporary });
  run(process.execPath, [cli, "validate"], { cwd: temporary });

  const fakeBin = path.join(temporary, "bin");
  fs.mkdirSync(fakeBin);
  const fakeScript = path.join(fakeBin, "fake-codex.mjs");
  const commandLog = path.join(temporary, "codex-commands.jsonl");
  fs.writeFileSync(fakeScript, `import fs from "node:fs";\nfs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(fakeBin, "codex.cmd"), `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`);
  } else {
    const shim = path.join(fakeBin, "codex");
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`, { mode: 0o755 });
  }
  const delimiter = process.platform === "win32" ? ";" : ":";
  const missingPython = runExpectFailure(process.execPath, [cli, "setup", "--skip-config"], {
    cwd: temporary,
    env: { ...packageTestEnv, PATH: fakeBin, FAKE_CODEX_LOG: commandLog },
  });
  if (!`${missingPython.stdout}\n${missingPython.stderr}`.includes("Python 3.9 or newer is required")) {
    throw new Error("Missing Python did not produce the expected setup diagnostic.");
  }
  if (fs.existsSync(commandLog)) {
    throw new Error("Setup changed Codex state before completing its Python preflight.");
  }
  run(process.execPath, [cli, "setup", "--skip-config"], {
    cwd: temporary,
    env: {
      ...packageTestEnv,
      PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
      FAKE_CODEX_LOG: commandLog,
    },
  });
  const calls = fs.readFileSync(commandLog, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  if (!calls.some((args) => args.join(" ") === "plugin marketplace list")) {
    throw new Error("Packed setup did not inspect Codex marketplaces.");
  }
  if (calls.filter((args) => args[0] === "plugin" && args[1] === "add").length !== 2) {
    throw new Error("Packed setup did not install both plugins.");
  }
  console.log(`Packed tarball validation passed (${packed.files.length} files, ${packed.size} bytes).`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
