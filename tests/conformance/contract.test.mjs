import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { connect, toolContract } from './_client.mjs';
import { targetFor } from './_fixture.mjs';
import { deadline } from './_server.mjs';

const reference = new URL('../../contracts/tools.json', import.meta.url);

test('the live tools/list matches the independently stored contract', async t => {
  const target = await targetFor(t), session = await connect(target);
  let live;
  try { live = await toolContract(session); } finally { await session.close(); }
  assert.equal(live.length, 24);
  assert.deepStrictEqual(live, JSON.parse(await readFile(reference, 'utf8')));
});

test('the SDK client exits on its own while the independently running server remains available', async t => {
  const target = await targetFor(t);
  const moduleUrl = new URL('./_client.mjs', import.meta.url).href;
  // Separate process so accidentally retained handles cannot be hidden by stopping the server.
  const code = `import {connect} from ${JSON.stringify(moduleUrl)};
    for(const mode of ['http','http','sse']) {
      const c=await connect({mcpUrl:process.env.FIXTURE_URL,key:process.env.FIXTURE_KEY},mode);
      try { await c.listTools(); } finally { await c.close(); }
    }
    console.log('closed');`;
  const env = {FIXTURE_URL:target.mcpUrl,FIXTURE_KEY:target.key};
  if (process.env.SystemRoot) env.SystemRoot=process.env.SystemRoot;
  const child = spawn(process.execPath,['--input-type=module','-e',code],{env,windowsHide:true,stdio:['ignore','pipe','ignore']});
  const closed = new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  // 'closed' means Client.close() returned; process exit proves there was no lingering subscription.
  let acknowledged = false;
  const ack = new Promise(resolve=>{ let text=''; child.stdout.setEncoding('utf8'); child.stdout.on('data',s=>{
    text+=s; if (text.includes('closed')) { acknowledged=true; resolve(); }
  }); });
  try {
    await deadline(Promise.race([ack,closed.then(rc=>{assert.equal(rc,0);assert.ok(acknowledged,'SDK client closed before completing its sessions');})]),30000,'SDK client did not complete all three sessions');
    assert.equal(await deadline(closed,7000,'SDK client retained a connection after close'),0);
    const health=await fetch(new URL('/health',target.mcpUrl),{redirect:'error',signal:AbortSignal.timeout(5000)});
    assert.equal(health.status,200); await health.arrayBuffer();
  } finally {
    if (child.exitCode===null && child.signalCode===null) child.kill();
    await deadline(closed,7000,'Fixture client cleanup did not finish');
  }
});
