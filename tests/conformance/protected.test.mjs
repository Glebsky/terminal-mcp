import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer, tempDir } from './_server.mjs';
import { connect } from './_client.mjs';
import { call, external } from './_fixture.mjs';

// Never run the self-protection fixtures against a supplied MCP_URL or the developer's config.
// The config files below contain comments, not credentials. The server has only synthetic values.
async function fixture(t) {
  const root = tempDir();
  const resources = {};
  t.after(async()=>{
    try { if(resources.client) await resources.client.close(); }
    finally { try { if(resources.server) await resources.server.stop(); }
      finally { await fs.rm(root,{recursive:true,force:true,maxRetries:4}); } }
  });
  const cfg = path.join(root,'.fixture-settings'), extra = path.join(root,'owner-data','locked.txt');
  const audit = path.join(root,'test-audit.jsonl');
  const sample = path.join(root,'ordinary.txt'), envFile = path.join(cfg,'.env');
  const data = '# shared fixture phrase\n', marker = 'demo-marker-"quoted"-for-tests';
  await fs.mkdir(cfg); await fs.mkdir(path.dirname(extra));
  for (const f of [envFile,extra,path.join(root,'.env'),path.join(root,'.env.local'),path.join(root,'.env.example')]) await fs.writeFile(f,data);
  await fs.writeFile(sample,'shared fixture phrase'); await fs.writeFile(audit,'');
  return {root,cfg,envFile,extra,audit,sample,data,marker,resources};
}
async function localClient(f) {
  const srv = await startServer({root:f.root,env:{AUDIT_LOG_FILE:f.audit,PROTECTED_PATHS:f.extra,BASIC_AUTH_PASSWORD:f.marker}});
  f.resources.server=srv;
  const client = await connect(srv); f.resources.client=client;
  return client;
}

test('file policy: private configuration is metadata-only; unrelated project files still work', {skip:external}, async t=>{
  const f=await fixture(t), c=await localClient(f);
  for(const p of [f.envFile, f.extra, f.audit, path.join(f.root,'.env'), path.join(f.root,'.env.local')]) {
    assert.equal((await call(c,'file_stat',{path:p})).protected,true,'protected marker missing');
  }
  const listed=await call(c,'file_list',{path:f.root});
  assert.equal(listed.entries.find(e=>e.path===f.cfg)?.protected,true);
  assert.equal((await call(c,'file_stat',{path:f.sample})).protected,undefined);
  const deny=async (name,args)=>{ const res=await call(c,name,args,true); assert.match(res.error,/protected server configuration/); };
  await deny('file_read',{path:f.envFile}); await deny('file_write',{path:f.envFile,data:'blocked'});
  await deny('file_replace',{path:f.envFile,target:'phrase',replacement:'blocked'});
  await deny('file_mkdir',{path:path.join(f.cfg,'new-folder')});
  await deny('file_delete',{path:f.envFile});
  await deny('file_move',{source:f.sample,destination:f.extra,overwrite:true});
  await deny('file_move',{source:path.dirname(f.extra),destination:path.join(f.root,'moved')});
  await deny('file_delete',{path:path.dirname(f.extra),recursive:true});
  const url=pathToFileURL(f.envFile).href;
  for (const tool of ['browser_open','browser_navigate','browser_new_tab']) await deny(tool,{url});
  assert.equal(await fs.readFile(f.envFile,'utf8'),f.data); assert.equal(await fs.readFile(f.extra,'utf8'),f.data);
  const found=await call(c,'file_search',{path:f.root,query:'shared fixture phrase'});
  assert.deepEqual(found.results.map(r=>path.basename(r.path)).sort(),['.env.example','ordinary.txt']);
  assert.ok(found.skipped.some(r=>r.path===f.cfg && r.reason==='protected'));
  const plain='token = "abc"; password: example';
  await call(c,'file_write',{path:f.sample,data:plain}); assert.equal((await call(c,'file_read',{path:f.sample})).data,plain);
  assert.equal((await call(c,'file_read',{path:path.join(f.root,'.env.example')})).data,f.data);
  const events=(await fs.readFile(f.audit,'utf8')).trim().split('\n').map(l=>JSON.parse(l));
  for(const n of ['file_read','file_write','file_replace','file_mkdir','file_delete','file_move','file_search','browser_open','browser_navigate','browser_new_tab']) {
    assert.ok(events.some(e=>e.action==='protected_denied' && e.tool===n),'missing audit decision for '+n);
  }
});

test('tool output: exact sample value in JSON and errors is masked without rewriting project text or byte offsets', {skip:external}, async t=>{
  const f=await fixture(t), c=await localClient(f);
  const text='token = "abc"; '+f.marker+' | конец'; await fs.writeFile(f.sample,text);
  const r=await call(c,'file_read',{path:f.sample});
  assert.equal(r.data.includes(f.marker),false,'literal sample value was not masked');
  assert.equal(r.data,'token = "abc"; [REDACTED] | конец'); assert.equal(r.bytes_read,Buffer.byteLength(text));
  // Invalid search syntax is a regular tool error; do not use OS commands or read private files.
  // Print only a public literal invented above, never read a credential or the config with a shell.
  if(process.platform==='win32') {
    const out=await call(c,'terminal_execute',{shell:'powershell',command:`Write-Output '${f.marker}'`});
    assert.equal(out.exitCode,0); assert.equal(out.stdout.trim(),'[REDACTED]');
  }
  const invalid=await call(c,'file_search',{path:f.root,query:'('+f.marker},true);
  assert.equal(invalid.error.includes(f.marker), false); assert.match(invalid.error,/\[REDACTED\]/);
  const prefix=text.indexOf(' |');
  const page=await call(c,'file_read',{path:f.sample,length:prefix});
  assert.equal(page.next_offset,prefix); assert.match(page.data,/\[REDACTED\]$/);
  assert.equal((await call(c,'file_read',{path:f.sample,offset:page.next_offset})).data,' | конец');
});

test('full-access policy also denies private fixtures, without starting a privileged MCP listener', {skip:external}, async t=>{
  const f=await fixture(t);const sys=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(path|systemroot|windir|comspec|temp|tmp|home|userprofile)$/i.test(k)));
  await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../support/protected-local.mjs',import.meta.url))],{
    cwd:f.root,windowsHide:true,timeout:15000,env:{...sys,FILES_ROOT:f.root,DOTENV_PATH:f.envFile,PROTECTED_PATHS:f.extra,FULL_ACCESS:'true',TUNNEL_PROVIDER:'none',MCP_API_KEY:'unused-test-fixture-value-000000000',BASIC_AUTH_PASSWORD:'  '+f.marker+'  '}
  });
});
