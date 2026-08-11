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
const python = pythonCandidates.find(({ command, args }) => {
  const result = spawnSync(command, [...args, "-c", "import sys; raise SystemExit(sys.version_info < (3, 9))"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return !result.error && result.status === 0;
});
if (!python) throw new Error("Python 3.9 or newer is required for validation.");

run("node", ["--test", "tests/node/repository.test.mjs"], "Node tests");
run(python.command, [...python.args, "-m", "unittest", "discover", "-s", "tests/python", "-p", "test_*.py"], "Python tests");
console.log("Roku Codex Toolkit validation passed.");
