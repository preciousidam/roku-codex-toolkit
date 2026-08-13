#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requirePython, requireSupportedNode } from "./runtime-support.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
requireSupportedNode();
const packageMetadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (!Array.isArray(packageMetadata.files) || packageMetadata.files.some((entry) => (
  typeof entry !== "string" || entry.endsWith("/")
))) {
  throw new Error("Installed package has an invalid explicit file inventory.");
}
const required = packageMetadata.files;
for (const relative of required) {
  if (!fs.statSync(path.join(root, relative), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Installed package is incomplete: missing ${relative}`);
  }
}
const marketplace = JSON.parse(fs.readFileSync(path.join(root, ".agents/plugins/marketplace.json"), "utf8"));
if (marketplace.plugins?.length !== 2) {
  throw new Error(`Expected 2 marketplace plugins; found ${marketplace.plugins?.length ?? 0}.`);
}
for (const plugin of marketplace.plugins) {
  const relative = plugin?.source?.path;
  if (typeof relative !== "string" || !fs.existsSync(path.resolve(root, relative))) {
    throw new Error(`Marketplace plugin path is invalid: ${String(relative)}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.resolve(root, relative, ".codex-plugin", "plugin.json"), "utf8"));
  if (manifest.version !== packageMetadata.version) {
    throw new Error(
      `Version mismatch: package is ${packageMetadata.version}, but ${manifest.name} is ${manifest.version}.`,
    );
  }
}
requirePython();
console.log("Roku Codex Toolkit installed-package validation passed.");
