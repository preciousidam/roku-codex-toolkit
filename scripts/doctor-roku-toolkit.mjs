#!/usr/bin/env node

import process from "node:process";
import { commandAvailable, findPython } from "./runtime-support.mjs";

if (process.argv.includes("--help")) {
  console.log("Usage: roku-codex-toolkit doctor [--no-codex]");
  process.exit(0);
}
const checks = [
  { name: "Node.js >=18", ok: Number(process.versions.node.split(".")[0]) >= 18, detail: process.version },
];
const python = findPython();
checks.push({
  name: "Python >=3.9",
  ok: Boolean(python),
  detail: python ? [python.command, ...python.args].join(" ") : "not found",
});
if (!process.argv.includes("--no-codex")) {
  checks.push({ name: "Codex CLI", ok: commandAvailable("codex"), detail: "codex" });
}
for (const check of checks) console.log(`${check.ok ? "ok" : "not ok"} - ${check.name} (${check.detail})`);
if (checks.some((check) => !check.ok)) process.exit(1);
