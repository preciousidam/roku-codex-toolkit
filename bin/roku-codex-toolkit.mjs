#!/usr/bin/env node

import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const commands = new Map([
  ["setup", "setup-roku-toolkit.mjs"],
  ["upgrade", "upgrade-roku-toolkit.mjs"],
  ["doctor", "doctor-roku-toolkit.mjs"],
  ["validate", "validate-install.mjs"],
]);

function usage() {
  console.log(`Usage: roku-codex-toolkit <command> [options]

Commands:
  setup       Register the marketplace and install both Codex plugins
  upgrade     Safely replace a supported version-pinned toolkit installation
  doctor      Check Node, Python, Codex, and packaged runtime availability
  validate    Validate installed package contents and runtime requirements`);
}

const [command, ...args] = process.argv.slice(2);
if (!command || command === "--help" || command === "-h") {
  usage();
  process.exit(0);
}
if (command === "--version" || command === "-v") {
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  console.log(metadata.version);
  process.exit(0);
}
const script = commands.get(command);
if (!script) {
  console.error(`Unknown command: ${command}`);
  usage();
  process.exit(2);
}
const child = fork(path.join(packageRoot, "scripts", script), args, {
  cwd: process.cwd(),
  stdio: ["inherit", "inherit", "inherit", "ipc"],
});
let interruptedSignal;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    // The terminal normally delivers the signal to both processes. Keeping a
    // parent handler installed prevents the wrapper from exiting while the
    // upgrade child performs bounded rollback.
    interruptedSignal ??= signal;
    if (command === "upgrade" && child.connected) {
      child.send({ type: "roku-toolkit-cancel", signal });
    } else {
      try { child.kill(signal); } catch {}
    }
  });
}
const result = await new Promise((resolve) => {
  child.once("error", (error) => resolve({ error }));
  child.once("exit", (status, signal) => resolve({ status, signal }));
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (interruptedSignal || result.signal) process.exit(130);
process.exit(result.status ?? 1);
