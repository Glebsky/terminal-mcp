/**
 * Helpers for keeping server credentials away from child processes and logs.
 */

// Server-side credentials that must never reach commands run by MCP clients.
const SENSITIVE_ENV_NAME =
  /^(MCP_API_KEY|BASIC_AUTH_PASSWORD|NGROK_AUTHTOKEN|NGROK_TOKEN|NGROK_API_KEY|TUNA_API_KEY|CLOUDFLARE_TUNNEL_TOKEN|TUNNEL_TOKEN|DOTENV_PATH)$/i;

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

/** Effective credential values: bearer/basic keep significant whitespace; provider tokens are trimmed in config.ts. */
export function sensitiveValues(): string[] {
  const values = new Set<string>();
  for (const [name, raw] of Object.entries(process.env)) {
    const key = name.toUpperCase();
    if (!raw || key === "DOTENV_PATH" || !isSensitiveEnvName(key)) continue;
    const value = key === "MCP_API_KEY" || key === "BASIC_AUTH_PASSWORD" ? raw : raw.trim();
    if (value.length >= 8) values.add(value);
  }
  return [...values].sort((a,b) => b.length-a.length);
}
