import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(websiteRoot, "dist");
const basePath = "/roku-codex-toolkit/";

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(absolute) : [absolute];
  });
}

function targetFor(url) {
  const pathname = url.split(/[?#]/, 1)[0];
  if (pathname.startsWith("/") && !pathname.startsWith("//") && !pathname.startsWith(basePath)) {
    throw new Error(`root-relative link escapes configured base path: ${url}`);
  }
  if (!pathname.startsWith(basePath)) return null;
  const relative = decodeURIComponent(pathname.slice(basePath.length));
  if (!relative || relative.endsWith("/")) return path.join(outputRoot, relative, "index.html");
  const direct = path.join(outputRoot, relative);
  return path.extname(relative) ? direct : path.join(direct, "index.html");
}

const htmlFiles = filesUnder(outputRoot).filter((file) => file.endsWith(".html"));
if (htmlFiles.length < 10) throw new Error(`Expected at least 10 generated pages; found ${htmlFiles.length}.`);

const failures = [];
for (const file of htmlFiles) {
  const html = fs.readFileSync(file, "utf8");
  const page = path.relative(outputRoot, file);
  if (!/<html\b[^>]*\blang=["']en["']/i.test(html)) failures.push(`${page}: missing lang=en`);
  if (!/<title>[^<]+<\/title>/i.test(html)) failures.push(`${page}: missing title`);
  if (!/<main\b/i.test(html)) failures.push(`${page}: missing main landmark`);
  if (!/<h1\b/i.test(html)) failures.push(`${page}: missing level-one heading`);
  for (const image of html.match(/<img\b[^>]*>/gi) ?? []) {
    if (!/\balt=["'][^"']*["']/i.test(image)) failures.push(`${page}: image missing alt text`);
  }
  for (const match of html.matchAll(/\bhref=["']([^"']+)["']/gi)) {
    try {
      const target = targetFor(match[1]);
      if (target && !fs.existsSync(target)) failures.push(`${page}: broken link ${match[1]}`);
    } catch (error) {
      failures.push(`${page}: ${error.message}`);
    }
  }
}

if (failures.length > 0) throw new Error(`Static site validation failed:\n- ${failures.join("\n- ")}`);
console.log(`Static site validation passed (${htmlFiles.length} HTML pages).`);
