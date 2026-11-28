import { config } from "../config.js";
import { emit } from "../control.js";
export type TunnelState = "disabled" | "starting" | "connected" | "unverified" | "error";
export interface TunnelSnapshot { provider: string; state: TunnelState; url?: string; error?: string }
let temporaryHost: string | undefined;
let snapshot: TunnelSnapshot = { provider: config.tunnelProvider, state: "disabled" };
export function getTunnelStatus(): TunnelSnapshot { return { ...snapshot }; }
export function redactTunnelError(value: unknown): string {
  let message = value instanceof Error ? value.message : String(value);
  for (const secret of [config.apiKey, config.ngrok.authtoken, config.tuna.apiKey, config.cloudflare.token]) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  return message.replace(/(Bearer|authtoken|api[_-]?key|token)([=:\s]+)[^\s,;]+/gi, "$1$2[redacted]").slice(0, 500);
}
export function tunnelStatus(provider: string, state: TunnelState, url?: string, error?: string): void {
  if (temporaryHost) { config.allowedHosts.delete(temporaryHost); temporaryHost = undefined; }
  let origin: string | undefined;
  if ((state === "connected" || state === "unverified") && url) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) throw new Error("Tunnel must use a public HTTPS origin");
    origin = parsed.origin;
    const host = parsed.host.toLowerCase();
    if (!config.allowedHosts.has(host)) { config.allowedHosts.add(host); temporaryHost = host; }
  }
  snapshot = { provider, state, ...(origin ? { url: origin } : {}), ...(error ? { error: redactTunnelError(error) } : {}) };
  emit({ type: "tunnel:status", ...snapshot });
}
