import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";

/** Optional PowerShell host used to launch a configured `.ps1` Claude Code command. */
export const POWERSHELL_ENV = "PI_CLAUDE_CODE_POWERSHELL";

export function configuredCommand(env: Record<string, string | undefined>): string {
  return envValue(env, "PI_CLAUDE_CODE_COMMAND") || "claude";
}

/**
 * Read an environment entry. Windows environment blocks are case-insensitive
 * (`Path`, not `PATH`), and copying `process.env` into a plain object loses
 * Node's case-insensitive proxy, so look the name up case-insensitively there.
 */
export function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  if (process.platform !== "win32") return undefined;
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Candidate paths for a command name, in the order Windows would resolve them. */
function commandCandidates(command: string, env: Record<string, string | undefined>): string[] {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) return [resolve(command)];

  const extensions =
    process.platform === "win32"
      ? (envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").flatMap((suffix) => [suffix, suffix.toLowerCase()])
      : [""];
  const candidates: string[] = [];
  for (const directory of (envValue(env, "PATH") || "").split(delimiter)) {
    if (!directory) continue;
    for (const suffix of extensions) {
      candidates.push(join(directory, process.platform === "win32" && extname(command) ? command : command + suffix));
    }
  }
  return candidates;
}

export async function resolveClaudeExecutable(
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  for (const candidate of commandCandidates(configuredCommand(env), env)) {
    if (await executable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * PowerShell host for a configured `.ps1` command. Noninteractive and
 * deterministic: an explicit override wins, then PowerShell 7 (`pwsh`) because
 * its native argument forwarding preserves embedded quotes, then the Windows
 * PowerShell that ships with every supported Windows release.
 */
function resolvePowerShell(env: Record<string, string | undefined>): string {
  const configured = envValue(env, POWERSHELL_ENV)?.trim();
  if (configured) return configured;
  for (const command of ["pwsh", "powershell"]) {
    const candidate = commandCandidates(command, env).find((path) => existsSync(path));
    if (candidate) return candidate;
  }
  return "powershell.exe";
}

// cmd.exe reparses the whole `/c` string, so tokens need cmd-level escaping in
// addition to the quoting the receiving program's own command line parser
// (CommandLineToArgvW) expects. The token rules below follow https://qntm.org/cmd.
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/gu;

function escapeCmdCommand(value: string): string {
  return value.replace(CMD_META_CHARS, "^$1");
}

/** Quote one argument for a cmd.exe `/s /c` command line. Exported for tests. */
export function escapeCmdArgument(value: string): string {
  // Double backslashes that precede a quote, or that would precede the closing
  // quote added below, so the child's parser restores them verbatim.
  const quoted = `"${value.replace(/(?<!\\)(\\*)"/gu, '$1$1\\"').replace(/(?<!\\)(\\*)$/u, "$1$1")}"`;
  return quoted.replace(CMD_META_CHARS, "^$1");
}

/** PowerShell single-quoted literal: everything is literal except `'`, which doubles. */
function powershellLiteral(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

/**
 * Launch a configured `.ps1` Claude Code command through a noninteractive
 * PowerShell. The script text travels as `-EncodedCommand` so the Windows
 * command line parser never sees the scripts' arguments.
 */
function spawnPowerShellScript(
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
): ChildProcess {
  const shell = resolvePowerShell(options?.env ?? process.env);
  // `-Command` collapses a script's exit code to 0 or 1, so forward it explicitly.
  const script = [
    [`& ${powershellLiteral(command)}`, ...args.map(powershellLiteral)].join(" "),
    "$ok = $?",
    "if ($LASTEXITCODE) { exit $LASTEXITCODE }",
    "if (-not $ok) { exit 1 }",
  ].join("; ");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return spawn(
    shell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    options,
  );
}

/**
 * Spawn Claude Code. `.cmd`/`.bat` shims need a cmd.exe command line that is
 * escaped once and passed verbatim; `.ps1` needs a PowerShell host. Native
 * executables (and every POSIX command) are spawned directly.
 */
export function spawnCommand(
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
): ChildProcess {
  if (process.platform !== "win32") return spawn(command, args, options);
  if (/\.(?:cmd|bat)$/iu.test(command)) {
    const comspec = envValue(options?.env ?? {}, "COMSPEC") || process.env.COMSPEC || "cmd.exe";
    const line = `"${[escapeCmdCommand(command), ...args.map(escapeCmdArgument)].join(" ")}"`;
    return spawn(comspec, ["/d", "/s", "/c", line], { ...options, windowsVerbatimArguments: true });
  }
  if (/\.ps1$/iu.test(command)) return spawnPowerShellScript(command, args, options);
  return spawn(command, args, options);
}

export function childExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== null) resolve(code);
      else reject(new Error(`Claude Code exited from signal ${signal ?? "unknown"}`));
    });
  });
}

export function killProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => child.kill());
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // It exited between the checks.
    }
  }
}
