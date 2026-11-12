export type TunnelProvider = "none" | "ngrok" | "tuna" | "cloudflare" | "localtunnel";
export type TunnelState = "disabled" | "starting" | "connected" | "unverified" | "error";
export const tunnelProviderLabels: Record<TunnelProvider, string> = { none: "Local only", ngrok: "ngrok", tuna: "Tuna", cloudflare: "Cloudflare", localtunnel: "LocalTunnel" };
export interface ServerStatus {
  state: "offline" | "starting" | "running" | "error";
  port: number;
  host: string;
  tunnelProvider: TunnelProvider;
  tunnelState: TunnelState;
  tunnelUrl?: string;
  tunnelError?: string;
  ngrokEnabled: boolean;
  ngrokDomain?: string;
  ngrokUrl?: string;
  apiKey: string;
  fullAccess: boolean;
  filesRoot: string;
  error?: string;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  type: "info" | "audit" | "error" | "warn" | "mcp";
  category?: "command" | "file" | "auth" | "general";
  message: string;
  raw?: string;
}

export interface MonitorSnapshot {
  received: number; sent: number; totalReceived: number; totalSent: number;
  totalRequests: number; activeRequests: number; activeSse: number; activeHttp: number; sampledAt: number;
  recentClients: { client: string; operation: string; lastSeen: string; requests: number }[];
  operations: { operation: string; received: number; sent: number }[];
}

export interface EnvConfig {
  PORT: string;
  HOST: string;
  MCP_API_KEY: string;
  FULL_ACCESS: string;
  FILES_ROOT: string;
  TUNNEL_PROVIDER: TunnelProvider;
  TUNA_EXECUTABLE: string;
  TUNA_API_KEY: string;
  TUNA_SUBDOMAIN: string;
  CLOUDFLARED_EXECUTABLE: string;
  CLOUDFLARE_MODE: "quick" | "named";
  CLOUDFLARE_TUNNEL_TOKEN: string;
  CLOUDFLARE_PUBLIC_URL: string;
  LOCALTUNNEL_EXECUTABLE: string;
  LOCALTUNNEL_SUBDOMAIN: string;
  NGROK_ENABLED: string;
  NGROK_AUTHTOKEN: string;
  NGROK_DOMAIN: string;
  ALLOWED_HOSTS: string;
  COMMAND_TIMEOUT_MS: string;
  MAX_OUTPUT_BYTES: string;
  MAX_FILE_BYTES: string;
  /** Semicolon-separated MCP tool names hidden from agents. */
  DISABLED_TOOLS: string;
}

export interface ElectronAPI {
  // Server Management
  startServer: () => Promise<{ success: boolean; error?: string }>;
  stopServer: () => Promise<{ success: boolean }>;
  restartServer: () => Promise<{ success: boolean; error?: string }>;
  getServerStatus: () => Promise<ServerStatus>;

  // Configuration
  getConfig: () => Promise<EnvConfig>;
  saveConfig: (config: Partial<EnvConfig>) => Promise<{ success: boolean; error?: string }>;
  selectFolder: () => Promise<string | null>;
  generateToken: () => Promise<string>;

  // Logs
  onLog: (callback: (log: LogEntry) => void) => () => void;
  onStatusChange: (callback: (status: ServerStatus) => void) => () => void;
  clearLogs: () => Promise<void>;

  setMonitoring: (enabled: boolean) => Promise<void>;
  onMonitoring: (callback: (snapshot: MonitorSnapshot) => void) => () => void;

  // Window Controls & Tray
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  closeWindow: () => void;
  hideToTray: () => void;
  exitApp: () => void;

  // External Links / System
  openExternal: (url: string) => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
