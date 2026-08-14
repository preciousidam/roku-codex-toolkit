#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { stagePackageSource } from "./package-staging.mjs";

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
const publicPngAssets = new Set([
  "plugins/roku-device-toolkit/assets/device-demo.png",
  "plugins/roku-device-toolkit/assets/mark.png",
  "plugins/roku-engineering/assets/engineering-demo.png",
  "plugins/roku-engineering/assets/mark.png",
]);

function isUnsafeArtifactName(name) {
  return /\.(?:log|pyc|jpe?g)$/i.test(name) ||
    (/\.png$/i.test(name) && !publicPngAssets.has(name)) ||
    /(^|\/)(?:config|private-target)\.json$/.test(name);
}

for (const name of publicPngAssets) {
  if (isUnsafeArtifactName(name)) throw new Error(`Public PNG asset was rejected: ${name}`);
}
for (const name of ["captured-screen.png", "captured-screen.PNG", "captured-screen.PnG"]) {
  if (!isUnsafeArtifactName(name)) throw new Error(`Unsafe PNG fixture was accepted: ${name}`);
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
  stagePackageSource(root, packRoot);
  for (const fixture of [
    path.join(packRoot, "plugins", "roku-device-toolkit", "mcp", "__pycache__", "secret.pyc"),
    path.join(packRoot, "plugins", "roku-device-toolkit", "mcp", "evidence", "private.log"),
    path.join(packRoot, "plugins", "roku-device-toolkit", "config.json"),
    path.join(packRoot, "plugins", "roku-device-toolkit", "private-target.json"),
    path.join(packRoot, "plugins", "roku-device-toolkit", "secret-target.conf"),
    path.join(packRoot, "plugins", "roku-device-toolkit", "roku-screenshot.jpg"),
    path.join(packRoot, "plugins", "roku-device-toolkit", "captured-screen.png"),
    path.join(packRoot, "bin", "roku-screenshot.jpg"),
    path.join(packRoot, "bin", "private-target.conf"),
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
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(packRoot, "package.json"), "utf8"));
  const explicitlyAllowedFiles = new Set(packageMetadata.files.filter(
    (name) => name.startsWith("plugins/") || name.startsWith("bin/"),
  ));
  for (const required of [
    "package.json",
    "bin/roku-codex-toolkit.mjs",
    ".agents/plugins/marketplace.json",
    "plugins/roku-device-toolkit/scripts/launch-mcp.mjs",
    "plugins/roku-device-toolkit/mcp/server.py",
    "plugins/roku-device-toolkit/assets/device-demo.png",
    "plugins/roku-device-toolkit/assets/mark.png",
    "plugins/roku-engineering/.codex-plugin/plugin.json",
    "plugins/roku-engineering/assets/engineering-demo.png",
    "plugins/roku-engineering/assets/mark.png",
    "docs/getting-started.md",
    "docs/marketplace.md",
    "docs/media/roku-device-toolkit-demo.svg",
    "docs/media/roku-device-toolkit-mark.svg",
    "docs/media/roku-engineering-demo.svg",
    "docs/media/roku-engineering-mark.svg",
    "docs/tooling-comparison.md",
    "docs/troubleshooting.md",
  ]) {
    if (!names.has(required)) throw new Error(`Packed tarball is missing ${required}`);
  }
  for (const name of names) {
    if ((name.startsWith("plugins/") || name.startsWith("bin/")) && !explicitlyAllowedFiles.has(name)) {
      throw new Error(`File is outside the explicit package inventory: ${name}`);
    }
    if (/^(tests|\.github)\//.test(name) || /(^|\/)(__pycache__|node_modules|evidence|artifacts)(\/|$)/.test(name)) {
      throw new Error(`Development-only path leaked into tarball: ${name}`);
    }
    if (name.startsWith("docs/") && ![
      "docs/getting-started.md",
      "docs/marketplace.md",
      "docs/media/roku-device-toolkit-demo.svg",
      "docs/media/roku-device-toolkit-mark.svg",
      "docs/media/roku-engineering-demo.svg",
      "docs/media/roku-engineering-mark.svg",
      "docs/tooling-comparison.md",
      "docs/troubleshooting.md",
    ].includes(name)) {
      throw new Error(`Unlisted documentation leaked into tarball: ${name}`);
    }
    if (isUnsafeArtifactName(name)) {
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
  const launcher = path.join(installedRoot, "plugins", "roku-device-toolkit", "scripts", "launch-mcp.mjs");
  const hiddenLauncher = `${launcher}.missing`;
  fs.renameSync(launcher, hiddenLauncher);
  const missingLauncher = runExpectFailure(process.execPath, [cli, "validate"], { cwd: temporary });
  if (!`${missingLauncher.stdout}\n${missingLauncher.stderr}`.includes("missing plugins/roku-device-toolkit/scripts/launch-mcp.mjs")) {
    throw new Error("Installed-package validation did not reject a missing MCP launcher.");
  }
  fs.renameSync(hiddenLauncher, launcher);
  const configRuntime = path.join(installedRoot, "plugins", "roku-device-toolkit", "scripts", "roku_config.py");
  const hiddenConfigRuntime = `${configRuntime}.missing`;
  fs.renameSync(configRuntime, hiddenConfigRuntime);
  const missingConfigRuntime = runExpectFailure(process.execPath, [cli, "validate"], { cwd: temporary });
  if (!`${missingConfigRuntime.stdout}\n${missingConfigRuntime.stderr}`.includes("missing plugins/roku-device-toolkit/scripts/roku_config.py")) {
    throw new Error("Installed-package validation did not reject a missing MCP configuration runtime.");
  }
  fs.renameSync(hiddenConfigRuntime, configRuntime);
  const bundledSkill = path.join(
    installedRoot,
    "plugins",
    "roku-engineering",
    "skills",
    "roku-runtime-log-analyzer",
    "SKILL.md",
  );
  const hiddenBundledSkill = `${bundledSkill}.missing`;
  fs.renameSync(bundledSkill, hiddenBundledSkill);
  const missingBundledSkill = runExpectFailure(process.execPath, [cli, "validate"], { cwd: temporary });
  if (!`${missingBundledSkill.stdout}\n${missingBundledSkill.stderr}`.includes(
    "missing plugins/roku-engineering/skills/roku-runtime-log-analyzer/SKILL.md",
  )) {
    throw new Error("Installed-package validation did not reject a missing bundled skill.");
  }
  fs.renameSync(hiddenBundledSkill, bundledSkill);

  const fakeBin = path.join(temporary, "bin");
  fs.mkdirSync(fakeBin);
  const fakeScript = path.join(fakeBin, "fake-codex.mjs");
  const fakeGitScript = path.join(fakeBin, "fake-git.mjs");
  const commandLog = path.join(temporary, "codex-commands.jsonl");
  fs.writeFileSync(fakeScript, `import fs from "node:fs";\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(args) + "\\n");\nif (args[0] === "--version" || args.join(" ") === "plugin marketplace --help") console.log("codex-test");\nif (args.join(" ") === "plugin marketplace list --json") {\n  if (process.env.FAIL_LIST === "1") process.exit(1);\n  const marketplaces = process.env.FAKE_EXISTING === "1" ? [{name: "roku-codex-toolkit", marketplaceSource: {sourceType: "local", source: "/previous"}}] : [];\n  console.log(JSON.stringify({marketplaces}));\n}\nif (args.join(" ") === "plugin list --json") {\n  const names = (process.env.FAKE_INSTALLED ?? "roku-device-toolkit,roku-engineering").split(",").filter(Boolean);\n  console.log(JSON.stringify({installed: names.map((name) => ({name, marketplaceName: "roku-codex-toolkit", installed: true}))}));\n}\nif (process.env.FAIL_REMOTE === "1" && args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add" && args[3] === "preciousidam/roku-codex-toolkit") process.exit(1);\nif (process.env.FAIL_MARKETPLACE_REMOVE && args.join(" ") === "plugin marketplace remove roku-codex-toolkit" && !fs.existsSync(process.env.FAIL_MARKETPLACE_REMOVE)) {\n  fs.writeFileSync(process.env.FAIL_MARKETPLACE_REMOVE, "persistent state changed before failure");\n  process.exit(1);\n}\nif (process.env.FAIL_SECOND_PLUGIN && args.join(" ") === "plugin add roku-engineering@roku-codex-toolkit" && !fs.existsSync(process.env.FAIL_SECOND_PLUGIN)) {\n  fs.writeFileSync(process.env.FAIL_SECOND_PLUGIN, "failed once");\n  process.exit(1);\n}\n`);
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
    FAKE_INSTALLED: "",
  };
  run(process.execPath, [cli, "doctor", "--no-codex"], { cwd: temporary, env: fakeEnvironment });
  fs.rmSync(commandLog, { force: true });
  const doctorHelp = run(process.execPath, [cli, "doctor", "-h"], {
    cwd: temporary,
    env: { ...packageTestEnv, PATH: fakeBin, FAKE_CODEX_LOG: commandLog },
  });
  if (!doctorHelp.stdout.includes("Usage: roku-codex-toolkit doctor")) {
    throw new Error("doctor -h did not display subcommand usage.");
  }
  if (fs.existsSync(commandLog)) {
    throw new Error("doctor -h inspected dependencies instead of exiting after help.");
  }
  run(process.execPath, [cli, "setup", "-h"], { cwd: temporary, env: fakeEnvironment });
  if (fs.existsSync(commandLog)) {
    throw new Error("setup -h changed or inspected Codex state.");
  }
  const unknownSetupOption = runExpectFailure(process.execPath, [cli, "setup", "--skip-confg"], {
    cwd: temporary,
    env: fakeEnvironment,
  });
  if (!`${unknownSetupOption.stdout}\n${unknownSetupOption.stderr}`.includes("Unknown setup option: --skip-confg")) {
    throw new Error("Setup did not reject an unknown option with a useful diagnostic.");
  }
  if (fs.existsSync(commandLog)) {
    throw new Error("Setup inspected or changed Codex state before rejecting an unknown option.");
  }
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
  const existingSetup = runExpectFailure(process.execPath, [cli, "setup", "--skip-config"], {
    cwd: temporary,
    env: { ...fakeEnvironment, FAKE_EXISTING: "1" },
  });
  if (!`${existingSetup.stdout}\n${existingSetup.stderr}`.includes("already registered")) {
    throw new Error("Setup did not explain that an existing marketplace was left unchanged.");
  }
  const existingCalls = fs.readFileSync(commandLog, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  if (existingCalls.some((args) => args[0] === "plugin" && (
    ["add", "remove"].includes(args[1]) ||
    (args[1] === "marketplace" && ["add", "remove"].includes(args[2]))
  ))) {
    throw new Error("Setup mutated an existing marketplace or plugin state.");
  }

  fs.writeFileSync(commandLog, "");
  const orphanedSetup = runExpectFailure(process.execPath, [cli, "setup", "--skip-config"], {
    cwd: temporary,
    env: { ...fakeEnvironment, FAKE_INSTALLED: "roku-device-toolkit" },
  });
  if (!`${orphanedSetup.stdout}\n${orphanedSetup.stderr}`.includes("orphaned Roku Codex Toolkit plugin state")) {
    throw new Error("Setup did not reject preexisting orphaned plugin state.");
  }
  const orphanedCalls = fs.readFileSync(commandLog, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  if (!orphanedCalls.some((args) => args.join(" ") === "plugin marketplace remove roku-codex-toolkit")) {
    throw new Error("Setup did not remove its temporary marketplace after finding orphaned state.");
  }
  if (orphanedCalls.some((args) => args[0] === "plugin" && ["add", "remove"].includes(args[1]))) {
    throw new Error("Setup changed preexisting orphaned plugin state.");
  }

  fs.writeFileSync(commandLog, "");
  const normalFakeSource = fs.readFileSync(fakeScript, "utf8");
  fs.writeFileSync(fakeScript, normalFakeSource.replace(
    'if (args.join(" ") === "plugin list --json") {',
    'if (args.join(" ") === "plugin list --json") { process.exit(1); }\nif (false) {',
  ));
  const failedOrphanInspection = runExpectFailure(process.execPath, [cli, "setup", "--skip-config"], {
    cwd: temporary,
    env: fakeEnvironment,
  });
  fs.writeFileSync(fakeScript, normalFakeSource);
  if (!`${failedOrphanInspection.stdout}\n${failedOrphanInspection.stderr}`.includes("Inspecting installed Roku Codex Toolkit plugins")) {
    throw new Error("A failed orphan-state inspection did not report its error.");
  }
  const failedInspectionCalls = fs.readFileSync(commandLog, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  if (!failedInspectionCalls.some((args) => args.join(" ") === "plugin marketplace remove roku-codex-toolkit")) {
    throw new Error("A failed orphan-state inspection left the temporary marketplace registered.");
  }

  fs.writeFileSync(commandLog, "");
  const pluginFailureMarker = path.join(temporary, "failed-second-plugin");
  fs.rmSync(pluginFailureMarker, { force: true });
  runExpectFailure(process.execPath, [cli, "setup", "--skip-config"], {
    cwd: temporary,
    env: { ...fakeEnvironment, FAIL_SECOND_PLUGIN: pluginFailureMarker },
  });
  const firstInstallCalls = fs.readFileSync(commandLog, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  if (!firstInstallCalls.some((args) => args.join(" ") === "plugin marketplace remove roku-codex-toolkit")) {
    throw new Error("Failed first-time plugin installation did not clean up the partial marketplace.");
  }
  if (!firstInstallCalls.some((args) => args.join(" ") === "plugin remove roku-device-toolkit@roku-codex-toolkit")) {
    throw new Error("Failed first-time plugin installation did not remove the partially installed plugin.");
  }
  if (!firstInstallCalls.some((args) => args.join(" ") === "plugin remove roku-engineering@roku-codex-toolkit")) {
    throw new Error("Failed first-time plugin installation did not remove the in-flight plugin.");
  }

  fs.writeFileSync(commandLog, "");
  const failedListing = runExpectFailure(process.execPath, [cli, "setup", "--skip-config"], {
    cwd: temporary,
    env: { ...fakeEnvironment, FAIL_LIST: "1" },
  });
  if (!`${failedListing.stdout}\n${failedListing.stderr}`.includes("Inspecting Codex marketplaces")) {
    throw new Error("A failed marketplace listing did not report a safe diagnostic.");
  }
  const staleCalls = fs.readFileSync(commandLog, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  if (staleCalls.some((args) => args[0] === "plugin" && (
    args[1] === "add" || (args[1] === "marketplace" && ["add", "remove"].includes(args[2]))
  ))) {
    throw new Error("A failed marketplace listing changed Codex state without a safe rollback snapshot.");
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
