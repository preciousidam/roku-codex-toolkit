import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(websiteRoot, "..");
const outputRoot = path.join(websiteRoot, "src", "content", "docs");
const publicMediaRoot = path.join(websiteRoot, "public", "media");
const repositoryUrl = "https://github.com/preciousidam/roku-codex-toolkit";

const canonicalPages = [
  ["docs/getting-started.md", "getting-started.md"],
  ["docs/troubleshooting.md", "troubleshooting.md"],
  ["docs/marketplace.md", "marketplace.md"],
  ["docs/reference.md", "reference.md"],
  ["docs/tooling-comparison.md", "tooling-comparison.md"],
  ["docs/docs-portal.md", "docs-portal.md"],
  ["docs/hardware-validation.md", "hardware-validation.md"],
  ["docs/stabilization-audit.md", "stabilization-audit.md"],
  ["docs/npm-distribution.md", "npm-distribution.md"],
  ["docs/license-evaluation.md", "license-evaluation.md"],
  ["docs/v0.1.0.md", "v0-1-0.md"],
  ["docs/v0.2.0.md", "v0-2-0.md"],
  ["SECURITY.md", "security.md"],
  ["CONTRIBUTING.md", "contributing.md"],
];
const portalRoutes = new Map(
  canonicalPages.map(([sourceName, destinationName]) => [
    path.basename(sourceName),
    destinationName.replace(/\.md$/, ""),
  ]),
);

function portalMarkdown(source, sourceName) {
  const normalized = source.replaceAll("\r\n", "\n");
  const heading = normalized.match(/^#\s+(.+)\n/);
  if (!heading) throw new Error(`${sourceName} must begin with one level-one heading.`);
  const body = normalized.slice(heading[0].length)
    .replaceAll(
      "../README.md#install-with-npm",
      `${repositoryUrl}#install-with-npm`,
    )
    .replaceAll(
      "](media/)",
      `](${repositoryUrl}/tree/main/docs/media)`,
    )
    .replaceAll("](media/roku-device-toolkit-mark.svg)", "](../media/roku-device-toolkit-mark.svg)")
    .replaceAll("](media/roku-engineering-mark.svg)", "](../media/roku-engineering-mark.svg)")
    .replace(/\]\((?:\.\.\/)?([^/)]+\.md)(#[^)]+)?\)/g, (match, fileName, hash = "") => {
      const route = portalRoutes.get(fileName);
      return route ? `](../${route}/${hash})` : match;
    });
  return `---\ntitle: ${JSON.stringify(heading[1])}\n---\n\n${body}`;
}

fs.rmSync(outputRoot, { recursive: true, force: true });
fs.mkdirSync(outputRoot, { recursive: true });

for (const [sourceName, destinationName] of canonicalPages) {
  const sourcePath = path.join(repositoryRoot, sourceName);
  const destinationPath = path.join(outputRoot, destinationName);
  fs.writeFileSync(
    destinationPath,
    portalMarkdown(fs.readFileSync(sourcePath, "utf8"), sourceName),
  );
}

for (const entry of fs.readdirSync(path.join(websiteRoot, "content"))) {
  if (!entry.endsWith(".md")) continue;
  fs.copyFileSync(path.join(websiteRoot, "content", entry), path.join(outputRoot, entry));
}

fs.rmSync(publicMediaRoot, { recursive: true, force: true });
fs.cpSync(path.join(repositoryRoot, "docs", "media"), publicMediaRoot, {
  recursive: true,
});
fs.cpSync(path.join(repositoryRoot, "docs", "media"), path.join(outputRoot, "media"), {
  recursive: true,
});

console.log(`Synchronized ${canonicalPages.length + 1} documentation pages.`);
