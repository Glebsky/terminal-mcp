// SPEC-011 R1. Network requests in these tests go only to the binary we just started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { start, request, within, reserve, release } from './_native.mjs';

const jsonFile = async p => JSON.parse(await readFile(new URL(p, import.meta.url), 'utf8'));
const catalog = await jsonFile('../../contracts/tools.json');
const reference = catalog.find(t => t.name === 'workspace_get_cwd');
const version = (await jsonFile('../../package.json')).version;
const name = 'notion-terminal-files', legacy = '2025-11-25', modern = '2026-07-28';
const clientInfo = { name: 'native-fixture', version: '1' };
let seq = 0;

async function rpc(s, method, params = {}, rev = legacy) {
  const id = ++seq, headers = {}, args = { ...params };
  if (method !== 'initialize') headers['MCP-Protocol-Version'] = rev;
  if (rev !== legacy) {
    headers['Mcp-Method'] = method;
    if (method === 'tools/call') headers['Mcp-Name'] = params.name;
    args._meta = {
      'io.modelcontextprotocol/protocolVersion': rev,
      'io.modelcontextprotocol/clientInfo': clientInfo,
      'io.modelcontextprotocol/clientCapabilities': {},
    };
  }
  const r = await request(s, '/mcp', { headers, body: { jsonrpc:'2.0', id, method, params:args } });
  const frame = JSON.parse(r.data);
  assert.equal(frame.id, id);
  return { status:r.status, ...frame };
}
async function initialize(s) {
  const init = await rpc(s, 'initialize', { protocolVersion:legacy, capabilities:{}, clientInfo });
  assert.equal(init.status, 200);
  assert.equal(init.result.protocolVersion, legacy);
  assert.equal(init.result.serverInfo.name, name);
  assert.equal(init.result.serverInfo.version, version);
  const ack = await request(s,'/mcp', { headers:{'MCP-Protocol-Version':legacy},
    body:{jsonrpc:'2.0', method:'notifications/initialized'} });
  assert.equal(ack.status, 202);
}
function assertWorkspace(call, root) {
  assert.notEqual(call.isError, true);
  assert.equal(call.content.length, 1);
  assert.equal(call.content[0].type, 'text');
  assert.deepEqual(JSON.parse(call.content[0].text), { cwd:root, files_root:root });
}
async function checkCatalog(s, rev) {
  const listing = await rpc(s,'tools/list',{},rev);
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.result.tools,[reference]);
}
async function checkCwd(s, rev) {
  const call = await rpc(s,'tools/call',{name:reference.name, arguments:{}},rev);
  assert.equal(call.status, 200);
  assertWorkspace(call.result, s.root);
}

test('legacy: initialize, exact catalog, real tool call and fragmented desktop shutdown', async t => {
  const s = await start(t);
  await s.wait('tunnel:status');
  assert.ok(s.events().some(e => e.type === 'tunnel:status' && e.provider === 'none' && e.state === 'disabled'));
  const health = await request(s,'/health',{auth:false});
  assert.equal(health.status, 200);
  assert.deepEqual(JSON.parse(health.data),{status:'ok',server:name,version});
  await initialize(s);
  await checkCatalog(s,legacy);
  await checkCwd(s,legacy);
  s.child.stdin.write('not-json\n{"type":"shut');
  s.child.stdin.write('down"}\r\n');
  assert.equal(await within(s.exit,4000,'Shutdown timeout'),0);
  await release(await reserve(s.port)); // The stopped process actually released its listener.
});

test('modern: first request is a tool call, then discovery; EOF ends the process', async t => {
  const s = await start(t);
  await checkCwd(s,modern); // No initialize or prior discover.
  const d = await rpc(s,'server/discover',{},modern);
  assert.equal(d.status, 200);
  assert.deepEqual([...d.result.supportedVersions].sort(),[legacy,modern]);
  await checkCatalog(s,modern);
  const future = '2099-01-01';
  const unsupported = await rpc(s,'tools/list',{},future);
  assert.equal(unsupported.status,400);
  assert.equal(unsupported.error.code,-32022);
  assert.equal(unsupported.error.data.requested,future);
  assert.deepEqual([...unsupported.error.data.supported].sort(),[legacy,modern]);
  s.child.stdin.end();
  assert.equal(await within(s.exit,4000,'EOF timeout'),0);
});

test('locked TS SDK interoperates with the Rust server, not a fallback TS child', async t => {
  const { connect, toolContract } = await import('../conformance/_client.mjs');
  const s = await start(t), client = await connect(s);
  try {
    assert.deepEqual(await toolContract(client), [reference]);
    assertWorkspace(await client.callTool({name:reference.name,arguments:{}}),s.root);
  } finally { await client.close(); }
  assert.equal((await request(s,'/health',{auth:false})).status,200);
});

test('Host, Origin and credentials are enforced; disabled tool is neither listed nor callable', async t => {
  const s = await start(t,{env:{DISABLED_TOOLS:'workspace_get_cwd'}});
  const body = {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:legacy,capabilities:{},clientInfo}};
  assert.equal((await request(s,'/mcp',{body,auth:false})).status,401);
  assert.equal((await request(s,'/mcp',{body,headers:{Authorization:'Bearer fixture-wrong-key'}})).status,401);
  assert.equal((await request(s,'/health',{auth:false,headers:{Host:'untrusted.invalid'}})).status,421);
  assert.equal((await request(s,'/mcp',{body,headers:{Host:'untrusted.invalid'}})).status,421);
  assert.equal((await request(s,'/mcp',{body,headers:{Origin:'https://other.invalid'}})).status,403);
  assert.equal((await request(s,'/mcp',{body,auth:false,headers:{'X-API-Key':s.key}})).status,200);
  await initialize(s);
  assert.deepEqual((await rpc(s,'tools/list')).result.tools,[]);
  assert.ok((await rpc(s,'tools/call',{name:reference.name,arguments:{}})).error);
});

test('workspace root is lexically normalized without substituting its physical spelling', async t => {
  const s = await start(t, { aliasRoot: true, dotRoot: true });
  await initialize(s);
  await checkCwd(s,legacy);
});

test('busy port: EADDRINUSE, no ready event and exit code 1', async t => {
  const blocker = await reserve();
  try {
    const port = blocker.address().port, s = await start(t,{port,ready:false});
    assert.equal(await within(s.exit,5000,'Busy-port child timeout'),1);
    assert.ok(s.events().some(e=>e.type==='server:error' && e.code==='EADDRINUSE' && e.port===port));
    assert.ok(!s.events().some(e=>e.type==='server:ready'));
  } finally { await release(blocker); }
});

test('unsupported access mode: exit before binding', async t => {
  const s = await start(t,{ready:false,env:{FULL_ACCESS:'true'}});
  assert.equal(await within(s.exit,5000,'Invalid-config child timeout'),1);
  assert.ok(s.events().some(e=>e.type==='server:error' && e.code==='INVALID_CONFIG'));
  assert.ok(!s.events().some(e=>e.type==='server:ready'));
});
