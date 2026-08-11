#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = path.join(pluginRoot, "mcp/server.py");
const python = [
  { command: "python3", args: [] },
  { command: "python", args: [] },
  { command: "py", args: ["-3"] },
].find((candidate) => {
  const result = spawnSync(
    candidate.command,
    [...candidate.args, "-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)"],
    { encoding: "utf8" },
  );
  return !result.error && result.status === 0;
});

if (!python) {
  console.error("Python 3.9 or newer is required to run the Roku Device Toolkit MCP server.");
  process.exit(1);
}

const child = spawn(python.command, [...python.args, server], {
  cwd: pluginRoot,
  env: process.env,
  stdio: "inherit",
});
let terminatingSignal = null;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (terminatingSignal === null) {
      terminatingSignal = signal;
      child.kill(signal);
    }
  });
}
child.on("error", (error) => {
  console.error(`Unable to start the Roku Device Toolkit MCP server: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (terminatingSignal) {
    process.removeAllListeners(terminatingSignal);
    process.kill(process.pid, terminatingSignal);
    return;
  }
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
