// Boundary-safe helpers for tools that return text in pieces (SPEC-005 FR-5, SPEC-006).
import { execFileSync } from "node:child_process";

export const isUtf8Continuation = (byte: number) => (byte & 0xc0) === 0x80;

/** Length of the UTF-8 sequence started by a lead byte (1 for ASCII and malformed bytes). */
export function utf8SequenceLength(byte: number): number {
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 1;
}

/** Drop a trailing incomplete UTF-8 sequence, e.g. where a byte cap landed inside a character. */
export function trimIncompleteUtf8(bytes: Buffer): Buffer {
  let first = bytes.length - 1;
  const stop = Math.max(0, bytes.length - 4);
  while (first > stop && isUtf8Continuation(bytes[first])) first--;
  if (first < 0 || isUtf8Continuation(bytes[first])) return bytes;
  return first + utf8SequenceLength(bytes[first]) > bytes.length ? bytes.subarray(0, first) : bytes;
}

/** Cut text to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };
  return { text: trimIncompleteUtf8(bytes.subarray(0, Math.max(0, maxBytes))).toString("utf8"), truncated: true };
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** Move a UTF-16 index that points between the halves of a surrogate pair back to the pair's start. */
export function alignCodePoint(text: string, index: number): number {
  if (index > 0 && index < text.length && isLowSurrogate(text.charCodeAt(index)) && isHighSurrogate(text.charCodeAt(index - 1))) {
    return index - 1;
  }
  return index;
}

function codePointWidth(text: string, index: number): number {
  return isHighSurrogate(text.charCodeAt(index)) && index + 1 < text.length && isLowSurrogate(text.charCodeAt(index + 1)) ? 2 : 1;
}

export interface TextPage {
  content: string;
  offset: number;
  length: number;
  total_length: number;
  truncated: boolean;
  next_offset?: number;
}

/**
 * One page of a string: `offset` and `length` are UTF-16 indices (as in JavaScript), neither edge
 * splits a surrogate pair, and the page also fits into `maxBytes` of UTF-8. A page is never empty
 * before the end of the text, so following `next_offset` always terminates.
 */
export function pageText(text: string, offset = 0, length?: number, maxBytes = Number.POSITIVE_INFINITY): TextPage {
  const total = text.length;
  const start = alignCodePoint(text, Math.min(Math.max(0, Math.floor(offset)), total));
  let end = length === undefined ? total : alignCodePoint(text, Math.min(total, start + Math.max(1, Math.floor(length))));
  if (end <= start && start < total) end = start + codePointWidth(text, start);
  let content = text.slice(start, end);
  if (Number.isFinite(maxBytes)) {
    const capped = truncateUtf8(content, maxBytes);
    if (capped.truncated) content = capped.text || text.slice(start, start + codePointWidth(text, start));
  }
  const stop = start + content.length;
  const truncated = stop < total;
  return { content, offset: start, length: content.length, total_length: total, truncated, ...(truncated ? { next_offset: stop } : {}) };
}

/**
 * Up to `maxChars` of the trimmed line around a match at `index`. The result stays a verbatim
 * substring of the line (no ellipsis), so it can be used as a file_replace target.
 */
export function snippetAround(line: string, index: number, maxChars = 500): string {
  const trimmed = line.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const lead = line.length - line.trimStart().length;
  const at = Math.min(Math.max(0, index - lead), trimmed.length);
  let start = Math.max(0, Math.min(at - 100, trimmed.length - maxChars));
  // Step forward off a split pair: stepping back would push the window end into a match at the line's end.
  if (alignCodePoint(trimmed, start) !== start) start += 1;
  const end = alignCodePoint(trimmed, Math.min(trimmed.length, start + maxChars));
  return trimmed.slice(start, end);
}

// TextDecoder labels for Windows ANSI code pages that are not spelled windows-NNNN.
const ANSI_LABELS: Record<string, string> = { "932": "shift_jis", "936": "gbk", "949": "euc-kr", "950": "big5" };
let legacy: TextDecoder | null | undefined;

/** Decoder for the system ANSI code page (e.g. windows-1251) on Windows; null elsewhere or for UTF-8 systems. */
export function legacyDecoder(): TextDecoder | null {
  if (legacy !== undefined) return legacy;
  legacy = null;
  if (process.platform !== "win32") return legacy;
  try {
    const out = execFileSync("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage", "/v", "ACP"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
    });
    const codePage = /ACP\s+REG_SZ\s+(\d+)/.exec(out)?.[1];
    if (codePage && codePage !== "65001") legacy = new TextDecoder(ANSI_LABELS[codePage] ?? `windows-${codePage}`);
  } catch {
    legacy = null;
  }
  return legacy;
}

/**
 * Decode file bytes for text search: UTF-16 with a BOM, UTF-8, otherwise the system ANSI code page.
 * Returns null for binary data (NUL bytes without a UTF-16 BOM).
 */
export function decodeText(raw: Buffer): { text: string; encoding: string } | null {
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) return { text: raw.subarray(2).toString("utf16le"), encoding: "utf-16le" };
  if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(raw.subarray(2)), encoding: "utf-16be" };
  if (raw.includes(0)) return null;
  const text = raw.toString("utf8");
  if (Buffer.from(text, "utf8").equals(raw)) return { text, encoding: "utf-8" };
  const decoder = legacyDecoder();
  return decoder ? { text: decoder.decode(raw), encoding: decoder.encoding } : { text, encoding: "utf-8" };
}
