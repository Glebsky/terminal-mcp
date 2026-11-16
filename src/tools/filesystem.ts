import * as fs from "node:fs/promises";
import type { Dirent, Stats } from "node:fs";
import * as fsSync from "node:fs";
import * as path from "node:path";

import { config } from "../config.js";
import { auditLog } from "../utils/logger.js";

/**
 * Shared working directory used to resolve relative paths.
 * It is process-wide (shared by all clients) and only changes through
 * workspace_set_cwd or a successful bare `cd <dir>` terminal command.
 */
let currentWorkingDir: string = config.filesRoot;

function realpathOrResolve(target: string): string {
  try {
    return fsSync.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
}

const realFilesRoot = realpathOrResolve(config.filesRoot);

/** True when `target` equals `root` or lies inside it. */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isSamePath(left: string, right: string): boolean {
  return path.relative(left, right) === "";
}

/**
 * Resolves symlinks/junctions of the deepest existing ancestor, so paths that do
 * not exist yet are checked too. Returns null for dangling links (unsafe to follow).
 */
function realTarget(target: string): string | null {
  let existing = path.resolve(target);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = fsSync.realpathSync.native(existing);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      try {
        fsSync.lstatSync(existing);
        return null; // Entry exists but cannot be resolved: dangling symlink/junction.
      } catch {
        // Does not exist: continue with the parent.
      }
      const parent = path.dirname(existing);
      if (parent === existing) return path.resolve(target);
      rest.push(path.basename(existing));
      existing = parent;
    }
  }
}

function enforceSandbox(target: string, input: string): string {
  if (config.fullAccess) return target;
  const real = realTarget(target);
  if (!isInside(config.filesRoot, target) || real === null || !isInside(realFilesRoot, real)) {
    throw new Error(
      `Access denied: path "${input}" is outside sandbox directory (${config.filesRoot}). Set FULL_ACCESS=true to permit arbitrary paths.`,
    );
  }
  return target;
}

export function getActiveWorkingDir(): string {
  return currentWorkingDir;
}

export function setActiveWorkingDir(newDir: string): string {
  const resolved = resolveTarget(newDir);
  let stat: Stats;
  try {
    stat = fsSync.statSync(resolved);
  } catch {
    throw new Error(`Directory not found: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  currentWorkingDir = resolved;
  return currentWorkingDir;
}

/**
 * Resolves a path deterministically and validates it against the sandbox.
 *
 * - Absolute paths are used as-is.
 * - Relative paths resolve against the active working directory. If the path
 *   does not exist there but exists relative to FILES_ROOT, the FILES_ROOT
 *   location is used. No other directories are searched and resolution never
 *   changes the active working directory.
 * - Unless FULL_ACCESS=true, the real path (after resolving symlinks and
 *   junctions) must stay inside FILES_ROOT.
 */
export function resolveTarget(input: string): string {
  let cleaned = (input || "").trim();
  if (!cleaned) {
    return enforceSandbox(currentWorkingDir, input);
  }

  // Strip leading slash from Windows absolute paths like "/C:/foo"
  if (/^[/\\][a-zA-Z]:/.test(cleaned)) {
    cleaned = cleaned.slice(1);
  }

  let target: string;
  if (path.isAbsolute(cleaned)) {
    target = path.resolve(cleaned);
  } else {
    const fromCwd = path.resolve(currentWorkingDir, cleaned);
    const fromRoot = path.resolve(config.filesRoot, cleaned);
    target = fromCwd !== fromRoot && !fsSync.existsSync(fromCwd) && fsSync.existsSync(fromRoot)
      ? fromRoot
      : fromCwd;
  }

  return enforceSandbox(target, input);
}

export async function readFile(
  inputPath: string,
  encoding: "utf8" | "base64" = "utf8",
  offset = 0,
  length?: number,
) {
  const target = resolveTarget(inputPath);
  const handle = await fs.open(target, "r");

  try {
    const stat = await handle.stat();
    if (stat.isDirectory()) {
      throw new Error(`Path is a directory: ${target}`);
    }
    const bytesToRead = Math.min(
      length || config.maxFileBytes,
      Math.max(0, stat.size - offset),
      config.maxFileBytes,
    );
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);

    return {
      path: target,
      size: stat.size,
      offset,
      bytes_read: bytesRead,
      truncated: offset + bytesRead < stat.size,
      encoding,
      data: buffer.subarray(0, bytesRead).toString(encoding),
    };
  } finally {
    await handle.close();
  }
}

export async function writeFile(
  inputPath: string,
  data: string,
  encoding: "utf8" | "base64" = "utf8",
  append = false,
) {
  const target = resolveTarget(inputPath);
  const buffer = Buffer.from(data, encoding);

  if (buffer.length > config.maxFileBytes) {
    throw new Error(`Write exceeds MAX_FILE_BYTES (${config.maxFileBytes})`);
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buffer, { flag: append ? "a" : "w" });

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
) {
  const target = resolveTarget(inputPath);
  const stat = await fs.stat(target);
  if (stat.size > config.maxFileBytes) {
    throw new Error(`File exceeds MAX_FILE_BYTES (${config.maxFileBytes})`);
  }
  const original = await fs.readFile(target, "utf8");

  const occurrences = original.split(targetContent).length - 1;
  if (occurrences === 0) {
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

  await fs.writeFile(target, updated, "utf8");

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
}

// Recursive listing/search never descends into these directories.
const SKIPPED_LIST_DIRS = new Set(["node_modules", ".git"]);
const SKIPPED_SEARCH_DIRS = new Set(["node_modules", ".git", "dist"]);

export async function listFiles(
  inputPath: string,
  recursive = false,
  maxEntries = 500,
) {
  const root = resolveTarget(inputPath);
  const entries: FileEntry[] = [];
  let truncated = false;

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

      if (entry.isFile()) {
        try {
          item.size = (await fs.stat(fullPath)).size;
        } catch {
          // File disappeared or is not accessible.
        }
      }

      entries.push(item);
      // Symlinked directories are reported but not followed.
      if (recursive && entry.isDirectory() && !SKIPPED_LIST_DIRS.has(entry.name)) {
        await visit(fullPath);
      }
    }
  };

  await visit(root);
  return {
    root,
    entries,
    truncated,
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
  snippet?: string;
}

export const MAX_SEARCH_QUERY_LENGTH = 512;
const MAX_SEARCH_LINE_LENGTH = 4000;
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
) {
  const root = resolveTarget(inputPath);
  const results: SearchMatch[] = [];
  const queryRegex = query ? compileSearchQuery(query, caseSensitive) : null;
  let truncated = false;

  const visit = async (directory: string): Promise<void> => {
    if (results.length >= maxResults) {
      truncated = true;
      return;
    }

    let dirEntries: Dirent[] = [];
    try {
      dirEntries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of dirEntries) {
      if (results.length >= maxResults) {
        truncated = true;
        return;
      }
      const fullPath = path.join(directory, entry.name);

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
          if (stat.size > 2 * 1024 * 1024) continue; // Skip files > 2MB for grep

          const content = await fs.readFile(fullPath, "utf8");
          if (content.includes("\u0000")) continue; // Skip binary files
          const lines = content.split(/\r?\n/);

          for (let i = 0; i < lines.length; i++) {
            if (results.length >= maxResults) {
              truncated = true;
              break;
            }
            const line = lines[i].length > MAX_SEARCH_LINE_LENGTH ? lines[i].slice(0, MAX_SEARCH_LINE_LENGTH) : lines[i];
            if (queryRegex.test(line)) {
              results.push({
                path: fullPath,
                line: i + 1,
                snippet: line.trim().slice(0, 500),
              });
            }
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  };

  await visit(root);

  auditLog("file_search", {
    path: root,
    pattern: pattern || undefined,
    query: query || undefined,
    results: results.length,
  });

  return {
    root,
    results,
    truncated,
  };
}

export async function statPath(inputPath: string) {
  const target = resolveTarget(inputPath);
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
    type: isSymlink ? "symlink" : stat.isDirectory() ? "directory" : "file",
    target_type: isSymlink ? (stat.isDirectory() ? "directory" : stat === linkStat ? "missing" : "file") : undefined,
    link_target: linkTarget,
    size: stat.size,
    created_at: stat.birthtime.toISOString(),
    modified_at: stat.mtime.toISOString(),
    mode: stat.mode,
  };
}

export async function createDirectory(inputPath: string) {
  const target = resolveTarget(inputPath);
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
) {
  const from = resolveTarget(source);
  const to = resolveTarget(destination);

  if (from === to) {
    throw new Error("Source and destination are the same path");
  }
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

  if (backup) {
    await fs.rm(backup, { recursive: true, force: true });
  }

  auditLog("file_move", { from, to, overwrite });
  return { source: from, destination: to, replaced: destinationExists };
}

export async function deletePath(inputPath: string, recursive = false) {
  const target = resolveTarget(inputPath);
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
  await fs.rm(target, { recursive: isDirectory && recursive, force: false });

  if (isInside(target, currentWorkingDir)) {
    currentWorkingDir = config.filesRoot;
  }

  auditLog("file_delete", { path: target, recursive });
  return { path: target, deleted: true };
}
