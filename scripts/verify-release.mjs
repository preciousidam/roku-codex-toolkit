#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;

if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error("Usage: node scripts/verify-release.mjs v<major>.<minor>.<patch>");
  process.exit(1);
}

const expected = tag.slice(1);
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
const versions = new Map([
  ["package.json", readJson("package.json").version],
  ["package-lock.json", readJson("package-lock.json").version],
  ["package-lock.json root package", readJson("package-lock.json").packages?.[""]?.version],
  ["roku-device-toolkit", readJson("plugins/roku-device-toolkit/.codex-plugin/plugin.json").version],
  ["roku-engineering", readJson("plugins/roku-engineering/.codex-plugin/plugin.json").version],
]);

const mismatches = [...versions].filter(([, version]) => version !== expected);
if (mismatches.length > 0) {
  for (const [name, version] of mismatches) {
    console.error(`${name} has version ${version ?? "<missing>"}; expected ${expected}`);
  }
  process.exit(1);
}

console.log(`Release metadata matches ${tag}.`);
