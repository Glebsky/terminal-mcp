// Black-box harness for SPEC-009: starts dist/index.js (or uses MCP_URL/MCP_KEY) without importing src/.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SERVER_ENTRY = path.join(ROOT, "dist", "index.js");

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function tempDir(prefix = "mcp-conf-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lines of a stream, with a waiter for a matching line. */
function lineCollector(stream) {
  const lines = [];
  const waiters = [];
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      lines.push(line);
      for (const w of [...waiters]) if (w.test(line)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(line); }
    }
  });
  return {
    lines,
    waitFor(test, timeoutMs = 8000) {
      const found = lines.find(test);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = { test, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) { waiters.splice(i, 1); reject(new Error(`Timed out waiting for line. Last lines:\n${lines.slice(-15).join("\n")}`)); }
        }, timeoutMs);
      });
    },
  };
}

/** [CTL] events printed on stdout (SPEC-009 FR-4). */
export function ctlEvents(lines) {
  return lines.filter((l) => l.startsWith("[CTL] ")).map((l) => JSON.parse(l.slice(6)));
}

async function waitHealthy(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(new URL("/health", url));
      if (res.ok) return;
    } catch (error) { lastError = error; }
    await sleep(100);
  }
  throw new Error(`Server did not become healthy: ${lastError?.message ?? "timeout"}`);
}

/**
 * Start an isolated server. Options: env (extra env), port, waitReady (default true).
 * Returns { url, mcpUrl, key, root, port, proc, stdout, stderr, stop() }.
 */
export async function startServer(options = {}) {
  if (!fs.existsSync(SERVER_ENTRY)) throw new Error(`${SERVER_ENTRY} not found: run "npm run build:server" first`);
  const port = options.port ?? (await freePort());
  const root = options.root ?? tempDir();
  const key = options.key ?? "conf_" + randomBytes(24).toString("hex");
  const env = {
    ...process.env,
    DOTENV_PATH: path.join(root, ".no-such-env"),
    PORT: String(port),
    HOST: "127.0.0.1",
    MCP_API_KEY: key,
    AUTH_METHODS: "bearer",
    NGROK_ENABLED: "false",
    NGROK_DOMAIN: "",
    TUNNEL_PROVIDER: "none",
    ALLOWED_HOSTS: `127.0.0.1:${port};localhost:${port}`,
    FULL_ACCESS: "false",
    FILES_ROOT: root,
    DISABLED_TOOLS: "",
    ...options.env,
  };
  const proc = spawn(process.execPath, [SERVER_ENTRY], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const stdout = lineCollector(proc.stdout);
  const stderr = lineCollector(proc.stderr);
  const exited = new Promise((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));
  const url = `http://127.0.0.1:${port}`;
  const handle = {
    url, mcpUrl: `${url}/mcp`, key, root, port, proc, stdout, stderr, exited,
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill();
        await Promise.race([exited, sleep(3000)]);
      }
      if (!options.keepRoot) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
  if (options.waitReady !== false) {
    try { await waitHealthy(url); } catch (error) {
      await handle.stop();
      throw new Error(`${error.message}\nstdout:\n${stdout.lines.join("\n")}\nstderr:\n${stderr.lines.join("\n")}`);
    }
  }
  return handle;
}
