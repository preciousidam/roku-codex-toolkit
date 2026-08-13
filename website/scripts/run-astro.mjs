import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2];
if (!new Set(["dev", "build", "preview"]).has(command)) {
  throw new Error("Expected an Astro command: dev, build, or preview.");
}

const cli = path.join(websiteRoot, "node_modules", "astro", "bin", "astro.mjs");
const result = spawnSync(process.execPath, [cli, command, ...process.argv.slice(3)], {
  cwd: websiteRoot,
  env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
