import * as fs from "node:fs";
import { sensitiveValues } from "./env.js";

const REDACTED = "[REDACTED]";

// Tool results are not logs: only replace configured, literal values. Never rewrite source code by pattern.
// Initialize on first result, after dotenv has loaded. The process configuration is fixed until restart.
let outputSecrets: string[] | undefined;
export function redactOutput(text: string): string {
  const values = outputSecrets ??= sensitiveValues();
  for (const value of values) if (text.includes(value)) text = text.split(value).join(REDACTED);
  return text;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(authorization\s*[:=]\s*["']?bearer\s+)[^\s"']+/gi, "$1" + REDACTED],
  [/(x-api-key\s*[:=]\s*["']?)[^\s"']+/gi, "$1" + REDACTED],
  [/((?:api[_-]?key|authtoken|access[_-]?token|token|secret|password|passwd|pwd)["']?\s*[:=]\s*["']?)[^\s"';&|,]+/gi, "$1" + REDACTED],
];

/** Remove known server secrets and common credential patterns from text. */
export function redact(text: string): string {
  let output = text;
  for (const secret of sensitiveValues()) {
    output = output.split(secret).join(REDACTED);
    const trimmed = secret.trim(); // Preserve the more conservative audit policy.
    if (trimmed.length >= 8 && trimmed !== secret) output = output.split(trimmed).join(REDACTED);
  }
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
  }
  return value;
}

/**
 * Audit logger for MCP actions executed by remote AI agents.
 * Always prints a single `[AUDIT]` line (parsed by the desktop app).
 * When AUDIT_LOG_FILE is set, also appends a JSON line to that file.
 */
export function auditLog(action: string, details: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const clean = redactValue(details) as Record<string, unknown>;
  const serialized = Object.entries(clean)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");

  console.log(`[AUDIT] ${timestamp} | ${action.padEnd(17)} | ${serialized}`);

  const auditFile = process.env.AUDIT_LOG_FILE?.trim();
  if (auditFile) {
    try {
      fs.appendFileSync(auditFile, JSON.stringify({ timestamp, action, ...clean }) + "\n", "utf8");
    } catch (error) {
      console.error(`[AUDIT] Failed to write AUDIT_LOG_FILE: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
