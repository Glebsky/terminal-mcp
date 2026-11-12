/**
 * Helpers for keeping server credentials away from child processes and logs.
 */

// Server-side credentials that must never reach commands run by MCP clients.
const SENSITIVE_ENV_NAME =
  /^(MCP_API_KEY|NGROK_AUTHTOKEN|NGROK_TOKEN|NGROK_API_KEY|TUNA_API_KEY|CLOUDFLARE_TUNNEL_TOKEN|TUNNEL_TOKEN|DOTENV_PATH)$/i;

export function isSensitiveEnvName(name: string): boolean {
  return SENSITIVE_ENV_NAME.test(name);
}

/** Copy of process.env without server credentials, merged with `extra`. */
export function scrubbedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!isSensitiveEnvName(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

/** Current values of sensitive variables (used for log redaction). */
export function sensitiveValues(): string[] {
  return Object.entries(process.env)
    .filter(([key, value]) => key !== "DOTENV_PATH" && isSensitiveEnvName(key) && typeof value === "string" && value.trim().length >= 8)
    .map(([, value]) => (value as string).trim());
}
