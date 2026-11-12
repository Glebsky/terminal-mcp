import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import dotenv from "dotenv";
import type { EnvConfig, LogEntry, ServerStatus, MonitorSnapshot } from "../types.js";

export class ServerManager {
  private process: ChildProcess | null = null;
  private startTask: Promise<{ success: boolean; error?: string }> | null = null;
  private status: ServerStatus = {
    state: "offline",
    port: 3100,
    host: "127.0.0.1",
    tunnelProvider: "none",
    tunnelState: "disabled",
    ngrokEnabled: false,
    apiKey: "",
    fullAccess: false,
    filesRoot: "./workspace",
  };

  private monitoringEnabled = true;
  private monitorCallback: ((snapshot: MonitorSnapshot) => void) | null = null;
  public setMonitorCallback(callback: (snapshot: MonitorSnapshot) => void) { this.monitorCallback = callback; }
  public setMonitoring(enabled: boolean) {
    this.monitoringEnabled = enabled;
    if (this.process?.connected) this.process.send({ type: "monitor:set", enabled });
  }
  private projectRoot: string;
  private configDir: string;
  private onLogCallback: ((log: LogEntry) => void) | null = null;
  private onStatusChangeCallback: ((status: ServerStatus) => void) | null = null;

  constructor(projectRoot: string, configDir: string) {
    this.projectRoot = projectRoot;
    this.configDir = configDir;
    void this.init().catch(() => { this.updateStatus({ state: "error", error: "Unable to load local configuration. Check the .env file and folder permissions." }); });
  }

  private async init() {
    await this.ensureEnvExists();
    await this.reloadConfig();
  }

  public setCallbacks(
    onLog: (log: LogEntry) => void,
    onStatusChange: (status: ServerStatus) => void,
  ) {
    this.onLogCallback = onLog;
    this.onStatusChangeCallback = onStatusChange;
  }

  public getStatus(): ServerStatus {
    return { ...this.status };
  }

  private updateStatus(newStatus: Partial<ServerStatus>) {
    this.status = { ...this.status, ...newStatus };
    if (this.onStatusChangeCallback) {
      this.onStatusChangeCallback(this.getStatus());
    }
  }

  private emitLog(
    message: string,
    type: LogEntry["type"] = "info",
    category?: LogEntry["category"],
    raw?: string,
  ) {
    const entry: LogEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toLocaleTimeString("ru-RU", { hour12: false }),
      type,
      category,
      message,
      raw,
    };
    if (this.onLogCallback) {
      this.onLogCallback(entry);
    }
  }

  public getEnvPath(): string {
    // Allow overriding via env var — useful for pointing packaged app to project .env
    if (process.env.MCP_TERMINAL_ENV_PATH) {
      return process.env.MCP_TERMINAL_ENV_PATH;
    }
    return path.join(this.configDir, ".env");
  }

  private async ensureEnvExists(): Promise<void> {
    const envPath = this.getEnvPath();
    try {
      await fs.access(envPath);
    } catch {
      // Create default .env in config directory
      await fs.mkdir(this.configDir, { recursive: true });
      const defaultApiKey = crypto.randomBytes(32).toString("hex");
      const defaultWorkspace = path.join(this.configDir, "workspace");
      await fs.mkdir(defaultWorkspace, { recursive: true });

      const defaultContent = [
        `MCP_API_KEY=${defaultApiKey}`,
        `PORT=3100`,
        `HOST=127.0.0.1`,
        `ALLOWED_HOSTS=localhost:3100;127.0.0.1:3100`,
        `NGROK_ENABLED=false`,
        `NGROK_AUTHTOKEN=`,
        `NGROK_DOMAIN=`,
        `FULL_ACCESS=false`,
        `FILES_ROOT=${defaultWorkspace}`,
        `COMMAND_TIMEOUT_MS=120000`,
        `MAX_OUTPUT_BYTES=1048576`,
        `MAX_FILE_BYTES=10485760`,
      ].join("\n") + "\n";

      // Concurrent startup/config requests must not overwrite a newly created key.
      await fs.mkdir(path.dirname(envPath), { recursive: true });
      try {
        await fs.writeFile(envPath, defaultContent, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  }

  public async getEnvConfig(): Promise<EnvConfig> {
    await this.ensureEnvExists();
    const envPath = this.getEnvPath();
    const defaultConfig: EnvConfig = {
      PORT: "3100",
      HOST: "127.0.0.1",
      MCP_API_KEY: "",
      FULL_ACCESS: "false",
      FILES_ROOT: path.join(this.configDir, "workspace"),
      TUNNEL_PROVIDER: "none",
      TUNA_EXECUTABLE: "",
      TUNA_API_KEY: "",
      TUNA_SUBDOMAIN: "",
      CLOUDFLARED_EXECUTABLE: "",
      CLOUDFLARE_MODE: "quick",
      CLOUDFLARE_TUNNEL_TOKEN: "",
      CLOUDFLARE_PUBLIC_URL: "",
      LOCALTUNNEL_EXECUTABLE: "",
      LOCALTUNNEL_SUBDOMAIN: "",
      NGROK_ENABLED: "false",
      NGROK_AUTHTOKEN: "",
      NGROK_DOMAIN: "",
      ALLOWED_HOSTS: "localhost:3100;127.0.0.1:3100",
      COMMAND_TIMEOUT_MS: "120000",
      MAX_OUTPUT_BYTES: "1048576",
      MAX_FILE_BYTES: "10485760",
      DISABLED_TOOLS: "",
    };

    try {
      const content = await fs.readFile(envPath, "utf8");
      const parsed = dotenv.parse(content);
      const requested = (parsed.TUNNEL_PROVIDER || "").trim().toLowerCase();
      if (requested && !["none", "ngrok", "tuna", "cloudflare", "localtunnel"].includes(requested)) throw new Error("Unsupported tunnel provider in local configuration");
      const provider = (requested || (/^true$/i.test(parsed.NGROK_ENABLED || "") ? "ngrok" : "none")) as EnvConfig["TUNNEL_PROVIDER"];
      return { ...defaultConfig, ...parsed, TUNNEL_PROVIDER: provider, NGROK_ENABLED: provider === "ngrok" ? "true" : "false", NGROK_AUTHTOKEN: parsed.NGROK_AUTHTOKEN || parsed.NGROK_TOKEN || "", CLOUDFLARE_MODE: parsed.CLOUDFLARE_MODE === "named" ? "named" : "quick" };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig;
      throw new Error("Unable to read local configuration. Check the provider name and file permissions.");
    }
  }

  public async saveEnvConfig(newConfig: Partial<EnvConfig>): Promise<{ success: boolean; error?: string }> {
    try {
      await this.ensureEnvExists();
      const current = await this.getEnvConfig();
      const updated = { ...current, ...newConfig };
      if (Object.keys(current).some(key => typeof updated[key as keyof EnvConfig] !== "string")) throw new Error("Settings must contain text values only");
      if (updated.MCP_API_KEY.length < 32) throw new Error("MCP Bearer key must contain at least 32 characters");
      if (!/^\d+$/.test(updated.PORT) || Number(updated.PORT) < 1 || Number(updated.PORT) > 65535) throw new Error("Port must be between 1 and 65535");
      for (const key of ["COMMAND_TIMEOUT_MS", "MAX_OUTPUT_BYTES", "MAX_FILE_BYTES"] as const) if (!/^\d+$/.test(updated[key]) || Number(updated[key]) < 1) throw new Error("Server limits must be positive integers");
      if (!["quick", "named"].includes(updated.CLOUDFLARE_MODE)) throw new Error("Invalid Cloudflare mode");
      if (!["none", "ngrok", "tuna", "cloudflare", "localtunnel"].includes(updated.TUNNEL_PROVIDER)) throw new Error("Invalid tunnel provider");
      updated.NGROK_ENABLED = updated.TUNNEL_PROVIDER === "ngrok" ? "true" : "false";
      if (Object.values(updated).some(value => typeof value === "string" && /[\r\n]/.test(value))) throw new Error("Settings cannot contain line breaks");
      if (updated.ALLOWED_HOSTS.split(";").some(host => host.trim() === "*")) throw new Error("Use specific allowed Host names, not a global wildcard");
      if (updated.FULL_ACCESS === "") updated.FULL_ACCESS = "false";
      if (!["true", "false"].includes(updated.FULL_ACCESS)) throw new Error("Full access must be true or false");
      if (updated.FILES_ROOT.trim()) {
        const resolvedRoot = path.resolve(updated.FILES_ROOT.trim());
        if (path.parse(resolvedRoot).root === resolvedRoot) throw new Error("Files root cannot be a drive or filesystem root");
      }
      updated.DISABLED_TOOLS = updated.DISABLED_TOOLS.split(/[;,\s]+/).map(name => name.trim().toLowerCase()).filter(Boolean).join(";");
      if (updated.DISABLED_TOOLS && !/^[a-z0-9_;]+$/.test(updated.DISABLED_TOOLS)) throw new Error("Disabled tools must be tool names separated by semicolons");
      const envPath = this.getEnvPath();

      const lines = [
        `MCP_API_KEY=${updated.MCP_API_KEY}`,
        `PORT=${updated.PORT}`,
        `HOST=${updated.HOST}`,
        `ALLOWED_HOSTS=${updated.ALLOWED_HOSTS}`,
        `TUNNEL_PROVIDER=${updated.TUNNEL_PROVIDER}`,
        `TUNA_EXECUTABLE=${updated.TUNA_EXECUTABLE}`,
        `TUNA_API_KEY=${updated.TUNA_API_KEY}`,
        `TUNA_SUBDOMAIN=${updated.TUNA_SUBDOMAIN}`,
        `CLOUDFLARED_EXECUTABLE=${updated.CLOUDFLARED_EXECUTABLE}`,
        `CLOUDFLARE_MODE=${updated.CLOUDFLARE_MODE}`,
        `CLOUDFLARE_TUNNEL_TOKEN=${updated.CLOUDFLARE_TUNNEL_TOKEN}`,
        `CLOUDFLARE_PUBLIC_URL=${updated.CLOUDFLARE_PUBLIC_URL}`,
        `LOCALTUNNEL_EXECUTABLE=${updated.LOCALTUNNEL_EXECUTABLE}`,
        `LOCALTUNNEL_SUBDOMAIN=${updated.LOCALTUNNEL_SUBDOMAIN}`,
        `NGROK_ENABLED=${updated.NGROK_ENABLED}`,
        `NGROK_AUTHTOKEN=${updated.NGROK_AUTHTOKEN}`,
        `NGROK_DOMAIN=${updated.NGROK_DOMAIN}`,
        `FULL_ACCESS=${updated.FULL_ACCESS}`,
        `FILES_ROOT=${updated.FILES_ROOT}`,
        `COMMAND_TIMEOUT_MS=${updated.COMMAND_TIMEOUT_MS}`,
        `MAX_OUTPUT_BYTES=${updated.MAX_OUTPUT_BYTES}`,
        `MAX_FILE_BYTES=${updated.MAX_FILE_BYTES}`,
        `DISABLED_TOOLS=${updated.DISABLED_TOOLS}`,
      ];

      // Quote literal values so #, spaces and Windows paths survive dotenv parsing.
      const serialized = lines.map(line => {
        const separator = line.indexOf("="); const value = line.slice(separator + 1);
        const quote = ["'", "`", '"'].find(character => !value.includes(character));
        if (!quote) throw new Error("A setting contains an unsupported combination of quotes");
        return line.slice(0, separator + 1) + quote + value + quote;
      });
      // Preserve unrelated settings and comments rather than discarding them on save.
      const existing = await fs.readFile(envPath, "utf8");
      const keys = new Set(lines.map(line => line.slice(0, line.indexOf("="))));
      const untouched = existing.split(/\r?\n/).filter(line => {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        return !match || !keys.has(match[1]);
      });
      await fs.writeFile(envPath, [...untouched, ...serialized].join("\n").replace(/^\n+/, "") + "\n", "utf8");
      await this.reloadConfig();
      this.emitLog(`Configuration updated and saved to ${envPath}`, "info");
      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.emitLog(`Failed to save .env: ${error}`, "error");
      return { success: false, error };
    }
  }

  public async reloadConfig() {
    const config = await this.getEnvConfig();
    if (this.process && !this.process.killed) return; // running values apply until restart
    this.updateStatus({
      tunnelProvider: config.TUNNEL_PROVIDER,
      tunnelState: "disabled",
      tunnelUrl: undefined,
      tunnelError: undefined,
      port: Number.parseInt(config.PORT, 10) || 3100,
      host: config.HOST || "127.0.0.1",
      apiKey: config.MCP_API_KEY || "",
      fullAccess: config.FULL_ACCESS === "true",
      filesRoot: config.FILES_ROOT || path.join(this.configDir, "workspace"),
      ngrokEnabled: config.TUNNEL_PROVIDER === "ngrok",
      ngrokDomain: config.NGROK_DOMAIN || undefined,
    });
  }

  public start(): Promise<{ success: boolean; error?: string }> {
    if (this.startTask) return this.startTask;
    this.startTask = this.startProcess().finally(() => { this.startTask = null; });
    return this.startTask;
  }

  private async startProcess(): Promise<{ success: boolean; error?: string }> {
    if (this.process && !this.process.killed) {
      return { success: true };
    }

    try { await this.reloadConfig(); } catch {
      const error = "Unable to load server configuration. Check the local .env file and provider name.";
      this.updateStatus({ state: "error", error }); return { success: false, error };
    }
    this.updateStatus({ state: "starting", error: undefined, ngrokUrl: undefined, tunnelUrl: undefined, tunnelError: undefined, tunnelState: this.status.tunnelProvider === "none" ? "disabled" : "starting" });
    this.emitLog("Starting MCP Terminal Server...", "info");

    const serverScript = path.join(this.projectRoot, "dist", "index.js");

    try {
      await fs.access(serverScript);
    } catch {
      const error = `Server entrypoint not found at ${serverScript}. Run 'npm run build' first.`;
      this.updateStatus({ state: "error", error });
      this.emitLog(error, "error");
      return { success: false, error };
    }

    try {
      const envPath = this.getEnvPath();
      const config = await this.getEnvConfig();

      this.process = spawn(process.execPath, [serverScript], {
        cwd: this.configDir,
        env: {
          ...process.env,
          // Desktop settings must win over inherited environment from another MCP server.
          ...config,
          NGROK_TOKEN: "",
          DOTENV_PATH: envPath,
          ELECTRON_RUN_AS_NODE: "1",
          FORCE_COLOR: "1",
        },
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        windowsHide: true,
      });

      this.process.on("message", (message: unknown) => {
        if (message && typeof message === "object" && (message as {type?: string}).type === "server:ready") this.updateStatus({ state: "running" });
        if (message && typeof message === "object" && (message as {type?: string}).type === "tunnel:status") {
          const m = message as {provider: ServerStatus["tunnelProvider"]; state: ServerStatus["tunnelState"]; url?: string; error?: string};
          this.updateStatus({ tunnelProvider: m.provider, tunnelState: m.state, tunnelUrl: m.url, tunnelError: m.error, ngrokUrl: m.provider === "ngrok" ? m.url : undefined });
        }
        if (this.monitoringEnabled && message && typeof message === "object" && (message as {type?: string}).type === "monitor:snapshot") {
          this.monitorCallback?.((message as {snapshot: MonitorSnapshot}).snapshot);
        }
      });
      if (this.process.connected) this.process.send({ type: "monitor:set", enabled: this.monitoringEnabled });

      this.process.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        this.parseOutput(text);
      });

      this.process.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        this.emitLog(text.trim(), "error", undefined, text);
      });

      this.process.on("close", (code) => {
        const wasRunning = this.status.state === "running" || this.status.state === "starting";
        this.process = null;
        this.updateStatus({
          state: code === 0 || !wasRunning ? "offline" : "error",
          ngrokUrl: undefined, tunnelUrl: undefined, tunnelState: "disabled", tunnelError: undefined,
        });
        this.emitLog(`MCP Server stopped (exit code: ${code})`, code === 0 ? "info" : "warn");
      });

      this.process.on("error", (err) => {
        this.process = null;
        this.updateStatus({ state: "error", error: err.message, ngrokUrl: undefined, tunnelUrl: undefined, tunnelState: "disabled", tunnelError: undefined });
        this.emitLog(`Process error: ${err.message}`, "error");
      });

      return { success: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.updateStatus({ state: "error", error, ngrokUrl: undefined, tunnelUrl: undefined, tunnelState: "disabled", tunnelError: undefined });
      this.emitLog(`Failed to spawn server process: ${error}`, "error");
      return { success: false, error };
    }
  }

  public async stop(): Promise<{ success: boolean }> {
    if (this.startTask) await this.startTask;
    if (!this.process || this.process.killed) {
      this.updateStatus({ state: "offline", ngrokUrl: undefined, tunnelUrl: undefined, tunnelState: "disabled", tunnelError: undefined });
      return { success: true };
    }

    this.emitLog("Stopping MCP server process gracefully...", "info");

    return new Promise((resolve) => {
      const proc = this.process;
      if (!proc) {
        resolve({ success: true });
        return;
      }

      let resolved = false;
      const onDone = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(forceKillTimer);
        this.process = null;
        this.updateStatus({ state: "offline", ngrokUrl: undefined, tunnelUrl: undefined, tunnelState: "disabled", tunnelError: undefined });
        resolve({ success: true });
      };

      // Fallback: force kill after 3 seconds if graceful shutdown does not finish
      const forceKillTimer = setTimeout(() => {
        if (!resolved && proc.pid) {
          this.emitLog("Graceful stop timed out, forcing termination...", "warn");
          if (process.platform === "win32") {
            const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
              windowsHide: true,
            });
            killer.once("close", onDone);
          } else {
            proc.kill("SIGKILL");
            onDone();
          }
        }
      }, 3000);

      proc.once("close", onDone);

      // Try sending IPC shutdown message first
      try {
        if (proc.connected) {
          proc.send({ type: "shutdown" });
        } else {
          proc.kill("SIGINT");
        }
      } catch {
        proc.kill("SIGTERM");
      }
    });
  }

  public async restart(): Promise<{ success: boolean; error?: string }> {
    await this.stop();
    // Allow OS socket and ngrok cloud release
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return await this.start();
  }

  private parseOutput(text: string) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

    for (const line of lines) {
      if (line.startsWith("[AUDIT]")) {
        const match = line.match(/\[AUDIT\]\s*([^|]+)\|\s*([^|]+)\|\s*(.*)/);
        if (match) {
          const action = match[2].trim();
          const details = match[3].trim();
          const category: LogEntry["category"] = action.startsWith("file")
            ? "file"
            : action.startsWith("terminal")
              ? "command"
              : "general";

          this.emitLog(`[AUDIT] ${action.toUpperCase()}: ${details}`, "audit", category, line);
          continue;
        }
      }

      if (line.includes("MCP Terminal listening on")) {
        this.updateStatus({ state: "running" });
        this.emitLog(line, "mcp");
        continue;
      }

      // MCP session management logs — informational only
      if (line.startsWith("[MCP]")) {
        this.emitLog(line, "info", "general", line);
        continue;
      }

      // Ngrok reconnect watchdog messages
      if (line.startsWith("[Ngrok]")) {
        const isNgrokError = line.includes("failed") || line.includes("error");
        this.emitLog(line, isNgrokError ? "warn" : "info", "general", line);
        continue;
      }

      const isError = line.toLowerCase().includes("error") || line.toLowerCase().includes("failed");
      this.emitLog(line, isError ? "error" : "info", undefined, line);
    }
  }
}
