import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function lockDirectory() {
  const base = process.platform === "win32"
    ? (process.env.LOCALAPPDATA || process.env.APPDATA)
    : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"));
  if (!base || !path.isAbsolute(base)) throw new Error("Unable to determine a safe toolkit configuration directory.");
  return path.join(base, "roku-codex-toolkit");
}

export function acquireToolkitLock(operation) {
  const directory = lockDirectory();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
  const lock = path.join(directory, "operation.lock");
  let handle;
  let created = false;
  try {
    handle = fs.openSync(lock, "wx", 0o600);
    created = true;
    fs.writeFileSync(handle, `${operation} ${process.pid}\n`, { encoding: "utf8" });
  } catch (error) {
    if (created) {
      try { fs.closeSync(handle); } catch {}
      try { fs.rmSync(lock, { force: true }); } catch {}
    }
    if (!created && error?.code === "EEXIST") {
      throw new Error(`Another toolkit setup or upgrade may be active. Inspect and remove the stale lock manually if appropriate: ${lock}`);
    }
    throw error;
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { fs.closeSync(handle); } finally { fs.rmSync(lock, { force: true }); }
  };
  process.once("exit", release);
  return () => {
    process.removeListener("exit", release);
    release();
  };
}
