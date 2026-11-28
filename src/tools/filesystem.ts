import * as fs from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import * as fsSync from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";

import { config } from "../config.js";
import { auditLog } from "../utils/logger.js";
import { buildProtectedSet, isInside, realTarget } from "../utils/protected.js";
export { isInside } from "../utils/protected.js";
import { decodeText, isUtf8Continuation, snippetAround, utf8SequenceLength } from "../utils/text.js";

/**
 * Process-wide working directory used to resolve relative paths. Stateless /mcp requests share it;
 * every SSE session works on its own copy (SPEC-005 FR-2), so one agent's workspace_set_cwd or
 * `cd` does not move another agent's writes.
 */
let currentWorkingDir: string = config.filesRoot;

export interface WorkspaceScope {
  get(): string;
  set(dir: string): void;
}

export const globalScope: WorkspaceScope = {
  get: () => currentWorkingDir,
  set: (dir) => {
    currentWorkingDir = dir;
  },
};

/** Working directory of one MCP session; starts from the shared one at connect time. */
export function createSessionScope(): WorkspaceScope {
  let cwd = currentWorkingDir;
  return {
    get: () => cwd,
    set: (dir) => {
      cwd = dir;
    },
  };
}

function realpathOrResolve(target: string): string {
  try {
    return fsSync.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

const realFilesRoot = realpathOrResolve(config.filesRoot);

const protection = buildProtectedSet(config.serverPaths);

function isSamePath(left: string, right: string): boolean {
  return path.relative(left, right) === "";
}

function enforceSandbox(target: string, input: string, real: string | null): string {
  if (config.fullAccess) return target;
  if (!isInside(config.filesRoot, target) || real === null || !isInside(realFilesRoot, real)) {
    throw new Error(
      `Access denied: path "${input}" is outside sandbox directory (${config.filesRoot}). Set FULL_ACCESS=true to permit arbitrary paths.`,
    );
  }
  return target;
}

export function getActiveWorkingDir(scope: WorkspaceScope = globalScope): string {
  return scope.get();
}

export function setActiveWorkingDir(newDir: string, scope: WorkspaceScope = globalScope): string {
  const resolved = resolveTarget(newDir, { cwd: scope.get(), tool: "workspace_set_cwd" });
  let stat: Stats;
  try {
    stat = fsSync.statSync(resolved);
  } catch {
    throw new Error(`Directory not found: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  scope.set(resolved);
  return resolved;
}

/**
 * Resolves a path deterministically and validates it against the sandbox.
 *
 * - Absolute paths are used as-is.
 * - Relative paths resolve against the working directory (`options.cwd`, by default
 *   the shared one). For reads only: if the path does not exist there but exists
 *   relative to FILES_ROOT, the FILES_ROOT location is used. Mutating operations
 *   (`options.mutating`) never fall back, so the same write always lands in the same
 *   place (SPEC-005 FR-2.1). Resolution never changes the working directory.
 * - Unless FULL_ACCESS=true, the real path (after resolving symlinks and
 *   junctions) must stay inside FILES_ROOT.
 */
export interface ResolveOptions {
  cwd?: string;
  mutating?: boolean;
  tool?: string;
  intent?: "content" | "metadata" | "tree";
}

function authorize(target: string, input: string, options: ResolveOptions): string {
  const real = realTarget(target);
  enforceSandbox(target,input,real);
  if (options.intent !== "metadata" && protection.blocked(target,options.intent === "tree",real)) {
    auditLog("protected_denied", { tool: options.tool ?? "filesystem", path: target });
    throw new Error(`Access denied: "${target}" is protected server configuration`);
  }
  return target;
}

export function resolveTarget(input: string, options: ResolveOptions = {}): string {
  const base = options.cwd ?? currentWorkingDir;
  let cleaned = (input || "").trim();
  if (!cleaned) {
    return authorize(base, input, options);
  }

  // Strip leading slash from Windows absolute paths like "/C:/foo"
  if (/^[/\\][a-zA-Z]:/.test(cleaned)) {
    cleaned = cleaned.slice(1);
  }

  let target: string;
  if (path.isAbsolute(cleaned)) {
    target = path.resolve(cleaned);
  } else {
    const fromCwd = path.resolve(base, cleaned);
    const fromRoot = path.resolve(config.filesRoot, cleaned);
    target = !options.mutating && fromCwd !== fromRoot && !fsSync.existsSync(fromCwd) && fsSync.existsSync(fromRoot)
      ? fromRoot
      : fromCwd;
  }

  return authorize(target, input, options);
}

// Per-path FIFO queues for mutating operations (SPEC-005 FR-1.1). All keys of one call are taken
// in the same tick and each caller only waits for earlier holders, so there are no deadlocks.
const pathQueues = new Map<string, Promise<void>>();

function lockKey(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export async function withPathLock<T>(targets: string[], fn: () => Promise<T>): Promise<T> {
  const keys = [...new Set(targets.map(lockKey))];
  const previous = keys.map((key) => pathQueues.get(key));
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (const key of keys) pathQueues.set(key, held);
  try {
    await Promise.all(previous);
    return await fn();
  } finally {
    release();
    for (const key of keys) if (pathQueues.get(key) === held) pathQueues.delete(key);
  }
}

// Antivirus, indexers and editors briefly hold files open on Windows.
const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      if (attempt >= 5 || !RENAME_RETRY_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 40 * 2 ** attempt));
    }
  }
}

/**
 * Replace file contents so readers see the old or the new version, never a half-written one
 * (SPEC-005 FR-1.2). If another program keeps the file open and the swap keeps failing, write
 * in place instead; callers hold the path lock, so our own writes still cannot interleave.
 */
async function atomicWrite(target: string, data: Buffer | string): Promise<void> {
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`,
  );
  await fs.writeFile(temp, data, { flag: "wx" });
  try {
    if (process.platform !== "win32") {
      const mode = await fs.stat(target).then((stat) => stat.mode, () => undefined);
      if (mode !== undefined) await fs.chmod(temp, mode);
    }
    await renameWithRetry(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    if (!RENAME_RETRY_CODES.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
    await fs.writeFile(target, data);
  }
}

function chunkResult(target: string, size: number, offset: number, chunk: Buffer, encoding: "utf8" | "base64") {
  const truncated = offset + chunk.length < size;
  return {
    path: target,
    size,
    offset,
    bytes_read: chunk.length,
    truncated,
    ...(truncated ? { next_offset: offset + chunk.length } : {}),
    encoding,
    data: chunk.toString(encoding),
  };
}

export async function readFile(
  inputPath: string,
  encoding: "utf8" | "base64" = "utf8",
  offset = 0,
  length?: number,
  cwd?: string,
) {
  const target = resolveTarget(inputPath, { cwd, tool: "file_read" });
  const handle = await fs.open(target, "r");

  try {
    const stat = await handle.stat();
    if (stat.isDirectory()) {
      throw new Error(`Path is a directory: ${target}`);
    }
    const wanted = Math.min(length || config.maxFileBytes, config.maxFileBytes);
    if (offset >= stat.size) {
      return chunkResult(target, stat.size, offset, Buffer.alloc(0), encoding);
    }

    if (encoding === "base64") {
      const bytesToRead = Math.min(wanted, stat.size - offset);
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
      return chunkResult(target, stat.size, offset, buffer.subarray(0, bytesRead), encoding);
    }

    // UTF-8 (SPEC-005 FR-5): read up to 3 bytes on both sides of the requested window so that
    // neither edge of the chunk splits a character. The caller continues from next_offset.
    const lead = Math.min(offset, 3);
    const windowStart = offset - lead;
    const windowLength = Math.min(lead + wanted + 3, stat.size - windowStart);
    const window = Buffer.alloc(windowLength);
    const { bytesRead } = await handle.read(window, 0, windowLength, windowStart);
    const bytes = window.subarray(0, bytesRead);

    // An offset inside a character moves back to the character's first byte.
    let start = Math.min(lead, bytes.length);
    if (start < bytes.length && isUtf8Continuation(bytes[start])) {
      let first = start;
      while (first > 0 && isUtf8Continuation(bytes[first])) first--;
      if (!isUtf8Continuation(bytes[first]) && first + utf8SequenceLength(bytes[first]) > start) start = first;
    }

    // An end inside a character moves back before it; a chunk too short for one character grows to hold it.
    let end = Math.min(start + wanted, bytes.length);
    if (end < bytes.length && isUtf8Continuation(bytes[end])) {
      let first = end - 1;
      while (first > start && isUtf8Continuation(bytes[first])) first--;
      const charEnd = first + utf8SequenceLength(bytes[first]);
      if (!isUtf8Continuation(bytes[first]) && charEnd > end) {
        end = first > start ? first : Math.min(charEnd, bytes.length);
      }
    }

    return chunkResult(target, stat.size, windowStart + start, bytes.subarray(start, end), encoding);
  } finally {
    await handle.close();
  }
}

export async function writeFile(
  inputPath: string,
  data: string,
  encoding: "utf8" | "base64" = "utf8",
  append = false,
  cwd?: string,
) {
  const target = resolveTarget(inputPath, { cwd, mutating: true, tool: "file_write" });
  const buffer = Buffer.from(data, encoding);

  if (buffer.length > config.maxFileBytes) {
    throw new Error(`Write exceeds MAX_FILE_BYTES (${config.maxFileBytes})`);
  }

  await withPathLock([target], async () => {
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (append) await fs.appendFile(target, buffer);
    else await atomicWrite(target, buffer);
  });

  auditLog("file_write", { path: target, bytes: buffer.length, appended: append });

  return {
    path: target,
    bytes_written: buffer.length,
    appended: append,
  };
}

export async function replaceInFile(
  inputPath: string,
  targetContent: string,
  replacementContent: string,
  allowMultiple = false,
  cwd?: string,
) {
  const target = resolveTarget(inputPath, { cwd, mutating: true, tool: "file_replace" });
  return withPathLock([target], () => replaceLocked(target, inputPath, targetContent, replacementContent, allowMultiple));
}

async function replaceLocked(
  target: string,
  inputPath: string,
  targetContent: string,
  replacementContent: string,
  allowMultiple: boolean,
): Promise<{ path: string; replacements: number; already_applied?: true }> {
  const stat = await fs.stat(target);
  if (stat.size > config.maxFileBytes) {
    throw new Error(`File exceeds MAX_FILE_BYTES (${config.maxFileBytes})`);
  }
  const raw = await fs.readFile(target);
  const original = raw.toString("utf8");
  // Decoding cp1251 & co. as UTF-8 and writing it back would replace every non-ASCII byte (FR-1.3).
  if (!Buffer.from(original, "utf8").equals(raw)) {
    throw new Error(
      `File "${inputPath}" is not valid UTF-8 (for example cp1251), so file_replace would corrupt it. Read it with encoding=base64 and write it back with file_write instead.`,
    );
  }

  const occurrences = original.split(targetContent).length - 1;
  if (occurrences === 0) {
    // A retried call whose first attempt already landed reports success instead of an error (FR-1.4).
    if (!allowMultiple && replacementContent && original.split(replacementContent).length - 1 === 1) {
      auditLog("file_replace", { path: target, replacements: 0, alreadyApplied: true });
      return { path: target, replacements: 0, already_applied: true };
    }
    throw new Error(`Target content was not found in file "${inputPath}". Verify exact whitespace, indentation, and newlines.`);
  }
  if (occurrences > 1 && !allowMultiple) {
    throw new Error(
      `Target content appears ${occurrences} times in file "${inputPath}". Provide more unique surrounding context or set allow_multiple: true.`,
    );
  }

  // Literal replacement: never interpret `$&`, `$$`, `$'` etc. as String.replace patterns.
  let updated: string;
  let replacements: number;
  if (allowMultiple) {
    updated = original.split(targetContent).join(replacementContent);
    replacements = occurrences;
  } else {
    const index = original.indexOf(targetContent);
    updated = original.slice(0, index) + replacementContent + original.slice(index + targetContent.length);
    replacements = 1;
  }

  if (Buffer.byteLength(updated, "utf8") > config.maxFileBytes) {
    throw new Error(`Result exceeds MAX_FILE_BYTES (${config.maxFileBytes})`);
  }

  await atomicWrite(target, updated);

  auditLog("file_replace", { path: target, replacements });

  return {
    path: target,
    replacements,
  };
}

export interface FileEntry {
  path: string;
  type: "file" | "directory" | "symlink";
  size?: number;
  protected?: true;
}

// Recursive listing/search never descends into these directories.
const SKIPPED_LIST_DIRS = new Set(["node_modules", ".git"]);
const SKIPPED_SEARCH_DIRS = new Set(["node_modules", ".git", "dist"]);

export async function listFiles(
  inputPath: string,
  recursive = false,
  maxEntries = 500,
  cwd?: string,
  offset = 0,
) {
  const root = resolveTarget(inputPath, { cwd, tool: "file_list", intent: "metadata" });
  const entries: FileEntry[] = [];
  let truncated = false;
  // Entries before `offset` are walked but not returned, so a caller can page with next_offset.
  // Pages stay consistent while the tree does not change (SPEC-006 FR-5).
  let seen = 0;

  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      const fullPath = path.join(directory, entry.name);
      const item: FileEntry = {
        path: fullPath,
        type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
      };
      const include = seen++ >= offset;

      if (include && entry.isFile()) {
        try {
          item.size = (await fs.stat(fullPath)).size;
        } catch {
          // File disappeared or is not accessible.
        }
      }

      if (include) {
        if (protection.blocked(fullPath)) item.protected = true;
        entries.push(item);
      }
      // Symlinked directories are reported but not followed.
      if (recursive && entry.isDirectory() && !SKIPPED_LIST_DIRS.has(entry.name)) {
        await visit(fullPath);
      }
    }
  };

  await visit(root);
  return {
    root,
    ...(protection.blocked(root) ? { protected: true } : {}),
    entries,
    truncated,
    ...(truncated ? { next_offset: offset + entries.length } : {}),
  };
}

function matchesGlob(filename: string, pattern: string): boolean {
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  const regex = new RegExp(`^${regexPattern}$`, "i");
  return regex.test(filename);
}

export interface SearchMatch {
  path: string;
  line?: number;
  /** 1-based UTF-16 column of the match. */
  column?: number;
  snippet?: string;
  /** Set when the file is not UTF-8 (e.g. windows-1251, utf-16le). */
  encoding?: string;
}

export const MAX_SEARCH_QUERY_LENGTH = 512;
// Long lines (minified code, JSON) are searched in overlapping windows: the whole line is covered
// while one regex run stays bounded. A match longer than the overlap can be missed (SPEC-006 FR-3.1).
const SEARCH_WINDOW = 4000;
const SEARCH_OVERLAP = 1000;

/** UTF-16 index of the first match in the line, or -1. */
function findInLine(regex: RegExp, line: string): number {
  if (line.length <= SEARCH_WINDOW) {
    const match = regex.exec(line);
    return match ? match.index : -1;
  }
  const anchored = regex.source.includes("^") || regex.source.includes("$");
  for (let start = 0; start < line.length; start += SEARCH_WINDOW - SEARCH_OVERLAP) {
    const window = line.slice(start, start + SEARCH_WINDOW);
    const match = regex.exec(window);
    const isLast = start + SEARCH_WINDOW >= line.length;
    if (match) {
      // A window edge is not a line edge: ^ / $ matches there are false; real ones sit inside a neighbour window.
      const atFalseStart = start > 0 && match.index === 0;
      const atFalseEnd = !isLast && match.index + match[0].length === window.length;
      if (!anchored || (!atFalseStart && !atFalseEnd)) return start + match.index;
    }
    if (isLast) break;
  }
  return -1;
}
// A group containing a quantifier that is itself quantified, e.g. (a+)+ or (\w*)*.
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/;

/** Compile a user-provided search regex with basic protection against catastrophic backtracking. */
export function compileSearchQuery(query: string, caseSensitive = false): RegExp {
  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    throw new Error(`Search query is too long (max ${MAX_SEARCH_QUERY_LENGTH} characters)`);
  }
  if (NESTED_QUANTIFIER.test(query)) {
    throw new Error("Search query rejected: nested quantifiers such as (a+)+ can hang the server. Simplify the pattern.");
  }
  try {
    return new RegExp(query, caseSensitive ? "" : "i");
  } catch (error) {
    throw new Error(`Invalid search regex: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function searchFiles(
  inputPath: string,
  pattern?: string,
  query?: string,
  caseSensitive = false,
  maxResults = 100,
  cwd?: string,
) {
  const root = resolveTarget(inputPath, { cwd, tool: "file_search", intent: "metadata" });
  const results: SearchMatch[] = [];
  const queryRegex = query ? compileSearchQuery(query, caseSensitive) : null;
  let truncated = false;
  // "No matches" must mean "searched and not found": whatever was not searched is reported (SPEC-006 FR-3.2).
  const skipped: { path: string; reason: string }[] = [];
  let skippedTotal = 0;
  const skip = (target: string, reason: string) => {
    skippedTotal++;
    if (skipped.length < 50) skipped.push({ path: target, reason });
  };
  const skipPrivate = (p: string) => {
    if (!protection.blocked(p)) return false;
    skip(p, "protected");
    auditLog("protected_denied", {tool:"file_search", path:p});
    return true;
  };
  const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code ?? "error";

  const visit = async (directory: string): Promise<void> => {
    if (results.length >= maxResults) {
      truncated = true;
      return;
    }

    let dirEntries: Dirent[] = [];
    try {
      dirEntries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      skip(directory, `unreadable directory (${errorCode(error)})`);
      return;
    }

    for (const entry of dirEntries) {
      if (results.length >= maxResults) {
        truncated = true;
        return;
      }
      const fullPath = path.join(directory, entry.name);
      if (skipPrivate(fullPath)) continue;

      if (entry.isDirectory()) {
        if (SKIPPED_SEARCH_DIRS.has(entry.name)) continue;
        await visit(fullPath);
      } else if (entry.isFile()) {
        const filenameMatches = !pattern || matchesGlob(entry.name, pattern);
        if (!filenameMatches) continue;

        if (!queryRegex) {
          results.push({ path: fullPath });
          continue;
        }

        try {
          const stat = await fs.stat(fullPath);
          if (stat.size > config.maxFileBytes) {
            skip(fullPath, `larger than MAX_FILE_BYTES (${stat.size} > ${config.maxFileBytes} bytes)`);
            continue;
          }

          // UTF-16 with BOM, UTF-8, otherwise the system ANSI code page (SPEC-006 FR-3.3).
          const decoded = decodeText(await fs.readFile(fullPath));
          if (!decoded) continue; // Binary file
          const lines = decoded.text.split(/\r?\n/);

          for (let i = 0; i < lines.length; i++) {
            if (results.length >= maxResults) {
              truncated = true;
              break;
            }
            const index = findInLine(queryRegex, lines[i]);
            if (index < 0) continue;
            results.push({
              path: fullPath,
              line: i + 1,
              column: index + 1,
              snippet: snippetAround(lines[i], index),
              ...(decoded.encoding !== "utf-8" ? { encoding: decoded.encoding } : {}),
            });
          }
        } catch (error) {
          skip(fullPath, `unreadable (${errorCode(error)})`);
        }
      }
    }
  };

  if (!skipPrivate(root)) await visit(root);

  auditLog("file_search", {
    path: root,
    pattern: pattern || undefined,
    query: query || undefined,
    results: results.length,
    skipped: skippedTotal || undefined,
  });

  return {
    root,
    results,
    truncated,
    ...(skippedTotal ? { skipped, skipped_total: skippedTotal } : {}),
  };
}

export async function statPath(inputPath: string, cwd?: string) {
  const target = resolveTarget(inputPath, { cwd, tool: "file_stat", intent: "metadata" });
  const linkStat = await fs.lstat(target);
  const isSymlink = linkStat.isSymbolicLink();
  let stat: Stats = linkStat;
  let linkTarget: string | undefined;

  if (isSymlink) {
    linkTarget = await fs.readlink(target).catch(() => undefined);
    stat = await fs.stat(target).catch(() => linkStat);
  }

  return {
    path: target,
    ...(protection.blocked(target) ? { protected: true } : {}),
    type: isSymlink ? "symlink" : stat.isDirectory() ? "directory" : "file",
    target_type: isSymlink ? (stat.isDirectory() ? "directory" : stat === linkStat ? "missing" : "file") : undefined,
    link_target: linkTarget,
    size: stat.size,
    created_at: stat.birthtime.toISOString(),
    modified_at: stat.mtime.toISOString(),
    mode: stat.mode,
  };
}

export async function createDirectory(inputPath: string, cwd?: string) {
  const target = resolveTarget(inputPath, { cwd, mutating: true, tool: "file_mkdir" });
  await fs.mkdir(target, { recursive: true });
  auditLog("file_mkdir", { path: target });
  return { path: target, created: true };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function renameOrCopy(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    // Different drive/volume: copy, then remove the source.
    await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    await fs.rm(from, { recursive: true, force: false });
  }
}

export async function movePath(
  source: string,
  destination: string,
  overwrite = false,
  cwd?: string,
) {
  const from = resolveTarget(source, { cwd, mutating: true, tool: "file_move", intent: "tree" });
  const to = resolveTarget(destination, { cwd, mutating: true, tool: "file_move", intent: "tree" });

  if (from === to) {
    throw new Error("Source and destination are the same path");
  }
  return withPathLock([from, to], () => moveLocked(from, to, overwrite));
}

async function moveLocked(from: string, to: string, overwrite: boolean) {
  await fs.lstat(from); // Fails with ENOENT when the source is missing.

  const caseOnlyRename = process.platform === "win32" && from.toLowerCase() === to.toLowerCase();
  if (!caseOnlyRename && isInside(from, to)) {
    throw new Error("Cannot move a directory into itself");
  }

  const destinationExists = !caseOnlyRename && (await pathExists(to));
  if (destinationExists && !overwrite) {
    throw new Error(`Destination already exists: ${to}. Set overwrite=true to replace it.`);
  }

  await fs.mkdir(path.dirname(to), { recursive: true });

  // Keep the old destination until the move succeeded, so a failure loses nothing.
  let backup: string | null = null;
  if (destinationExists) {
    backup = `${to}.mcp-backup-${Date.now()}`;
    await fs.rename(to, backup);
  }

  try {
    await renameOrCopy(from, to);
  } catch (error) {
    if (backup) {
      await fs.rename(backup, to).catch(() => undefined);
    }
    throw error;
  }

  // The move already succeeded: a backup that cannot be removed is reported, not raised (FR-1.5).
  let backupLeft: string | undefined;
  if (backup) {
    await fs.rm(backup, { recursive: true, force: true }).catch(() => {
      backupLeft = backup;
    });
  }

  auditLog("file_move", { from, to, overwrite, backupLeft });
  return { source: from, destination: to, replaced: destinationExists, ...(backupLeft ? { backup_left: backupLeft } : {}) };
}

export async function deletePath(inputPath: string, recursive = false, scope: WorkspaceScope = globalScope) {
  const target = resolveTarget(inputPath, { cwd: scope.get(), mutating: true, tool: "file_delete", intent: "tree" });
  const parsed = path.parse(target);

  if (target === parsed.root) {
    throw new Error("Refusing to delete a filesystem root directory");
  }
  if (isSamePath(target, config.filesRoot) || isSamePath(target, realFilesRoot) || isInside(target, config.filesRoot)) {
    throw new Error("Refusing to delete FILES_ROOT or a directory that contains it");
  }

  const stat = await fs.lstat(target);
  const isDirectory = stat.isDirectory();
  if (isDirectory && !recursive) {
    throw new Error("recursive=true is required to delete a directory");
  }

  // Symlinks/junctions are removed themselves; their targets are never touched.
  await withPathLock([target], () => fs.rm(target, { recursive: isDirectory && recursive, force: false }));

  // A working directory inside the deleted tree falls back to FILES_ROOT: this session's and the shared one.
  if (isInside(target, scope.get())) scope.set(config.filesRoot);
  if (isInside(target, currentWorkingDir)) currentWorkingDir = config.filesRoot;

  auditLog("file_delete", { path: target, recursive });
  return { path: target, deleted: true };
}
