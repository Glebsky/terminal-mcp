// Exercise the real Electron main-process manager without opening a window or tunnel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ServerManager } from '../dist-desktop/main/server-manager.js';

// A stand-in for the Rust binary: it accepts only documented line frames and exits on shutdown.
const lineServer = String.raw`
const { createInterface } = require('node:readline');
if (process.send || process.env.MCP_CONTROL !== 'stdio') process.exit(42);
const event = e => process.stdout.write('[CTL] ' + JSON.stringify(e) + '\n');
let boot = true;
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', raw => {
  const msg = JSON.parse(raw);
  if (msg.type === 'shutdown') return process.stdout.write('fixture graceful shutdown\n', () => process.exit(0));
  if (msg.type !== 'monitor:set') return;
  if (boot) {
    boot = false;
    if (msg.enabled !== false) process.exit(43);
    process.stdout.write('[CTL] not-json\n[CTL] {"type":"future:v2"}\n');
    process.stdout.write('[CT');
    setImmediate(() => {
      process.stdout.write('L] {"type":"server:ready"}\r\n');
      event({ type:'tunnel:status',provider:'cloudflare',state:'unverified',url:'https://fixture.invalid' });
      process.stdout.write('[AUDIT] stamp | file_read | fixture\n');
    });
  } else if (msg.enabled) {
    event({type:'monitor:snapshot',snapshot:{received:1,sent:2,totalReceived:1,totalSent:2,totalRequests:1,activeRequests:0,activeSse:0,activeHttp:0,recentClients:[],operations:[],sampledAt:123}});
  }
});`;

async function until(fn, label) {
  for (let i=0; i<160; i++) { if (fn()) return; await delay(25); }
  assert.fail(`Did not observe ${label}`);
}
async function fixture(t, program) {
  // This guard prevents a developer's portable install from becoming a test fixture.
  const old = process.env.MCP_TERMINAL_ENV_PATH;
  delete process.env.MCP_TERMINAL_ENV_PATH;
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'spec009-desktop-'));
  const dir=path.join(root,'dist'); await fs.mkdir(dir);
  await fs.writeFile(path.join(dir,'index.js'),program);
  await fs.writeFile(path.join(root,'package.json'),'{"type":"commonjs"}');
  const manager=new ServerManager(root,root), logs=[], states=[], snapshots=[];
  manager.setCallbacks(entry=>logs.push(entry), state=>states.push(state));
  manager.setMonitorCallback(s=>snapshots.push(s));
  t.after(async()=>{ try { await manager.stop(); } finally {
    if (old === undefined) delete process.env.MCP_TERMINAL_ENV_PATH; else process.env.MCP_TERMINAL_ENV_PATH=old;
    await fs.rm(root,{recursive:true,force:true,maxRetries:3});
  }});
  await manager.getEnvConfig();
  return {manager,logs,states,snapshots};
}

test('desktop speaks stdio: initial setting, split frames, audit, monitor switch, graceful stop',async t=>{
  const {manager,logs,states,snapshots}=await fixture(t,lineServer);
  manager.setMonitoring(false);
  assert.equal((await manager.start()).success,true);
  await until(()=>states.some(s=>s.state==='running'),'server:ready on stdout');
  assert.ok(states.some(s=>s.state==='starting'));
  await until(()=>states.some(s=>s.tunnelProvider==='cloudflare' && s.tunnelState==='unverified' && s.tunnelUrl==='https://fixture.invalid'),'tunnel status in desktop');
  await until(()=>logs.some(l=>l.type==='audit' && l.category==='file'),'ordinary audit line');
  manager.setMonitoring(true);
  await until(()=>snapshots.some(s=>s.sampledAt===123),'monitor snapshot');
  await manager.stop();
  assert.equal(manager.getStatus().state,'offline');
  assert.ok(logs.some(l=>l.message.includes('fixture graceful shutdown')));
  assert.ok(!logs.some(l=>String(l.raw||l.message).includes('[CTL]')));
});

test('desktop keeps the busy-port explanation after the child exits',async t=>{
  const {manager,logs}=await fixture(t,`process.stdout.write('[CTL] '+JSON.stringify({type:'server:error',code:'EADDRINUSE',port:31415,message:'test'})+'\\n',()=>process.exit(1))`);
  assert.equal((await manager.start()).success,true);
  await until(()=>logs.some(l=>l.message.includes('exit code: 1')),'child exit');
  assert.equal(manager.getStatus().state,'error');
  assert.match(manager.getStatus().error,/31415.*already in use/i);
});

// A burst of distinct operations can produce one legitimate monitor frame bigger than an ordinary log line.
test('desktop retains a large control frame split across stdout chunks without logging its tail', async t => {
  const program = String.raw`
    const {createInterface}=require('node:readline');
    const ops=Array.from({length:1100},(_,i)=>({operation:'long-fixture-operation-'+i+'x'.repeat(60),received:1,sent:2}));
    const snap={received:1,sent:2,totalReceived:1,totalSent:2,totalRequests:1,activeRequests:0,activeHttp:0,activeSse:0,recentClients:[],operations:ops,sampledAt:456};
    const frame='[CTL] '+JSON.stringify({type:'monitor:snapshot',snapshot:snap})+'\n';
    process.stdout.write(frame.slice(0,80000),()=>setTimeout(()=>process.stdout.write(frame.slice(80000)),75));
    createInterface({input:process.stdin}).on('line',s=>{if(JSON.parse(s).type==='shutdown')process.exit(0)});`;
  const {manager,snapshots,logs}=await fixture(t,program);
  assert.equal((await manager.start()).success,true);
  await until(()=>snapshots.some(s=>s.sampledAt===456 && s.operations.length===1100),'complete large monitor frame');
  assert.ok(!logs.some(l=>String(l.raw||l.message).includes('long-fixture-operation')));
});
