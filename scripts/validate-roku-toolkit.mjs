#!/usr/bin/env node

import { spawnSync } from "node:child_process";

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "inherit" });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const pythonCandidates = [
  { command: "python3", args: [] },
  { command: "python", args: [] },
  { command: "py", args: ["-3"] },
];
const nodeOnly = process.argv.includes("--node-only");
const pythonOnly = process.argv.includes("--python-only");
if (nodeOnly && pythonOnly) throw new Error("Choose at most one focused test mode.");
const python = pythonCandidates.find(({ command, args }) => {
  const result = spawnSync(command, [...args, "-c", "import sys; raise SystemExit(sys.version_info < (3, 9))"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return !result.error && result.status === 0;
});
if (!nodeOnly && !python) throw new Error("Python 3.9 or newer is required for validation.");

if (!pythonOnly) run(
  "node",
  ["--test", "tests/node/repository.test.mjs", "tests/node/upgrade-state.test.mjs"],
  "Node tests",
);
if (!nodeOnly) {
  run(python.command, [...python.args, "-m", "unittest", "discover", "-s", "tests/python", "-p", "test_*.py"], "Python tests");
}
if (!nodeOnly && !pythonOnly) {
  run("node", ["scripts/smoke-published-package.mjs", "--version", "0.3.1", "--check-contract"], "Release contract");
}
console.log("Roku Codex Toolkit validation passed.");
