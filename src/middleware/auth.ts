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

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const bearer = req.header("authorization")?.replace(/^Bearer\s+/i, "") || "";
  const apiKey = req.header("x-api-key") || "";

  if (safeEqual(bearer, config.apiKey) || safeEqual(apiKey, config.apiKey)) {
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

  res.setHeader("WWW-Authenticate", 'Bearer realm="notion-terminal-mcp"');
  res.status(401).json({ error: "Unauthorized" });
}
