// Stability / idempotency / race bench for MCP Terminal (diagnostic, not a pass/fail test).
// Starts isolated server instances on random localhost ports with a temp sandbox and no real tunnel.
//   npm run build:server
//   node docs/audit/race-audit.cjs . A,B,C,D,G,I,S,X,K,F,L,E
// A busy port, B parallel file_replace, C shared cwd (stateless /mcp), I FILES_ROOT fallback,
// G UTF-8 chunk split, D timeout vs background child, S per-session cwd over SSE,
// X disconnect cancels terminal_execute, K cmd encoding/quoting/byte cap, F file_search coverage,
// L file_list paging, E Cloudflare quick tunnel flap (~50 s).
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const crypto = require('crypto');

const REPO = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const SERVER = path.join(REPO, 'dist', 'index.js');
const only = (process.argv[3] || 'A,B,C,D,G,I,S,X,K,F,L,E').split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-audit-'));
const servers = [];
const results = {};

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function startServer(name, port, extraEnv = {}) {
  const dir = path.join(base, name);
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const key = crypto.randomBytes(32).toString('hex');
  const env = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', MCP_API_KEY: key, AUTH_METHODS: 'bearer',
    FILES_ROOT: ws, FULL_ACCESS: 'false', TUNNEL_PROVIDER: 'none', NGROK_ENABLED: 'false',
    ALLOWED_HOSTS: `localhost:${port};127.0.0.1:${port}`, DOTENV_PATH: path.join(dir, 'absent.env'), DISABLED_TOOLS: '',
    ...extraEnv,
  };
  for (const k of ['ELECTRON_RUN_AS_NODE', 'AUDIT_LOG_FILE', 'BROWSER_CDP_URL', 'NGROK_AUTHTOKEN', 'NGROK_TOKEN', 'MCP_TERMINAL_ENV_PATH']) {
    if (!(k in extraEnv)) delete env[k];
  }
  const proc = spawn(process.execPath, [SERVER], { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  const srv = { name, proc, key, port, dir, ws, out: [], msgs: [], t0: Date.now() };
  proc.stdout.on('data', (d) => srv.out.push(d.toString()));
  proc.stderr.on('data', (d) => srv.out.push(d.toString()));
  proc.on('message', (m) => srv.msgs.push({ at: Date.now() - srv.t0, ...m }));
  servers.push(srv);
  return srv;
}

async function waitReady(srv, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (srv.msgs.some((m) => m.type === 'server:ready')) return true;
    await sleep(50);
  }
  return false;
}

let rpc = 0;
async function call(srv, name, args) {
  const res = await fetch(`http://127.0.0.1:${srv.port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${srv.key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { return { http: res.status, raw: text.slice(0, 300) }; }
  const content = json.result && json.result.content && json.result.content[0] && json.result.content[0].text;
  let data = content;
  try { data = JSON.parse(content); } catch { /* plain text */ }
  return { http: res.status, isError: json.result ? json.result.isError : undefined, data, rpcError: json.error };
}

function healthWithHost(port, host) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', headers: { Host: host }, timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => { req.destroy(); resolve('timeout'); });
    req.on('error', (e) => resolve('error ' + e.code));
  });
}

// Minimal MCP SSE client: GET /sse, then POST /messages?sessionId=...; responses arrive on the stream.
async function sseSession(srv) {
  const ctrl = new AbortController();
  const res = await fetch(`http://127.0.0.1:${srv.port}/sse`, { headers: { authorization: `Bearer ${srv.key}`, accept: 'text/event-stream' }, signal: ctrl.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const waiters = new Map();
  let buffer = '';
  let gotEndpoint;
  const endpoint = new Promise((resolve) => { gotEndpoint = resolve; });
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const event = (/^event: (.*)$/m.exec(raw) || [])[1] || 'message';
          const data = raw.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (event === 'endpoint') { gotEndpoint(data); continue; }
          try { const msg = JSON.parse(data); const w = waiters.get(msg.id); if (w) { waiters.delete(msg.id); w(msg); } } catch { /* not JSON */ }
        }
      }
    } catch { /* aborted */ }
  })();
  const url = new URL(await endpoint, `http://127.0.0.1:${srv.port}`).href;
  return {
    async call(name, args) {
      const id = ++rpc;
      const reply = new Promise((resolve) => waiters.set(id, resolve));
      await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${srv.key}` }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) });
      const msg = await reply;
      const text = msg.result && msg.result.content && msg.result.content[0] && msg.result.content[0].text;
      try { return JSON.parse(text); } catch { return text; }
    },
    close() { ctrl.abort(); },
  };
}

function pingCount(target) {
  const { execFileSync } = require('child_process');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process -Filter "Name='PING.EXE'" | Where-Object { $_.CommandLine -like '*${target}*' }).Count`], { encoding: 'utf8', windowsHide: true });
  return Number(out.trim());
}

async function stopServer(srv) {
  if (srv.proc.exitCode !== null) return;
  try { srv.proc.send({ type: 'shutdown' }); } catch { /* channel closed */ }
  for (let i = 0; i < 40 && srv.proc.exitCode === null; i++) await sleep(100);
  if (srv.proc.exitCode === null) spawn('taskkill', ['/pid', String(srv.proc.pid), '/T', '/F'], { windowsHide: true });
}

// A. The port is already taken by another program.
async function testA() {
  const blocker = net.createServer(() => {});
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const port = blocker.address().port;
  const srv = startServer('A', port);
  await sleep(3000);
  const out = srv.out.join('');
  let health;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    health = r.status;
  } catch (e) {
    health = 'no HTTP answer (' + ((e.cause && e.cause.code) || e.name) + ')';
  }
  results.A = {
    port_taken_by_other_process: true,
    server_ready_ipc_sent: srv.msgs.some((m) => m.type === 'server:ready'),
    process_alive_after_3s: srv.proc.exitCode === null,
    server_error_ipc: (srv.msgs.find((m) => m.type === 'server:error') || {}).code || null,
    process_exit_code: srv.proc.exitCode,
    health_on_port: health,
    output_mentions_EADDRINUSE: /EADDRINUSE/.test(out),
  };
  await stopServer(srv);
  blocker.close();
}

async function testsMain() {
  const port = await freePort();
  const srv = startServer('M', port);
  if (!(await waitReady(srv))) {
    results.M = { error: 'server did not start', out: srv.out.join('').slice(-800) };
    return;
  }
  const ws = srv.ws;
  const pad = (i) => String(i).padStart(2, '0');

  // B. Concurrent file_replace on one file.
  if (only.includes('B')) {
    const N = 20;
    const file = path.join(ws, 'race.txt');
    const marker = (i) => `marker-${pad(i)}-end`;
    fs.writeFileSync(file, Array.from({ length: N }, (_, i) => marker(i)).join('\n') + '\n');
    const rs = await Promise.all(Array.from({ length: N }, (_, i) => call(srv, 'file_replace', { path: 'race.txt', target: marker(i), replacement: `done-${pad(i)}` })));
    const final = fs.readFileSync(file, 'utf8');
    const applied = Array.from({ length: N }, (_, i) => final.includes(`done-${pad(i)}`)).filter(Boolean).length;
    const reported = rs.filter((r) => r.isError === false && r.data && r.data.replacements === 1).length;
    const errors = rs.filter((r) => r.isError !== false).map((r) => String((r.data && r.data.error) || r.raw || r.http).slice(0, 110));
    const retry = await call(srv, 'file_replace', { path: 'race.txt', target: marker(0), replacement: `done-${pad(0)}` });
    results.B = {
      parallel_calls: N,
      reported_replacements_1: reported,
      actually_in_file: applied,
      silently_lost: reported - applied,
      errors: [...new Set(errors)],
      retry_already_applied: Boolean(retry.isError === false && retry.data && retry.data.already_applied),
    };
  }

  // C. One shared working directory for all clients.
  if (only.includes('C')) {
    fs.mkdirSync(path.join(ws, 'projA'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'projB'), { recursive: true });
    await call(srv, 'workspace_set_cwd', { path: path.join(ws, 'projA') }); // agent 1
    await call(srv, 'workspace_set_cwd', { path: path.join(ws, 'projB') }); // agent 2, separate request
    const w = await call(srv, 'file_write', { path: 'agent1-note.txt', data: 'agent 1 thinks it is in projA' });
    results.C = {
      agent1_set_cwd: 'projA',
      agent2_set_cwd_later: 'projB',
      agent1_relative_write_landed_in: w.data && w.data.path ? path.relative(ws, w.data.path) : w,
    };
  }

  // I. Relative path silently falls back to FILES_ROOT.
  if (only.includes('I')) {
    fs.mkdirSync(path.join(ws, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'notes', 'todo.md'), 'ROOT ORIGINAL');
    fs.mkdirSync(path.join(ws, 'projA'), { recursive: true });
    await call(srv, 'workspace_set_cwd', { path: path.join(ws, 'projA') });
    const w = await call(srv, 'file_write', { path: 'notes/todo.md', data: 'meant for projA/notes/todo.md' });
    results.I = {
      cwd: 'projA',
      requested: 'notes/todo.md',
      resolved_to: w.data && w.data.path ? path.relative(ws, w.data.path) : w,
      root_file_content_now: fs.readFileSync(path.join(ws, 'notes', 'todo.md'), 'utf8'),
      created_in_projA: fs.existsSync(path.join(ws, 'projA', 'notes', 'todo.md')),
    };
  }

  // G. file_read chunks keep UTF-8 characters whole; the client continues from next_offset.
  if (only.includes('G')) {
    const file = path.join(ws, 'utf8.txt');
    fs.writeFileSync(file, 'привет');
    const chunks = [];
    let offset = 0;
    for (let i = 0; i < 20; i++) {
      const r = await call(srv, 'file_read', { path: file, offset, length: 3 });
      const d = r.data || {};
      chunks.push(d.data);
      if (!d.truncated || typeof d.next_offset !== 'number') break;
      offset = d.next_offset;
    }
    const joined = chunks.join('');
    const mid = await call(srv, 'file_read', { path: file, offset: 3, length: 3 });
    const one = await call(srv, 'file_read', { path: file, length: 1 });
    results.G = {
      chunks_of_3_bytes: JSON.stringify(chunks),
      reassembled: JSON.stringify(joined),
      corrupted: joined !== 'привет' || joined.includes('\uFFFD'),
      offset_3_mid_char_returns_offset: mid.data && mid.data.offset,
      length_1_returns: JSON.stringify(one.data && one.data.data),
    };
  }

  // D. Timeout does not bound the call while a background child holds the output pipe.
  if (only.includes('D')) {
    const t0 = Date.now();
    const r = await call(srv, 'terminal_execute', { shell: 'cmd', command: 'start /b ping -n 9 127.0.0.1 >nul', timeout_ms: 1500 });
    results.D = { timeout_ms: 1500, call_took_ms: Date.now() - t0, timedOut_flag: r.data && r.data.timedOut, exitCode: r.data && r.data.exitCode, backgroundLeft: r.data && r.data.backgroundLeft };
  }

  // S. Each SSE session keeps its own working directory.
  if (only.includes('S')) {
    fs.mkdirSync(path.join(ws, 'sseA'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'sseB'), { recursive: true });
    const a = await sseSession(srv);
    const b = await sseSession(srv);
    await a.call('workspace_set_cwd', { path: path.join(ws, 'sseA') });
    await b.call('workspace_set_cwd', { path: path.join(ws, 'sseB') });
    const w = await a.call('file_write', { path: 'from-a.txt', data: 'session A' });
    const cwdA = await a.call('workspace_get_cwd', {});
    const cwdB = await b.call('workspace_get_cwd', {});
    const rel = (v) => (v && (v.cwd || v.path) ? path.relative(ws, v.cwd || v.path) : v);
    results.S = {
      sessionA_set: 'sseA',
      sessionB_set_later: 'sseB',
      sessionA_relative_write_landed_in: w && w.path ? path.relative(ws, w.path) : w,
      sessionA_cwd_now: rel(cwdA),
      sessionB_cwd_now: rel(cwdB),
    };
    a.close();
    b.close();
  }

  // X. Client disconnect cancels terminal_execute and kills the process tree.
  if (only.includes('X')) {
    const target = `127.0.0.${2 + Math.floor(Math.random() * 200)}`;
    const ctrl = new AbortController();
    const pending = fetch(`http://127.0.0.1:${srv.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${srv.key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpc, method: 'tools/call', params: { name: 'terminal_execute', arguments: { shell: 'cmd', command: `ping -n 30 ${target}`, timeout_ms: 60000 } } }),
      signal: ctrl.signal,
    }).catch((e) => e.name);
    await sleep(2500);
    const before = pingCount(target);
    ctrl.abort();
    await pending;
    await sleep(2000);
    const after = pingCount(target);
    results.X = { ping_processes_before_abort: before, ping_processes_2s_after_abort: after };
  }

  // K. terminal_execute with shell=cmd: UTF-8 built-ins, verbatim quotes and operators, exit code, byte cap.
  if (only.includes('K')) {
    fs.mkdirSync(path.join(ws, 'cyr'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'cyr', 'отчёт.txt'), '');
    const run = async (target, command, cwd) => {
      const r = await call(target, 'terminal_execute', { shell: 'cmd', command, ...(cwd ? { cwd } : {}) });
      const d = r.data || {};
      return { out: String(d.stdout || '').replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trim(), code: d.exitCode, truncated: d.truncated };
    };
    const cases = {
      echo_cyrillic: ['echo привет', 'привет'],
      quotes: ['echo "a b"', '"a b"'],
      quoted_path: ['dir /b "C:\\Program Files" >nul && echo ok', 'ok'],
      ampersand_inside_quotes: ['echo "a & b"', '"a & b"'],
      ampersand: ['echo a & echo b', 'a\nb'],
      pipe: ['echo x | findstr x', 'x'],
      percent: ['echo 100%', '100%'],
      env_var: ['echo %OS%', 'Windows_NT'],
      bang: ['echo hi!', 'hi!'],
      caret: ['echo a^&b', 'a&b'],
      for_loop: ['for %f in (x y) do @echo %f', 'x\ny'],
    };
    const K = {};
    for (const [name, [command, expected]] of Object.entries(cases)) {
      const r = await run(srv, command);
      K[name] = r.out === expected ? 'ok' : `FAIL got ${JSON.stringify(r.out)}`;
    }
    const listing = await run(srv, 'dir /b', path.join(ws, 'cyr'));
    K.dir_cyrillic_name = listing.out === 'отчёт.txt' ? 'ok' : `FAIL got ${JSON.stringify(listing.out)}`;
    K.exit_code_3 = (await run(srv, 'exit /b 3')).code;
    const capped = startServer('K11', await freePort(), { MAX_OUTPUT_BYTES: '11' });
    if (await waitReady(capped)) {
      const r = await run(capped, 'echo привет');
      K.cap_11_bytes = { out: JSON.stringify(r.out), truncated: r.truncated, has_U_FFFD: r.out.includes('\uFFFD') };
    }
    await stopServer(capped);
    results.K = K;
  }

  // F. file_search: long lines, big files, legacy encodings, reported skips, snippets.
  if (only.includes('F')) {
    const dir = path.join(ws, 'search');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'small.txt'), 'NEEDLE_SMALL\n');
    fs.writeFileSync(path.join(dir, 'long.min.js'), 'a'.repeat(4500) + 'NEEDLE_LONG' + 'z'.repeat(9000) + '\n');
    fs.writeFileSync(path.join(dir, 'anchor.txt'), 'b'.repeat(3000) + 'NEEDLE_ANCHOR' + 'c'.repeat(2000) + '\n');
    fs.writeFileSync(path.join(dir, 'big.log'), 'x'.repeat(2.5 * 1024 * 1024) + '\nNEEDLE_BIG\n');
    fs.writeFileSync(path.join(dir, 'cp1251.txt'), Buffer.from([0xef, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x0a]));
    fs.writeFileSync(path.join(dir, 'ps51.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('NEEDLE_UTF16 привет\r\n', 'utf16le')]));
    fs.writeFileSync(path.join(dir, 'emoji.txt'), 'b'.repeat(499) + '\ud83d\ude00 NEEDLE_EMOJI ' + 'd'.repeat(600) + '\n');
    const huge = fs.openSync(path.join(dir, 'huge.txt'), 'w');
    fs.ftruncateSync(huge, 11 * 1024 * 1024); // over the default MAX_FILE_BYTES (10 MB)
    fs.closeSync(huge);
    const q = async (query) => (await call(srv, 'file_search', { path: dir, query })).data || {};
    const count = (d) => (d.results || []).length;
    const small = await q('NEEDLE_SMALL');
    const long = await q('NEEDLE_LONG');
    const emoji = await q('NEEDLE_EMOJI');
    const cyr = await q('привет');
    const snippet = emoji.results && emoji.results[0] ? emoji.results[0].snippet : '';
    results.F = {
      small_file: count(small),
      match_after_4000_chars: count(long),
      long_match_column: long.results && long.results[0] && long.results[0].column,
      caret_anchor_at_window_edge_false_matches: count(await q('^NEEDLE_ANCHOR')),
      file_2_5MB: count(await q('NEEDLE_BIG')),
      cyrillic_matches: (cyr.results || []).map((m) => `${path.basename(m.path)} (${m.encoding || 'utf-8'})`),
      utf16_ascii_match: count(await q('NEEDLE_UTF16')),
      emoji_snippet_contains_match: snippet.includes('NEEDLE_EMOJI'),
      emoji_snippet_lone_surrogate: /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(snippet),
      skipped: (small.skipped || []).map((s) => `${path.basename(s.path)}: ${s.reason}`),
      skipped_total: small.skipped_total,
    };
  }

  // L. file_list pages through next_offset.
  if (only.includes('L')) {
    const dir = path.join(ws, 'many');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 520; i++) fs.writeFileSync(path.join(dir, `f${String(i).padStart(3, '0')}.txt`), '');
    const names = [];
    let offset = 0;
    let pages = 0;
    while (pages < 10) {
      pages++;
      const d = (await call(srv, 'file_list', { path: dir, max_entries: 200, offset })).data || {};
      for (const e of d.entries || []) names.push(path.basename(e.path));
      if (!d.truncated) break;
      offset = d.next_offset;
    }
    results.L = { pages, total: names.length, unique: new Set(names).size };
  }

  await stopServer(srv);
}

// E. Cloudflare quick tunnel: one connection flap (normal edge rotation) with a fake cloudflared.
async function testE() {
  const port = await freePort();
  const dir = path.join(base, 'E');
  fs.mkdirSync(dir, { recursive: true });
  const pidFile = path.join(dir, 'fake-cloudflared.pid');
  // node.exe is used as CLOUDFLARED_EXECUTABLE, so `node tunnel --no-autoupdate --url ...` runs this file.
  fs.writeFileSync(path.join(dir, 'tunnel'), [
    'require("fs").writeFileSync(' + JSON.stringify(pidFile) + ', String(process.pid));',
    'const log = (s) => console.error(new Date().toISOString() + " INF " + s);',
    'log("Requesting new quick Tunnel on trycloudflare.com...");',
    'log("|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |");',
    'log("|  https://audit-flap-test.trycloudflare.com                                                 |");',
    'log("Registered tunnel connection connIndex=0 connection=aaa event=0 ip=198.41.192.7 location=waw01 protocol=quic");',
    'setTimeout(() => log("Unregistered tunnel connection connIndex=0 event=0 ip=198.41.192.7"), 3000);',
    'setTimeout(() => log("Registered tunnel connection connIndex=0 connection=bbb event=0 ip=198.41.200.13 location=waw02 protocol=quic"), 4000);',
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const srv = startServer('E', port, { TUNNEL_PROVIDER: 'cloudflare', CLOUDFLARE_MODE: 'quick', CLOUDFLARED_EXECUTABLE: process.execPath });
  if (!(await waitReady(srv))) { results.E = { error: 'server did not start', out: srv.out.join('').slice(-800) }; return; }
  const host = 'audit-flap-test.trycloudflare.com';
  await sleep(1500);
  const before = await healthWithHost(port, host);
  await sleep(4000);
  const afterReconnect = await healthWithHost(port, host);
  await sleep(40000);
  const atEnd = await healthWithHost(port, host);
  let fakeAlive = 'unknown';
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    try { process.kill(pid, 0); fakeAlive = true; } catch { fakeAlive = false; }
  } catch { /* no pid file */ }
  results.E = {
    tunnel_states: srv.msgs.filter((m) => m.type === 'tunnel:status').map((m) => `${(m.at / 1000).toFixed(1)}s ${m.state}${m.error ? ' (' + String(m.error).slice(0, 70) + ')' : ''}`),
    health_via_tunnel_host_before_flap: before,
    health_via_tunnel_host_after_reconnect: afterReconnect,
    health_via_tunnel_host_after_45s: atEnd,
    tunnel_process_alive_after_45s: fakeAlive,
  };
  await stopServer(srv);
  try { process.kill(Number(fs.readFileSync(pidFile, 'utf8'))); } catch { /* already gone */ }
}

(async () => {
  try {
    if (only.includes('A')) await testA();
    if (['B', 'C', 'D', 'G', 'I', 'S', 'X', 'K', 'F', 'L'].some((t) => only.includes(t))) await testsMain();
    if (only.includes('E')) await testE();
  } catch (e) {
    results.fatal = String((e && e.stack) || e);
  } finally {
    for (const s of servers) await stopServer(s);
    await sleep(500);
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
    console.log(JSON.stringify(results, null, 2));
  }
})();
