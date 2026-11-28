import * as fs from "node:fs";
import * as path from "node:path";

/** Used by the FILES_ROOT sandbox and the independent server-owned path policy. */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Canonicalize the deepest existing ancestor as well as files that do not yet exist. */
export function realTarget(target: string): string | null {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(current), ...tail.reverse()); }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
      try { fs.lstatSync(current); return null; } // An existing entry that cannot be followed.
      catch (statErr) {
        if (!["ENOENT", "ENOTDIR"].includes((statErr as NodeJS.ErrnoException).code ?? "")) return null;
      }
      const parent = path.dirname(current);
      if (parent === current) return null;
      tail.push(path.basename(current)); current = parent;
    }
  }
}

function policyKey(input: string): string {
  const resolved = path.resolve(input);
  if (process.platform !== "win32") return resolved;
  // Compare Windows spellings according to the underlying file, not string case or a stream suffix.
  const flat = resolved.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
  const root = path.parse(flat).root;
  return (root + flat.slice(root.length).split(path.sep).map(p => p.split(":", 1)[0].replace(/[. ]+$/, "")).join(path.sep)).toLowerCase();
}
function forms(p: string): string[] {
  const real = realTarget(p), named = policyKey(p);
  return real ? [...new Set([named, policyKey(real)])] : [named];
}
function envName(name: string): boolean {
  if (process.platform === "win32") name = name.toLowerCase();
  return name === ".env" || (name.startsWith(".env.") && name !== ".env.example");
}

export interface ServerPaths { serverDir: string; envFile?: string; auditFile?: string; extra: readonly string[] }
export function buildProtectedSet(c: ServerPaths) {
  const set = new Set<string>();
  const add = (p: string) => { for (const name of forms(p)) set.add(name); };
  const directories = forms(c.serverDir);
  add(path.join(c.serverDir, ".env")); // Also protects ancestors if no .env exists yet.
  if (c.envFile) { add(c.envFile); add(path.dirname(path.resolve(c.envFile))); }
  if (c.auditFile) add(c.auditFile);
  for (const p of c.extra) add(p);
  // Pin physical targets of environment files already present; future names remain covered below.
  // Read names only, never their contents. Source connections are independent of FULL_ACCESS.
  try { for (const n of fs.readdirSync(c.serverDir)) if (envName(n)) add(path.join(c.serverDir,n)); } catch { /* name-based policy still applies */ }
  const roots = [...set];
  const reserved = (p: string) => roots.some(r => isInside(r,p)) || directories.some(d => isInside(d,p) && envName(path.relative(d,p).split(path.sep)[0]));
  return {
    /** A tree operation may also remove/replace the containing directory. */
    blocked(target: string, tree = false, physical: string | null = realTarget(target)): boolean {
      if (physical === null) return true;
      const named = policyKey(target), real = policyKey(physical);
      return reserved(named) || (real !== named && reserved(real)) || (tree && roots.some(r => isInside(named,r) || isInside(real,r)));
    },
  };
}
