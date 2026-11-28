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

// How clients may authenticate (semicolon-separated): bearer = Authorization: Bearer <key> or X-API-Key header,
// query = ?key=<key> in the URL, basic = HTTP Basic login/password, none = no authentication at all.
const AUTH_METHOD_NAMES = ["bearer", "query", "basic", "none"] as const;
type AuthMethod = (typeof AUTH_METHOD_NAMES)[number];
const requestedAuth = (process.env.AUTH_METHODS || "bearer")
  .split(/[;,\s]+/)
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
for (const method of requestedAuth) {
  if (!(AUTH_METHOD_NAMES as readonly string[]).includes(method)) throw new Error(`Unsupported AUTH_METHODS value "${method}". Use bearer, query, basic or none.`);
}
const AUTH_METHODS: ReadonlySet<AuthMethod> = new Set((requestedAuth.length ? requestedAuth : ["bearer"]) as AuthMethod[]);
const BASIC_AUTH_USER = (process.env.BASIC_AUTH_USER || "").trim();
const BASIC_AUTH_PASSWORD = process.env.BASIC_AUTH_PASSWORD || "";
// "none" exposes terminal, files and browser to anyone who can reach the server (including through a tunnel),
// so it needs an explicit acknowledgement rather than a single switch.
export const NO_AUTH_ACK = "I_UNDERSTAND_ANYONE_CAN_CONTROL_THIS_PC";

if (AUTH_METHODS.has("none") && (process.env.ALLOW_NO_AUTH || "").trim() !== NO_AUTH_ACK) {
  throw new Error(`AUTH_METHODS includes "none": anyone who reaches this server can run commands and read files. To allow it, also set ALLOW_NO_AUTH=${NO_AUTH_ACK}`);
}
if ((AUTH_METHODS.has("bearer") || AUTH_METHODS.has("query")) && API_KEY.length < 32) {
  throw new Error("MCP_API_KEY must contain at least 32 characters. Generate one with: npm run token");
}
if (AUTH_METHODS.has("basic")) {
  if (!BASIC_AUTH_USER || BASIC_AUTH_USER.includes(":")) throw new Error("Basic authentication needs BASIC_AUTH_USER (without ':').");
  if (BASIC_AUTH_PASSWORD.length < 12) throw new Error("Basic authentication needs a BASIC_AUTH_PASSWORD of at least 12 characters.");
}
if (AUTH_METHODS.has("none")) {
  console.warn("[SECURITY] AUTH_METHODS=none: authentication is OFF. Anyone who can reach this server (or its tunnel URL) controls this PC.");
} else if (AUTH_METHODS.has("query")) {
  console.warn("[SECURITY] AUTH_METHODS includes query: the key travels in the URL and may appear in tunnel or proxy logs. Prefer bearer when the client supports headers.");
}

// Ensure sandbox directory exists
await fs.mkdir(FILES_ROOT, { recursive: true });

export const config = {
  port: PORT,
  host: HOST,
  apiKey: API_KEY,
  auth: { methods: AUTH_METHODS, basicUser: BASIC_AUTH_USER, basicPassword: BASIC_AUTH_PASSWORD },
  fullAccess: FULL_ACCESS,
  serverPaths: {
    serverDir: process.cwd(), envFile: process.env.DOTENV_PATH?.trim() || "", auditFile: process.env.AUDIT_LOG_FILE?.trim() || "",
    extra: (process.env.PROTECTED_PATHS ?? "").split(";").map(p => p.trim()).filter(Boolean),
  },
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
