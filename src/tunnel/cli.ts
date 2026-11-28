import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { config } from "../config.js";
import { tunnelStatus, redactTunnelError } from "./status.js";
import { resolveTunnelCommand, terminateTunnelProcess } from "./process.js";

const QUICK_NOTICE = "Quick Tunnel is for testing only: its address changes on restart. Use /mcp for non-streaming requests; /sse and SSE streaming are not supported. Use a named tunnel for a stable address.";

type Provider = "tuna" | "cloudflare" | "localtunnel";
let child: ChildProcess | null = null;
let generation = 0;
let timeout: NodeJS.Timeout | undefined;

export function extractPublicTunnelUrl(provider: Provider, line: string): string | null {
  const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  if (provider === "tuna" && !/forwarding|public url|tunnel url|https endpoint/i.test(clean)) return null;
  if (provider === "localtunnel" && !/your url is:/i.test(clean)) return null;
  const urls = clean.match(/https:\/\/[a-z0-9.-]+(?::\d+)?/gi) || [];
  for (const value of urls) {
    try {
      const parsed = new URL(value);
      const suffixes = provider === "tuna" ? [".tuna.am"] : provider === "cloudflare" ? [".trycloudflare.com"] : [".loca.lt", ".localtunnel.me"];
      if (!parsed.port && suffixes.some(suffix => parsed.hostname.toLowerCase().endsWith(suffix))) return parsed.origin;
    } catch { /* Ignore unrelated CLI output. */ }
  }
  return null;
}

function namedCloudflareUrl(): string {
  const url = new URL(config.cloudflare.publicUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname) || /^\d+(?:\.\d+){3}$/.test(url.hostname)) {
    throw new Error("Set the HTTPS origin routed to this server in the Cloudflare dashboard (no path, credentials or port).");
  }
  return url.origin;
}

export async function startCliTunnel(provider: Provider): Promise<void> {
  if (child) throw new Error("Stop the active tunnel before starting another provider.");
  const session = ++generation;
  tunnelStatus(provider, "starting");
  let failed = false;
  const current = () => session === generation;
  try {
    const named = provider === "cloudflare" && config.cloudflare.mode === "named";
    if (provider === "cloudflare" && !named) console.warn("[Tunnel] " + QUICK_NOTICE);
    if (named && !config.cloudflare.token) throw new Error("Cloudflare named tunnel requires a connector token from the Cloudflare dashboard.");
    const namedUrl = named ? namedCloudflareUrl() : "";
    const targetHost = ["0.0.0.0", "::", "[::]"].includes(config.host) ? "127.0.0.1" : config.host;
    const target = (targetHost.includes(":") && !targetHost.startsWith("[") ? "[" + targetHost + "]" : targetHost) + ":" + config.port;
    const executable = provider === "tuna" ? config.tuna.executable : provider === "cloudflare" ? config.cloudflare.executable : config.localtunnel.executable;
    const command = await resolveTunnelCommand(provider, executable);
    if (!current()) return;
    const args = provider === "tuna" ? ["http", "http://" + target]
      : provider === "cloudflare" ? (named ? ["tunnel", "--no-autoupdate", "run"] : ["tunnel", "--no-autoupdate", "--url", "http://" + target])
      : ["--port", String(config.port), "--local-host", targetHost];
    if (provider === "localtunnel" && config.localtunnel.subdomain) {
      if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.localtunnel.subdomain)) throw new Error("LocalTunnel subdomain must contain 3–63 lowercase letters, numbers or hyphens.");
      args.push("--subdomain", config.localtunnel.subdomain);
    }
    const env = { ...process.env };
    // Do not give tunnel CLIs the MCP Bearer token or other providers' credentials.
    for (const key of Object.keys(env)) if (/^(MCP_API_KEY|NGROK_.*|TUNA_.*|CLOUDFLARE_.*|CLOUDFLARED_.*|TUNNEL_TOKEN|DOTENV_PATH)$/.test(key)) delete env[key];
    if (provider === "tuna") {
      Object.assign(env, { TUNA_TUI: "0", TUNA_INSPECT: "false", NONINTERACTIVE: "1" });
      if (config.tuna.apiKey) env.TUNA_API_KEY = config.tuna.apiKey;
      if (config.tuna.subdomain) env.TUNA_SUBDOMAIN = config.tuna.subdomain;
    }
    if (named) env.TUNNEL_TOKEN = config.cloudflare.token;
    console.log("[Tunnel] Starting " + provider + "...");
    const proc = spawn(command.command, [...command.prefix, ...args], { env, windowsHide: true, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    child = proc;
    let connected = false;
    const fail = (message: string) => {
      if (!current() || failed) return;
      failed = true;
      if (timeout) clearTimeout(timeout);
      tunnelStatus(provider, "error", undefined, message);
      console.error("[Tunnel] " + message);
      void terminateTunnelProcess(proc);
    };
    const armTimeout = () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => fail("No public tunnel after 40 seconds. Check CLI installation, provider login, quota and network; then restart the server."), 40000);
    };
    armTimeout();
    const onLine = (line: string) => {
      if (!current() || failed) return;
      const url = named && /\bRegistered tunnel connection\b/i.test(line) ? namedUrl : !named ? extractPublicTunnelUrl(provider, line) : null;
      if (url) {
        connected = true;
        if (timeout) clearTimeout(timeout);
        const limited = provider === "localtunnel" || (provider === "cloudflare" && !named);
        const warning = provider === "localtunnel" ? "Unverified endpoint: LocalTunnel may require a password/interstitial page that blocks MCP clients. Not recommended for permanent MCP use."
          : provider === "cloudflare" && !named ? QUICK_NOTICE
          : undefined;
        tunnelStatus(provider, limited ? "unverified" : "connected", url, warning);
        console.log("[Tunnel] " + provider + " public address assigned: " + url + "/mcp" + (limited ? " (unverified)" : ""));
      } else if (/invalid (?:api.?key|token)|authentication failed|unauthorized|ERR_TUNNEL|failed to authenticate/i.test(line)) {
        fail("Provider authentication failed. Check the provider credentials in Settings (MCP Bearer authentication is separate).");
      } else if (connected && /disconnect(?:ed)?|reconnecting|connection lost|unregistered tunnel connection/i.test(line)) {
        connected = false; tunnelStatus(provider, "starting"); armTimeout();
      }
    };
    const consume = (stream: Readable | null) => {
      let buffer = "";
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n|\r/);
        buffer = (lines.pop() || "").slice(-8192);
        for (const line of lines) onLine(line.slice(0, 8192));
      });
      stream?.on("end", () => { if (buffer) onLine(buffer); });
    };
    consume(proc.stdout); consume(proc.stderr);
    proc.once("error", () => fail("Unable to launch " + provider + ". Check the CLI executable path and installation instructions in Settings."));
    proc.once("close", (code) => {
      if (child === proc) child = null;
      if (!current()) return;
      if (timeout) clearTimeout(timeout);
      if (!failed) fail(provider + " exited (code " + code + "). Check login, quota and network, then restart the server.");
    });
  } catch (error) {
    if (!current()) return;
    const message = redactTunnelError(error);
    tunnelStatus(provider, "error", undefined, message);
    console.error("[Tunnel] " + message);
  }
}
export async function stopCliTunnel(): Promise<void> {
  ++generation;
  if (timeout) clearTimeout(timeout);
  const proc = child; child = null;
  if (proc) await terminateTunnelProcess(proc);
  tunnelStatus(config.tunnelProvider, "disabled");
}
