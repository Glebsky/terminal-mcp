import { redactOutput } from "../utils/logger.js";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  [key: string]: unknown;
  content: TextContent[];
  isError?: boolean;
}

export function textResult(value: unknown, isError = false): ToolResult {
  // Pagination has already happened. Redact before JSON escaping to handle quotes and backslashes,
  // including keys in arbitrary JSON output, and leave offsets/byte counts untouched.
  const text = typeof value === "string" ? redactOutput(value) : JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "string") return redactOutput(v);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const entries = Object.entries(v);
      if (entries.some(([k]) => redactOutput(k) !== k)) return Object.fromEntries(entries.map(([k,item]) => [redactOutput(k),item]));
    }
    return v;
  }, 2);
  return { content: [{ type: "text", text }], isError };
}

export function errorResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return textResult({ error: message }, true);
}
