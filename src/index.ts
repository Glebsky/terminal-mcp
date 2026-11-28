import { config } from "./config.js";
import { createApp, getActiveSessions } from "./server.js";
import { setMonitoringEnabled } from "./monitor.js";
import { startTunnel, stopTunnel } from "./tunnel/index.js";
import { emit, onCommand } from "./control.js";

const app = createApp();

// Express 5 hands listen errors (EADDRINUSE, EACCES, ...) to this callback instead of throwing (SPEC-005 FR-3).
const httpServer = app.listen(config.port, config.host, async (error?: Error) => {
  if (error) {
    const code = (error as NodeJS.ErrnoException).code || "LISTEN_FAILED";
    console.error(`Cannot listen on ${config.host}:${config.port}: ${code} ${error.message}`);
    const exit = () => process.exit(1);
    emit({ type: "server:error", code, port: config.port, message: error.message }, exit);
    return;
  }
  console.log(`MCP Terminal listening on http://${config.host}:${config.port}/mcp`);
  console.log(
    `Filesystem mode: ${config.fullAccess ? "FULL HOST ACCESS (UNRESTRICTED)" : `restricted to ${config.filesRoot}`}`,
  );

  emit({ type: "server:ready" });
  await startTunnel();
});

// Set server-level keepalive timeout to match transport headers
httpServer.keepAliveTimeout = 65_000;
httpServer.headersTimeout = 70_000;

let isShuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\nReceived ${signal}, shutting down gracefully...`);

  setTimeout(() => {
    console.warn("Forced shutdown after timeout.");
    process.exit(0);
  }, 3000).unref();

  // Close the public connector first, even if session teardown stalls.
  await stopTunnel();

  // Close all active MCP sessions
  const sessions = getActiveSessions();
  if (sessions.size > 0) {
    console.log(`Closing ${sessions.size} active MCP session(s)...`);
    await Promise.allSettled([...sessions.values()].map((t) => t.close()));
    sessions.clear();
  }

  httpServer.close(() => {
    console.log("MCP HTTP server closed.");
    process.exit(0);
  });


}

process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});

onCommand((msg) => {
  if (msg.type === "monitor:set") setMonitoringEnabled(msg.enabled === true);
  if (msg.type === "shutdown") void gracefulShutdown("IPC");
});

