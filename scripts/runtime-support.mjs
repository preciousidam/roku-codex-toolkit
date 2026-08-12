import { spawnSync } from "node:child_process";

export const pythonCandidates = process.platform === "win32"
  ? [{ command: "py", args: ["-3"] }, { command: "python", args: [] }, { command: "python3", args: [] }]
  : [{ command: "python3", args: [] }, { command: "python", args: [] }, { command: "py", args: ["-3"] }];

export function commandStatus(command, args, options = {}) {
  const useWindowsShim = process.platform === "win32" && options.windowsShim;
  const executable = useWindowsShim ? (process.env.ComSpec || "cmd.exe") : command;
  const executableArgs = useWindowsShim ? ["/d", "/s", "/c", command, ...args] : args;
  const { windowsShim: _windowsShim, ...spawnOptions } = options;
  return spawnSync(executable, executableArgs, {
    encoding: "utf8",
    timeout: 10_000,
    ...spawnOptions,
  });
}

export function findPython() {
  return pythonCandidates.find(({ command, args }) => {
    const result = commandStatus(command, [
      ...args,
      "-c",
      "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)",
    ]);
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
  const result = commandStatus(command, args, { windowsShim: true });
  return !result.error && result.status === 0;
}
