import { spawnSync } from "node:child_process";

export const pythonCandidates = process.platform === "win32"
  ? [{ command: "py", args: ["-3"] }, { command: "python", args: [] }, { command: "python3", args: [] }]
  : [{ command: "python3", args: [] }, { command: "python", args: [] }, { command: "py", args: ["-3"] }];

export function requireSupportedNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 18) {
    throw new Error(`Node.js 18 or newer is required; found ${process.version}.`);
  }
}

export function quoteWindowsCommandArg(value) {
  const escaped = String(value)
    .replaceAll("%", "%%")
    .replace(/(\\*)"/g, "$1$1\\\"")
    .replace(/(\\+)$/g, "$1$1");
  return `"${escaped}"`;
}

export function buildWindowsCommandLine(command, args) {
  const invocation = [command, ...args].map(quoteWindowsCommandArg).join(" ");
  // cmd.exe /s strips the first and last quote. Keep those separate from the
  // quotes protecting each executable/argument so paths and metacharacters
  // remain literal after that stripping.
  return `"${invocation}"`;
}

export function commandStatus(command, args, options = {}) {
  const useWindowsShim = process.platform === "win32" && options.windowsShim;
  const executable = useWindowsShim ? (process.env.ComSpec || "cmd.exe") : command;
  const commandLine = buildWindowsCommandLine(command, args);
  const executableArgs = useWindowsShim ? ["/d", "/s", "/c", commandLine] : args;
  const { windowsShim: _windowsShim, ...spawnOptions } = options;
  return spawnSync(executable, executableArgs, {
    encoding: "utf8",
    windowsVerbatimArguments: useWindowsShim,
    ...spawnOptions,
  });
}

export function findPython() {
  return pythonCandidates.find(({ command, args }) => {
    const result = commandStatus(command, [
      ...args,
      "-c",
      "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)",
    ], { timeout: 10_000 });
    return !result.error && result.status === 0;
  });
}

export function requirePython() {
  const python = findPython();
  if (!python) {
    throw new Error(
      "Python 3.9 or newer is required. Install a supported Python interpreter and ensure " +
      "python3, python, or py -3 is available on PATH.",
    );
  }
  return python;
}

export function commandAvailable(command, args = ["--version"]) {
  const direct = commandStatus(command, args, { timeout: 10_000 });
  if (!direct.error && direct.status === 0) return true;
  if (process.platform !== "win32") return false;

  // Windows can execute .exe files directly, while npm-installed .cmd/.bat
  // launchers require cmd.exe. Keep that shell fallback out of the normal
  // executable path so tools such as Git are detected without cmd parsing.
  const shim = commandStatus(command, args, { timeout: 10_000, windowsShim: true });
  return !shim.error && shim.status === 0;
}
