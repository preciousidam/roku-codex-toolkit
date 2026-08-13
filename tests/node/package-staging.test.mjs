import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stagePackageSource } from "../../scripts/package-staging.mjs";

test("package staging copies only the explicit inventory when destination is inside source", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "roku-package-stage-"));
  try {
    const source = path.join(temporary, "source");
    const destination = path.join(source, ".tmp", "staged");
    fs.mkdirSync(path.join(source, "bin"), { recursive: true });
    fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ files: ["bin/cli.mjs"] }));
    fs.writeFileSync(path.join(source, "bin", "cli.mjs"), "export {};\n");
    fs.writeFileSync(path.join(source, "private.log"), "must not ship\n");

    stagePackageSource(source, destination);

    assert.equal(fs.readFileSync(path.join(destination, "bin", "cli.mjs"), "utf8"), "export {};\n");
    assert.equal(fs.existsSync(path.join(destination, "private.log")), false);
    assert.equal(fs.existsSync(path.join(destination, ".tmp")), false);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test("package staging rejects inventory entries outside the source", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "roku-package-stage-"));
  try {
    fs.writeFileSync(path.join(temporary, "package.json"), JSON.stringify({ files: ["../secret"] }));
    assert.throws(
      () => stagePackageSource(temporary, path.join(temporary, "staged")),
      /escapes the source root/,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
