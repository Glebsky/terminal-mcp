import { spawn } from "node:child_process";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { config } from "../config.js";
import { auditLog } from "../utils/logger.js";
import { scrubbedEnv } from "../utils/env.js";
import { resolveTarget, setActiveWorkingDir, globalScope, type WorkspaceScope } from "./filesystem.js";
import { trimIncompleteUtf8 } from "../utils/text.js";

export interface CommandExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  /** A background process still held the output pipes; output may be incomplete and it may still run. */
  backgroundLeft: boolean;
  /** The client disconnected or cancelled the request and the process tree was killed. */
  aborted: boolean;
}

export interface ExecuteOptions {
  /** Working directory of the calling session (the shared one for stateless /mcp). */
  scope?: WorkspaceScope;
  /** Aborted when the client disconnects or cancels the request (SPEC-005 FR-4.3). */
  signal?: AbortSignal;
}

// After the shell exits, wait this long for the rest of its output (SPEC-005 FR-4.2).
const OUTPUT_DRAIN_MS = 1_000;
// After a timeout or abort kill, return at the latest this much later (SPEC-005 FR-4.1).
const HARD_STOP_GRACE_MS = 2_000;
// Environment variable that carries the command text into the nested cmd (see executeCommand).
const CMD_COMMAND_VAR = "MCP_TERMINAL_COMMAND";

/** A stream that hit MAX_OUTPUT_BYTES may end inside a character: drop that partial character (SPEC-006 FR-2). */
function decodeOutput(bytes: Buffer): string {
  return (bytes.length >= config.maxOutputBytes ? trimIncompleteUtf8(bytes) : bytes).toString("utf8");
}

export async function killProcessTree(childPid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(childPid), "/T", "/F"], {
        windowsHide: true,
      });
      killer.once("close", () => resolve());
      killer.once("error", () => resolve());
    });
  } else {
    try {
      process.kill(-childPid, "SIGKILL");
    } catch {
      // Process already terminated
    }
  }
}

// A command that consists only of `cd <dir>` / `Set-Location <dir>`.
const CD_COMMAND = /^\s*(?:cd|chdir|Set-Location|sl)\s+['"]?([^'";\n\r&|]+?)['"]?\s*$/i;

/**
 * Runs a shell command with the privileges of the account running the server.
 * FILES_ROOT / FULL_ACCESS only restrict the starting working directory;
 * they do NOT restrict what the command itself can access.
 */
export async function executeCommand(
  command: string,
  shell: "powershell" | "cmd" = "powershell",
  cwd?: string,
  timeoutMs?: number,
  options: ExecuteOptions = {},
): Promise<CommandExecutionResult> {
  const scope = options.scope ?? globalScope;
  // `cwd` applies to this call only and does not change the session's working directory.
  const actualCwd = cwd ? resolveTarget(cwd, { cwd: scope.get() }) : scope.get();
  let cwdIsDirectory = false;
  try {
    cwdIsDirectory = fsSync.statSync(actualCwd).isDirectory();
  } catch {
    cwdIsDirectory = false;
  }
  if (!cwdIsDirectory) {
    throw new Error(`Working directory does not exist or is not a directory: ${actualCwd}`);
  }

  const timeout = Math.min(timeoutMs ?? config.commandTimeoutMs, 900_000);
  const executable = shell === "cmd" ? "cmd.exe" : "powershell.exe";

  // PowerShell: switch the output encoding to UTF-8 before the command.
  const psCommand = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`;

  // cmd reads the console code page once per command line, so `chcp 65001 & <command>` still printed
  // built-ins (echo, dir, vol) in the OEM code page; a nested cmd started after chcp prints UTF-8.
  // The command travels in an environment variable that delayed expansion substitutes after the outer
  // cmd has parsed its own line, so quotes and operators reach the inner cmd untouched; /s there strips
  // only our pair of quotes. Verbatim arguments stop Node from escaping quotes as \" (SPEC-006 FR-1).
  const args =
    shell === "cmd"
      ? ["/d", "/v:on", "/c", `chcp 65001 >nul & cmd.exe /d /s /c "!${CMD_COMMAND_VAR}!"`]
      : [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          psCommand,
        ];

  // Never pass the MCP API key or tunnel credentials to commands run by clients.
  const env = scrubbedEnv({
    PYTHONIOENCODING: "utf-8",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    ...(shell === "cmd" ? { [CMD_COMMAND_VAR]: command } : {}),
  });

  if (options.signal?.aborted) {
    return { exitCode: null, stdout: "", stderr: "", timedOut: false, truncated: false, backgroundLeft: false, aborted: true };
  }

  const result = await new Promise<CommandExecutionResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: actualCwd,
      windowsHide: true,
      windowsVerbatimArguments: shell === "cmd",
      detached: process.platform !== "win32",
      env,
    });

    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;

    const collect = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
    ): Buffer<ArrayBufferLike> => {
      if (current.length >= config.maxOutputBytes) {
        truncated = true;
        return current;
      }
      const remaining = config.maxOutputBytes - current.length;
      if (chunk.length > remaining) {
        truncated = true;
      }
      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = collect(stdout, chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = collect(stderr, chunk);
    });

    let exitCode: number | null = null;
    let exited = false;
    let aborted = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      clearTimeout(hardTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    // pipesHeld: someone else (an orphaned background process) still has stdout/stderr open.
    const finish = (pipesHeld: boolean) => {
      if (settled) return;
      cleanup();
      if (pipesHeld) {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      resolve({
        exitCode,
        stdout: decodeOutput(stdout),
        stderr: decodeOutput(stderr),
        timedOut,
        truncated,
        backgroundLeft: pipesHeld,
        aborted,
      });
    };

    const killAndBound = () => {
      if (child.pid) void killProcessTree(child.pid);
      // taskkill /T cannot reach children whose parent already exited, so do not wait for them.
      hardTimer ??= setTimeout(() => finish(true), HARD_STOP_GRACE_MS);
    };

    function onAbort() {
      if (settled) return;
      aborted = true;
      killAndBound();
    }

    child.once("error", (error) => {
      if (settled) return;
      cleanup();
      reject(error);
    });

    const timer = setTimeout(() => {
      if (exited) return;
      timedOut = true;
      killAndBound();
    }, timeout);

    // `close` waits for every copy of stdout/stderr, and a process started with `start /b`
    // keeps them open long after the shell exited: give the output a moment, then return.
    child.once("exit", (code) => {
      exited = true;
      exitCode = code;
      graceTimer = setTimeout(() => finish(true), OUTPUT_DRAIN_MS);
    });

    child.once("close", (code) => {
      exitCode = code ?? exitCode;
      finish(false);
    });

    options.signal?.addEventListener("abort", onAbort, { once: true });
  });

  // A bare `cd <dir>` updates the shared working directory, but only after it succeeded.
  const cdMatch = command.match(CD_COMMAND);
  if (cdMatch && result.exitCode === 0 && !result.timedOut && !result.aborted) {
    try {
      setActiveWorkingDir(path.resolve(actualCwd, cdMatch[1].trim()), scope);
    } catch {
      // Ignore: target is outside the sandbox or not a directory.
    }
  }

  auditLog("terminal_execute", {
    command,
    shell,
    cwd: actualCwd,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    backgroundLeft: result.backgroundLeft || undefined,
    aborted: result.aborted || undefined,
  });

  return result;
}
