import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { call, external, scenario, targetFor } from './_fixture.mjs';
import { connect, toolContract } from './_client.mjs';
import { startServer } from './_server.mjs';

function initStatus(srv, headers = {}, keyInQuery = false) {
  const url = new URL(srv.mcpUrl);
  if (keyInQuery) url.searchParams.set('key', srv.key);
  const data = JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{ protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'conformance',version:'1'} }});
  return new Promise((resolve,reject)=>{
    const req = (url.protocol === 'https:' ? https : http).request(url,{method:'POST',agent:false,headers:{Accept:'application/json, text/event-stream','Content-Type':'application/json',...headers}}, res=>{
      res.resume(); res.once('end',()=>resolve(res.statusCode)); res.once('error',reject);
    });
    req.setTimeout(10000,()=>req.destroy(new Error('Local HTTP request timed out')));
    req.once('error',reject); req.end(data);
  });
}

test('auth: the two header methods work, an absent key and a wrong Host do not',async t=>{
  const srv=await targetFor(t);
  assert.equal(await initStatus(srv),401);
  assert.equal(await initStatus(srv,{Authorization:`Bearer ${srv.key}`}),200);
  assert.equal(await initStatus(srv,{'x-api-key':srv.key}),200);
  assert.equal(await initStatus(srv,{Host:'not-the-test-host.invalid',Authorization:`Bearer ${srv.key}`}),421);
  // Never put a developer-supplied key in a URL; this negative check only uses a fixture key.
  if (!external) assert.equal(await initStatus(srv,{},true),401);
});

test('query-key opt-in uses an isolated server with an ephemeral key', {skip:external}, async t=>{
  const srv=await startServer({env:{AUTH_METHODS:'query'}}); t.after(()=>srv.stop());
  assert.equal(await initStatus(srv,{},true),200);
  assert.equal(await initStatus(srv,{Authorization:`Bearer ${srv.key}`}),401);
});

test('files: UTF-8 bytes, base64, idempotent replace, move, stat and delete',async t=>{
  const {client,dir}=await scenario(t);
  const src=path.join(dir,'пример.txt'), dst=path.join(dir,'итог.txt');
  const text='Привет, ёж!\n', changed='Привет, мир!\n';
  const size=Buffer.byteLength(text);
  assert.equal((await call(client,'file_write',{path:src,data:text})).bytes_written,size);
  assert.equal((await call(client,'file_read',{path:src})).data,text);
  assert.equal((await call(client,'file_read',{path:src,encoding:'base64'})).data,Buffer.from(text).toString('base64'));
  const edit={path:src,target:'ёж',replacement:'мир'};
  assert.equal((await call(client,'file_replace',edit)).replacements,1);
  const again=await call(client,'file_replace',edit); assert.equal(again.already_applied,true); assert.equal(again.replacements,0);
  await call(client,'file_move',{source:src,destination:dst});
  await assert.rejects(fs.stat(src),{code:'ENOENT'});
  assert.equal((await call(client,'file_stat',{path:dst})).type,'file');
  assert.deepEqual(await fs.readFile(dst),Buffer.from(changed));
  assert.equal((await call(client,'file_delete',{path:dst})).deleted,true);
  await assert.rejects(fs.stat(dst),{code:'ENOENT'});
});

test('sandbox: read/write rejected for an absolute or relative sibling fixture',async t=>{
  const {client,root}=await scenario(t);
  const sibling=await fs.mkdtemp(path.join(os.tmpdir(),'mcp-boundary-'));
  try {
    const marker=path.join(sibling,'sentinel.txt'); await fs.writeFile(marker,'test fixture only');
    for (const input of [marker,path.relative(root,marker)]) {
      for (const [name,args] of [['file_read',{path:input}],['file_write',{path:input,data:'changed'}]]) {
        const result=await call(client,name,args,true); assert.match(result.error,/denied|outside.*sandbox/i);
      }
    }
    assert.equal(await fs.readFile(marker,'utf8'),'test fixture only');
  } finally { await fs.rm(sibling,{recursive:true,force:true,maxRetries:4}); }
});

test('terminal: fixed benign fixtures distinguish success, nonzero exit and deadline',async t=>{
  const {client,dir}=await scenario(t);
  const opts={shell:'powershell',cwd:dir};
  const ok=await call(client,'terminal_execute',{...opts,command:"Write-Output 'ok'"});
  assert.equal(ok.exitCode,0); assert.equal(ok.stdout.trim(),'ok');
  const error=await call(client,'terminal_execute',{...opts,command:'exit 7'},true); assert.equal(error.exitCode,7);
  const start=performance.now();
  const expired=await call(client,'terminal_execute',{...opts,command:'Start-Sleep 10',timeout_ms:1000},true);
  const elapsed=performance.now()-start;
  assert.equal(expired.timedOut,true); assert.ok(elapsed<=3000,`1000 ms timeout took ${Math.round(elapsed)} ms`);
});

test('workspace: relative writes land in the selected subdirectory',async t=>{
  const {client,dir,changeCwd}=await scenario(t);
  const cwd=await changeCwd(); assert.equal(path.relative(dir,cwd.cwd),'');
  await call(client,'file_write',{path:'relative.txt',data:'in the subdirectory'});
  assert.equal(await fs.readFile(path.join(dir,'relative.txt'),'utf8'),'in the subdirectory');
});

test('SSE handshake and tools/list via its advertised messages endpoint',async t=>{
  const srv=await targetFor(t), client=await connect(srv,'sse');
  try { const tools=await toolContract(client); assert.equal(tools.length,24); assert.ok(tools.some(x=>x.name==='file_read')); }
  finally { await client.close(); }
});

test('browser: a fresh headless browser reads a loopback fixture only', {skip: external || process.env.CONFORMANCE_BROWSER !== '1'}, async t=>{
  const {client}=await scenario(t);
  const page=http.createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<title>SPEC-009</title><main>fixture content</main>');});
  await new Promise((resolve,reject)=>{page.once('error',reject);page.listen(0,'127.0.0.1',resolve);});
  try {
    await call(client,'browser_open',{url:`http://127.0.0.1:${page.address().port}/`,headless:true});
    const result=await call(client,'browser_get_content',{type:'text',selector:'main'}); assert.equal(result.content,'fixture content');
  } finally {
    try { await call(client,'browser_close',{}); }
    finally { page.closeAllConnections(); await new Promise(resolve=>page.close(resolve)); }
  }
});
