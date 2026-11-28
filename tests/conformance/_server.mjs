// Child-process fixture for SPEC-009. The product is exercised through its public address and pipes.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_ENTRY = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function deadline(promise, ms, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
}
export function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer(); socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => { const { port } = socket.address(); socket.close(() => resolve(port)); });
  });
}
export function tempDir(prefix = 'mcp-conf-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function lineCollector(stream) {
  const lines = [], waiters = new Set(); let buffer = '';
  stream.setEncoding('utf8');
  const record = line => { lines.push(line); for (const w of waiters) if (w.test(line)) { waiters.delete(w); w.resolve(line); } };
  stream.on('data', chunk => {
    buffer += chunk; const batch = buffer.split('\n'); buffer = batch.pop();
    for (const l of batch) record(l.replace(/\r$/, ''));
  });
  stream.on('end', () => { if (buffer) record(buffer); for (const w of waiters) w.reject(new Error('Server closed its output before the expected event')); waiters.clear(); });
  return { lines, async waitFor(test, timeoutMs = 8000) {
    const known = lines.find(test); if (known !== undefined) return known;
    if (stream.readableEnded) throw new Error('Server output has already closed');
    let waiter;
    try { return await deadline(new Promise((resolve, reject) => { waiter = { test, resolve, reject }; waiters.add(waiter); }), timeoutMs, 'Timed out waiting for the expected server event'); }
    finally { waiters.delete(waiter); }
  } };
}
export function ctlEvents(lines) { return lines.filter(l => l.startsWith('[CTL] ')).map(l => JSON.parse(l.slice(6))); }

// Whitelist OS settings only. Never inherit real API keys, providers, audit files or cwd settings.
function systemEnv() {
  const keep = /^(path|pathext|systemroot|windir|comspec|temp|tmp|tmpdir|home|userprofile|appdata|localappdata|programfiles(?:\(x86\))?|programw6432|os|processor_architecture|lang|lc_all)$/i;
  return Object.fromEntries(Object.entries(process.env).filter(([k, v]) => keep.test(k) && v !== undefined));
}
export async function startServer(options = {}) {
  if (!fs.existsSync(SERVER_ENTRY)) throw new Error('Build the isolated server first: npm run build:server');
  const port = options.port ?? await freePort();
  const root = options.root ?? tempDir(), key = options.key ?? `conf_${randomBytes(24).toString('hex')}`;
  const env = { ...systemEnv(), ...options.env, DOTENV_PATH: path.join(root, '.no-such-env'),
    PORT: String(port), HOST: '127.0.0.1', MCP_API_KEY: key, MCP_CONTROL: 'stdio', AUTH_METHODS: options.env?.AUTH_METHODS ?? 'bearer',
    NGROK_ENABLED: 'false', TUNNEL_PROVIDER: 'none', ALLOWED_HOSTS: `127.0.0.1:${port};localhost:${port}`,
    FULL_ACCESS: 'false', FILES_ROOT: root, DISABLED_TOOLS: '' };
  const proc = spawn(process.execPath, [SERVER_ENTRY], { cwd: root, env, stdio: ['pipe','pipe','pipe'], windowsHide: true });
  proc.stdin.on('error', () => {}); // The child may close stdin before the fixture finishes cleanup.
  const stdout = lineCollector(proc.stdout), stderr = lineCollector(proc.stderr);
  // 'close' is after both output streams drain; 'exit' can miss the last server:error frame.
  const exited = new Promise(resolve => { proc.once('error', error => resolve({ code: null, error })); proc.once('close',(code,signal)=>resolve({code,signal})); });
  const url = `http://127.0.0.1:${port}`;
  let stopped = false;
  async function stop() {
    if (stopped) return;
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.stdin.end();
      try { await deadline(exited, 4500, 'Shutdown timeout'); }
      catch { proc.kill(); await deadline(exited, 6500, 'Test child did not exit'); }
    } else await exited;
    if (!options.root && !options.keepRoot) fs.rmSync(root, { recursive: true, force: true, maxRetries: 4 });
    stopped = true;
  }
  if (options.waitReady !== false) {
    try {
      // Wait for *this child* to acquire the port before making the first HTTP request.
      await stdout.waitFor(l => l.startsWith('[CTL] ') && ctlEvents([l])[0]?.type === 'server:ready', 30000);
      const response = await fetch(`${url}/health`, { redirect:'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok || (await response.json()).status !== 'ok') throw new Error('Unhealthy test server');
    } catch (e) { await stop(); throw e; }
  }
  return { url, mcpUrl: `${url}/mcp`, key, root, port, proc, stdout, stderr, exited, stop };
}
