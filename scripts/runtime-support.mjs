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

export function buildWindowsShimInvocation(command, args) {
  const values = [command, ...args].map(String);
  const environment = Object.fromEntries(values.map((value, index) => [
    `ROKU_TOOLKIT_SHIM_${index}`,
    value,
  ]));
  const invocation = values.map((_, index) => `"%ROKU_TOOLKIT_SHIM_${index}%"`).join(" ");
  // cmd.exe expands only these fixed variable names. Percent signs and shell
  // metacharacters inside their values are not interpolated into the command
  // source before expansion, and remain protected by the surrounding quotes.
  return { commandLine: `"${invocation}"`, environment };
}

export function commandStatus(command, args, options = {}) {
  const useWindowsShim = process.platform === "win32" && options.windowsShim;
  const executable = useWindowsShim ? (process.env.ComSpec || "cmd.exe") : command;
  const shim = useWindowsShim ? buildWindowsShimInvocation(command, args) : undefined;
  const executableArgs = useWindowsShim ? ["/d", "/v:off", "/s", "/c", shim.commandLine] : args;
  const { windowsShim: _windowsShim, ...spawnOptions } = options;
  return spawnSync(executable, executableArgs, {
    encoding: "utf8",
    windowsVerbatimArguments: useWindowsShim,
    ...spawnOptions,
    ...(useWindowsShim ? { env: { ...process.env, ...spawnOptions.env, ...shim.environment } } : {}),
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
