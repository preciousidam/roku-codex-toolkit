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
const packRoot = path.join(temporary, "source");

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
  fs.cpSync(root, packRoot, {
    recursive: true,
    filter: (source) => ![".git", "node_modules"].includes(path.basename(source)),
  });
  for (const fixture of [
    path.join(packRoot, "plugins", "roku-device-toolkit", "mcp", "__pycache__", "secret.pyc"),
    path.join(packRoot, "plugins", "roku-device-toolkit", "mcp", "evidence", "private.log"),
    path.join(packRoot, "plugins", "roku-device-toolkit", "config.json"),
    path.join(packRoot, "plugins", "roku-device-toolkit", "private-target.json"),
    path.join(packRoot, "plugins", "roku-device-toolkit", "roku-screenshot.jpg"),
    path.join(packRoot, "plugins", "roku-device-toolkit", "captured-screen.png"),
  ]) {
    fs.mkdirSync(path.dirname(fixture), { recursive: true });
    fs.writeFileSync(fixture, "must not ship");
  }
  const packed = JSON.parse(run(
    npmCommand,
    [...npmPrefix, "pack", "--json", "--pack-destination", temporary],
    { cwd: packRoot },
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
    if (/\.(?:log|pyc|jpe?g|png)$/i.test(name) || /(^|\/)(?:config|private-target)\.json$/.test(name)) {
      throw new Error(`Unsafe artifact leaked into tarball: ${name}`);
    }
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
  const fakeGitScript = path.join(fakeBin, "fake-git.mjs");
  const commandLog = path.join(temporary, "codex-commands.jsonl");
  fs.writeFileSync(fakeScript, `import fs from "node:fs";\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(args) + "\\n");\nif (args[0] === "--version" || args.join(" ") === "plugin marketplace --help") console.log("codex-test");\nif (args.join(" ") === "plugin marketplace list --json") {\n  if (process.env.FAIL_LIST === "1") process.exit(1);\n  const marketplaces = process.env.FAKE_EXISTING === "1" ? [{name: "roku-codex-toolkit", marketplaceSource: {sourceType: "local", source: "/previous"}}] : [];\n  console.log(JSON.stringify({marketplaces}));\n}\nif (process.env.FAIL_REMOTE === "1" && args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add" && args[3] === "preciousidam/roku-codex-toolkit") process.exit(1);\n`);
  fs.writeFileSync(fakeGitScript, "process.exit(0);\n");
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(fakeBin, "codex.cmd"), `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`);
    fs.writeFileSync(path.join(fakeBin, "git.cmd"), `@echo off\r\n"${process.execPath}" "${fakeGitScript}" %*\r\n`);
  } else {
    const shim = path.join(fakeBin, "codex");
    fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`, { mode: 0o755 });
    const gitShim = path.join(fakeBin, "git");
    fs.writeFileSync(gitShim, `#!/bin/sh\nexec "${process.execPath}" "${fakeGitScript}" "$@"\n`, { mode: 0o755 });
  }
  const delimiter = process.platform === "win32" ? ";" : ":";
  const fakeEnvironment = {
    ...packageTestEnv,
    PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
    FAKE_CODEX_LOG: commandLog,
  };
  run(process.execPath, [cli, "doctor"], { cwd: temporary, env: fakeEnvironment });
  fs.rmSync(commandLog, { force: true });
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
      ...fakeEnvironment,
    },
  });
  const calls = fs.readFileSync(commandLog, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  if (!calls.some((args) => args.join(" ") === "plugin marketplace list --json")) {
    throw new Error("Packed setup did not inspect Codex marketplaces.");
  }
  if (calls.filter((args) => args[0] === "plugin" && args[1] === "add").length !== 2) {
    throw new Error("Packed setup did not install both plugins.");
  }
  const marketplaceAdd = calls.find(
    (args) => args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add",
  );
  if (marketplaceAdd?.[3] !== "preciousidam/roku-codex-toolkit" || marketplaceAdd?.[4] !== "--ref") {
    throw new Error("Packed setup did not register the durable versioned Git marketplace.");
  }

  fs.writeFileSync(commandLog, "");
  const failedUpgrade = runExpectFailure(process.execPath, [cli, "setup", "--skip-config"], {
    cwd: temporary,
    env: { ...fakeEnvironment, FAKE_EXISTING: "1", FAIL_REMOTE: "1" },
  });
  if (!`${failedUpgrade.stdout}\n${failedUpgrade.stderr}`.includes("Adding the Roku Codex Toolkit marketplace")) {
    throw new Error("Failed marketplace replacement did not report its error.");
  }
  const rollbackCalls = fs.readFileSync(commandLog, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  if (!rollbackCalls.some((args) => args.join(" ") === "plugin marketplace add /previous")) {
    throw new Error("Failed marketplace replacement did not restore the previous source.");
  }
  if (rollbackCalls.filter((args) => args[0] === "plugin" && args[1] === "add").length !== 2) {
    throw new Error("Failed marketplace replacement did not restore both plugins.");
  }

  fs.writeFileSync(commandLog, "");
  run(process.execPath, [cli, "setup", "--skip-config"], {
    cwd: temporary,
    env: { ...fakeEnvironment, FAIL_LIST: "1" },
  });
  const staleCalls = fs.readFileSync(commandLog, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  if (!staleCalls.some((args) => args.join(" ") === "plugin marketplace remove roku-codex-toolkit")) {
    throw new Error("A failed marketplace listing did not trigger stale-source repair.");
  }

  fs.writeFileSync(commandLog, "");
  fs.mkdirSync(path.join(packRoot, ".git"));
  run(process.execPath, [path.join(packRoot, "scripts", "setup-roku-toolkit.mjs"), "--skip-config"], {
    cwd: temporary,
    env: fakeEnvironment,
  });
  const cloneCalls = fs.readFileSync(commandLog, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  const cloneAdd = cloneCalls.find(
    (args) => args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add",
  );
  if (cloneAdd?.[3] !== fs.realpathSync(packRoot) || cloneAdd.includes("--ref")) {
    throw new Error("Source-checkout setup did not retain the local marketplace root.");
  }
  console.log(`Packed tarball validation passed (${packed.files.length} files, ${packed.size} bytes).`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
