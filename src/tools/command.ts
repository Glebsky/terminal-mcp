import { spawn } from "node:child_process";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { config } from "../config.js";
import { auditLog } from "../utils/logger.js";
import { scrubbedEnv } from "../utils/env.js";
import { resolveTarget, getActiveWorkingDir, setActiveWorkingDir } from "./filesystem.js";

export interface CommandExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
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
): Promise<CommandExecutionResult> {
  // `cwd` applies to this call only and does not change the shared working directory.
  const actualCwd = cwd ? resolveTarget(cwd) : getActiveWorkingDir();
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

  // Ensure UTF-8 output encoding on Windows shells
  const utf8Command =
    shell === "cmd"
      ? `chcp 65001 > nul & ${command}`
      : `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`;

  const args =
    shell === "cmd"
      ? ["/d", "/s", "/c", utf8Command]
      : [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          utf8Command,
        ];

  // Never pass the MCP API key or tunnel credentials to commands run by clients.
  const env = scrubbedEnv({
    PYTHONIOENCODING: "utf-8",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
  });

  const result = await new Promise<CommandExecutionResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: actualCwd,
      windowsHide: true,
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

    child.once("error", reject);

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        void killProcessTree(child.pid);
      }
    }, timeout);

    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        timedOut,
        truncated,
      });
    });
  });

  // A bare `cd <dir>` updates the shared working directory, but only after it succeeded.
  const cdMatch = command.match(CD_COMMAND);
  if (cdMatch && result.exitCode === 0 && !result.timedOut) {
    try {
      setActiveWorkingDir(path.resolve(actualCwd, cdMatch[1].trim()));
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
  });

  return result;
}
