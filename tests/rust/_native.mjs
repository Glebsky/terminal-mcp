// Own the child, its temp directory and loopback port. Never use MCP_URL, the live app or a .env file.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const exe = 'mcp-terminal-server' + (process.platform === 'win32' ? '.exe' : '');
const binary = process.env.RUST_MCP_BIN || path.join(repo, 'target', 'debug', exe);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function within(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
export async function reserve(port = 0) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}
export function release(server) {
  return new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
}
async function freePort() {
  const reservation = await reserve();
  const port = reservation.address().port;
  await release(reservation);
  return port;
}
export async function start(t, options = {}) {
  assert.ok(path.isAbsolute(binary), 'RUST_MCP_BIN must be an absolute path');
  await fs.access(binary);
  const port = options.port ?? await freePort();
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-conf-'));
  let root = scratch;
  if (options.aliasRoot) {
    const real = path.join(scratch,'physical');
    root = path.join(scratch,'visible-root');
    try {
      await fs.mkdir(real);
      await fs.symlink(real,root,process.platform === 'win32' ? 'junction' : 'dir');
    } catch (e) { await fs.rm(scratch,{recursive:true,force:true,maxRetries:3}); throw e; }
  }
  const key = randomBytes(32).toString('hex');
  const osEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    /^(systemroot|windir|temp|tmp|locale|lang)$/i.test(k)));
  const env = {
    ...osEnv, HOST: '127.0.0.1', PORT: String(port), FILES_ROOT: options.dotRoot ? root + path.sep + '.' + path.sep : root,
    MCP_CONTROL: 'stdio', MCP_API_KEY: key, AUTH_METHODS: 'bearer',
    FULL_ACCESS: 'false', TUNNEL_PROVIDER: 'none', ...options.env,
  };
  const child = spawn(binary, [], { cwd: root, env, stdio: ['pipe','pipe','pipe'], windowsHide: true });
  child.stdin.on('error', () => {});
  let stdout = '', stderr = '', ended = false;
  child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  const exit = new Promise((resolve, reject) => {
    child.once('error', error => { ended = true; reject(error); });
    child.once('close', code => { ended = true; resolve(code); });
  });
  exit.catch(() => {}); // Observed in wait/teardown; avoid unhandled rejection during startup.
  const events = () => stdout.split('\n').slice(0, -1).filter(l => l.startsWith('[CTL] ')).map(l => JSON.parse(l.slice(6)));
  async function wait(type) {
    const until = Date.now() + 7000;
    while (Date.now() < until) {
      if (events().some(e => e.type === type)) return;
      if (ended) throw new Error(`Native child exited (${await exit}) before ${type}`);
      await delay(15);
    }
    throw new Error(`Missing native control frame: ${type}`);
  }
  t.after(async () => {
    try {
      if (!ended) {
        child.stdin.end();
        try { await within(exit, 4000, 'EOF cleanup timeout'); }
        catch { child.kill(); await within(exit, 4500, 'Native fixture did not exit'); }
      }
      assert.ok(!stdout.includes(key) && !stderr.includes(key), 'A fixture credential appeared in child output');
    } finally { await fs.rm(scratch, { recursive: true, force: true, maxRetries: 3 }); }
  });
  if (options.ready !== false) await wait('server:ready');
  return { port, root, key, child, exit, events, wait, mcpUrl: `http://127.0.0.1:${port}/mcp` };
}
export async function request(s, route, { body, headers = {}, auth = true } = {}) {
  const bytes = body === undefined ? undefined : JSON.stringify(body);
  const response = new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: s.port, path: route, agent: false,
      method: bytes === undefined ? 'GET' : 'POST',
      headers: { Accept: 'application/json, text/event-stream',
        ...(bytes === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(auth ? { Authorization: 'Bearer ' + s.key } : {}), ...headers },
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', x => { data += x; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.setTimeout(6000, () => req.destroy(new Error('Fixture request timeout')));
    req.end(bytes);
  });
  return within(response, 8000, 'Fixture response timeout');
}
