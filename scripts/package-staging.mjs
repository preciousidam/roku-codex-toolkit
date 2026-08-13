import fs from "node:fs";
import path from "node:path";

function resolveContained(root, relativePath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Package inventory entry escapes the source root: ${relativePath}`);
  }
  return resolved;
}

export function stagePackageSource(root, destination) {
  const packageJson = path.join(root, "package.json");
  const metadata = JSON.parse(fs.readFileSync(packageJson, "utf8"));
  const inventory = ["package.json", ...(metadata.files ?? [])];

  fs.mkdirSync(destination, { recursive: true });
  for (const relativePath of new Set(inventory)) {
    const source = resolveContained(root, relativePath);
    if (!fs.existsSync(source)) {
      throw new Error(`Package inventory entry does not exist: ${relativePath}`);
    }
    const target = resolveContained(destination, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
  }
}
