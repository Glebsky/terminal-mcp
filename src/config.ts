import * as fs from "node:fs/promises";
import * as path from "node:path";
import dotenv from "dotenv";

if (process.env.DOTENV_PATH) {
  dotenv.config({ path: process.env.DOTENV_PATH, quiet: true });
} else {
  dotenv.config({ quiet: true });
}


function integerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanEnv(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return /^true$/i.test(value.trim());
}

const PORT = integerEnv("PORT", 3000);
const HOST = process.env.HOST || "127.0.0.1";
const API_KEY = process.env.MCP_API_KEY || "";
const FULL_ACCESS = booleanEnv("FULL_ACCESS", false);
const FILES_ROOT = path.resolve(process.env.FILES_ROOT || path.join(process.cwd(), "workspace"));
const COMMAND_TIMEOUT_MS = Math.min(integerEnv("COMMAND_TIMEOUT_MS", 120_000), 900_000);
const MAX_OUTPUT_BYTES = integerEnv("MAX_OUTPUT_BYTES", 1_048_576);
const MAX_FILE_BYTES = integerEnv("MAX_FILE_BYTES", 10_485_760);
const MAX_SSE_SESSIONS = integerEnv("MAX_SSE_SESSIONS", 32);
// Tool names hidden from agents, separated by semicolons/commas/spaces (e.g. "terminal_execute;file_delete").
const DISABLED_TOOLS: ReadonlySet<string> = new Set(
  (process.env.DISABLED_TOOLS || "")
    .split(/[;,\s]+/)
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

const requestedProvider = (process.env.TUNNEL_PROVIDER || "").trim().toLowerCase();
if (requestedProvider && !["none", "ngrok", "tuna", "cloudflare", "localtunnel"].includes(requestedProvider)) throw new Error("Unsupported TUNNEL_PROVIDER. Choose none, ngrok, tuna, cloudflare or localtunnel.");
const TUNNEL_PROVIDER = ["none", "ngrok", "tuna", "cloudflare", "localtunnel"].includes(requestedProvider)
  ? requestedProvider as "none" | "ngrok" | "tuna" | "cloudflare" | "localtunnel"
  : booleanEnv("NGROK_ENABLED", false) ? "ngrok" : "none";
const NGROK_ENABLED = TUNNEL_PROVIDER === "ngrok";
const NGROK_AUTHTOKEN = (process.env.NGROK_AUTHTOKEN || process.env.NGROK_TOKEN || "").trim();
const NGROK_DOMAIN = (process.env.NGROK_DOMAIN || "").trim();

const ALLOWED_HOSTS = new Set<string>(
  (process.env.ALLOWED_HOSTS || `localhost:${PORT};127.0.0.1:${PORT}`)
    .split(";")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean),
);

if (NGROK_DOMAIN) {
  ALLOWED_HOSTS.add(NGROK_DOMAIN.toLowerCase());
}

if (API_KEY.length < 32) {
  throw new Error("MCP_API_KEY must contain at least 32 characters. Generate one with: npm run token");
}

// Ensure sandbox directory exists
await fs.mkdir(FILES_ROOT, { recursive: true });

export const config = {
  port: PORT,
  host: HOST,
  apiKey: API_KEY,
  fullAccess: FULL_ACCESS,
  filesRoot: FILES_ROOT,
  commandTimeoutMs: COMMAND_TIMEOUT_MS,
  maxOutputBytes: MAX_OUTPUT_BYTES,
  maxFileBytes: MAX_FILE_BYTES,
  maxSseSessions: MAX_SSE_SESSIONS,
  disabledTools: DISABLED_TOOLS,
  allowedHosts: ALLOWED_HOSTS,
  tunnelProvider: TUNNEL_PROVIDER,
  tuna: { executable: (process.env.TUNA_EXECUTABLE || "tuna").trim(), apiKey: (process.env.TUNA_API_KEY || "").trim(), subdomain: (process.env.TUNA_SUBDOMAIN || "").trim() },
  cloudflare: {
    executable: (process.env.CLOUDFLARED_EXECUTABLE || "cloudflared").trim(),
    mode: process.env.CLOUDFLARE_MODE === "named" ? "named" as const : "quick" as const,
    token: (process.env.CLOUDFLARE_TUNNEL_TOKEN || "").trim(),
    publicUrl: (process.env.CLOUDFLARE_PUBLIC_URL || "").trim(),
  },
  localtunnel: {
    executable: (process.env.LOCALTUNNEL_EXECUTABLE || "lt").trim(),
    subdomain: (process.env.LOCALTUNNEL_SUBDOMAIN || "").trim(),
  },
  ngrok: {
    enabled: NGROK_ENABLED,
    authtoken: NGROK_AUTHTOKEN || undefined,
    domain: NGROK_DOMAIN || undefined,
  },
} as const;

export type Config = typeof config;
