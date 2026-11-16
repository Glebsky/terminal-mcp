import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { auditLog } from "../utils/logger.js";

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Failed attempts are limited globally: behind a tunnel every client shares one
// address, and a valid key is always accepted, so legitimate clients are never blocked.
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES_PER_WINDOW = 30;
let failureWindowStart = 0;
let failuresInWindow = 0;

function registerFailure(now: number): boolean {
  if (now - failureWindowStart > FAILURE_WINDOW_MS) {
    failureWindowStart = now;
    failuresInWindow = 0;
  }
  failuresInWindow += 1;
  if (failuresInWindow === MAX_FAILURES_PER_WINDOW + 1) {
    auditLog("auth_rate_limited", { failures: failuresInWindow, windowMs: FAILURE_WINDOW_MS });
  }
  return failuresInWindow > MAX_FAILURES_PER_WINDOW;
}

/** Query parameter names accepted for the key when AUTH_METHODS includes "query". */
export const QUERY_KEY_PARAMS = ["key", "api_key", "token"] as const;

function queryKey(req: Request): string {
  for (const name of QUERY_KEY_PARAMS) {
    const value = req.query[name];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function basicCredentialsMatch(header: string): boolean {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (!match?.[1]) return false;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  // Compare both parts every time so the response time doesn't reveal which one was wrong.
  const userOk = safeEqual(decoded.slice(0, separator), config.auth.basicUser);
  const passwordOk = safeEqual(decoded.slice(separator + 1), config.auth.basicPassword);
  return userOk && passwordOk;
}

/** Whether the request carries valid credentials for one of the enabled AUTH_METHODS. */
export function isAuthorized(req: Request): boolean {
  const methods = config.auth.methods;
  if (methods.has("none")) return true;
  const header = req.header("authorization") || "";
  if (methods.has("bearer")) {
    const bearer = header.replace(/^Bearer\s+/i, "");
    const apiKey = req.header("x-api-key") || "";
    if (safeEqual(bearer, config.apiKey) || safeEqual(apiKey, config.apiKey)) return true;
  }
  if (methods.has("query") && safeEqual(queryKey(req), config.apiKey)) return true;
  if (methods.has("basic") && basicCredentialsMatch(header)) return true;
  return false;
}

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  if (isAuthorized(req)) {
    next();
    return;
  }

  const now = Date.now();
  if (registerFailure(now)) {
    const retryAfter = Math.max(1, Math.ceil((failureWindowStart + FAILURE_WINDOW_MS - now) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: "Too many failed authentication attempts" });
    return;
  }

  const challenges: string[] = [];
  if (config.auth.methods.has("bearer")) challenges.push('Bearer realm="notion-terminal-mcp"');
  if (config.auth.methods.has("basic")) challenges.push('Basic realm="notion-terminal-mcp", charset="UTF-8"');
  if (challenges.length) res.setHeader("WWW-Authenticate", challenges);
  res.status(401).json({ error: "Unauthorized" });
}

/** Human-readable list of enabled methods for the public server info endpoint. */
export function authDescription(): string {
  const labels: Record<string, string> = { bearer: "Bearer Token", query: "Key in URL", basic: "HTTP Basic", none: "None" };
  return [...config.auth.methods].map((method) => labels[method] || method).join(", ");
}
