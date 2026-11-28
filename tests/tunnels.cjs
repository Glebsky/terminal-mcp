const { fork, execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const sleep = ms => new Promise(r => setTimeout(r,ms));
async function freePort(){return new Promise((resolve,reject)=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))});s.on('error',reject)})}
async function waitFor(fn,ms=10000){const end=Date.now()+ms;while(Date.now()<end){const x=fn();if(x)return x;await sleep(30)}throw Error('timed out waiting for expected event')}
function req(port,host){return new Promise((resolve,reject)=>{http.get({hostname:'127.0.0.1',port,path:'/mcp',headers:{host}},r=>{r.resume();r.on('end',()=>resolve(r.statusCode))}).on('error',reject)})}
async function main(){
 const dir=mkdtempSync(path.join(tmpdir(),'mcp-tunnel-test-'));
 const key='test-'+'x'.repeat(40);
 try {
  // Migration keeps legacy ngrok credentials and unrelated .env entries.
  const envFile=path.join(dir,'.env'); writeFileSync(envFile,`# keep me\nMCP_API_KEY=${key}\nNGROK_ENABLED=true\nNGROK_AUTHTOKEN=legacy-test-token\nNGROK_DOMAIN=example.ngrok.app\nCUSTOM_KEEP=value\n`);
  const {ServerManager}=await import(pathToFileURL(path.resolve('dist-desktop/main/server-manager.js')));
  const manager=new ServerManager(process.cwd(),dir); let cfg=await manager.getEnvConfig();
  assert.equal(cfg.TUNNEL_PROVIDER,'ngrok');
  assert.equal((await manager.saveEnvConfig({TUNNEL_PROVIDER:'tuna',TUNA_SUBDOMAIN:'sample'})).success,true);
  cfg=await manager.getEnvConfig(); assert.equal(cfg.TUNNEL_PROVIDER,'tuna'); assert.equal(cfg.NGROK_AUTHTOKEN,'legacy-test-token'); assert.equal(cfg.NGROK_DOMAIN,'example.ngrok.app');
  assert.match(readFileSync(envFile,'utf8'),/CUSTOM_KEEP=value/); assert.match(readFileSync(envFile,'utf8'),/# keep me/);
  assert.equal((await manager.saveEnvConfig({TUNNEL_PROVIDER:'ngrok'})).success,true); assert.equal((await manager.getEnvConfig()).NGROK_ENABLED,'true');
  console.log('settings migration and preservation: OK');
  // Build a local fixture executable. It does not connect to the internet.
  if(process.platform!=='win32') { console.log('CLI fixture skipped: Windows-only compiler'); return; }
  const csc=path.join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
  const source=path.join(dir,'fake.cs'), exe=path.join(dir,'fake.exe');
  writeFileSync(source,`using System; using System.Threading; class Fixture { static void Main(string[] a) { var t=a[0]=="http"; if(t && (Environment.GetEnvironmentVariable("TUNA_INSPECT")!="false" || Environment.GetEnvironmentVariable("TUNA_TUI")!="0" || Environment.GetEnvironmentVariable("TUNA_API_KEY")!="fake-secret")) Environment.Exit(7); if(t){Console.Write("Forwarding https://unit."); Thread.Sleep(120); Console.WriteLine("ru.tuna.am -> localhost:1234");} else {Console.Error.Write("https://unit."); Thread.Sleep(120); Console.Error.WriteLine("trycloudflare.com");} Thread.Sleep(1800); } }`);
  execFileSync(csc,['/nologo','/out:'+exe,source]);
  for(const provider of ['tuna','cloudflare','missing']){
   const port=await freePort(), events=[]; let logs='';
   const env={...process.env,DOTENV_PATH:path.join(dir,'none'),PORT:String(port),HOST:'127.0.0.1',MCP_API_KEY:key,NGROK_ENABLED:'false',NGROK_DOMAIN:'',TUNNEL_PROVIDER:provider==='missing'?'tuna':provider,TUNA_API_KEY:'fake-secret',TUNA_EXECUTABLE:provider==='missing'?path.join(dir,'missing.exe'):exe,CLOUDFLARED_EXECUTABLE:exe,ALLOWED_HOSTS:`127.0.0.1:${port}`,FILES_ROOT:dir};
   const child=fork(path.resolve('dist/index.js'),[],{cwd:dir,env,silent:true}); child.on('message',m=>{if(m.type==='tunnel:status')events.push(m)}); child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
   try {
    if(provider==='missing') {let e=await waitFor(()=>events.find(x=>x.state==='error'));assert.match(e.error,/not found/);}
    else {
     const expected=provider==='cloudflare'?'unverified':'connected';const e=await waitFor(()=>events.find(x=>x.state===expected));if(provider==='cloudflare')assert.match(e.error||'',/SSE/);const hostname=new URL(e.url).host;
     assert.equal(hostname,provider==='tuna'?'unit.ru.tuna.am':'unit.trycloudflare.com');
     assert.equal(await req(port,hostname),401); assert.equal(await req(port,'untrusted.example'),421);
     await waitFor(()=>events.find(x=>x.state==='error')); assert.equal(await req(port,hostname),421);
    }
    if(provider==='cloudflare') assert.ok(/Quick Tunnel is for testing only[^\r\n]*\/mcp[^\r\n]*\/sse/i.test(logs), 'missing Quick Tunnel test-only startup notice');
    assert(!logs.includes(key)); assert(!logs.includes('fake-secret')); console.log(provider+': status, isolation and host validation OK');
   } finally { if(child.connected)child.send({type:'shutdown'}); await waitFor(()=>child.exitCode!==null,5000); }
  }
 } finally {rmSync(dir,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e);process.exitCode=1});
