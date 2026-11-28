import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { connect, localEndpoint } from './_client.mjs';
import { startServer } from './_server.mjs';

export const external = Boolean(process.env.MCP_URL || process.env.MCP_KEY);
export function externalTarget() {
  if (!external) return undefined;
  if (!process.env.MCP_URL || !process.env.MCP_KEY) throw new Error('Set MCP_URL and MCP_KEY together');
  const u = localEndpoint(process.env.MCP_URL);
  return { mcpUrl:u.href, url:u.origin, key:process.env.MCP_KEY };
}
export async function call(client, name, args = {}, expectError = false) {
  const result = await client.callTool({ name, arguments:args });
  // Do not dump command output, authorisation material or arbitrary result payloads into CI logs.
  assert.equal(Boolean(result.isError), expectError, `${name}: unexpected error status`);
  assert.equal(result.content?.[0]?.type,'text',`${name}: expected text result`);
  return JSON.parse(result.content[0].text);
}
export async function targetFor(t) {
  const outside = externalTarget();
  if (outside) return outside;
  const local = await startServer();
  t.after(()=>local.stop());
  return local;
}

// For external mode the owner deliberately supplies a dedicated local test instance. Check both
// the named temp-root convention and a random disk round trip before any state-changing MCP call.
async function verifyRoot(input) {
  const temp = path.resolve(os.tmpdir()), parent = await fs.realpath(temp);
  if (typeof input !== 'string' || !path.isAbsolute(input) || !/^mcp-conf-[\w-]+$/.test(path.basename(input))
      || ![temp,parent].some(p => path.relative(p,path.dirname(path.resolve(input))) === '')) {
    throw new Error('Refusing changes outside a dedicated mcp-conf-* directory directly under the system temp folder');
  }
  const root = await fs.realpath(input);
  if (path.relative(parent,path.dirname(root)) !== '' || (await fs.lstat(input)).isSymbolicLink()) throw new Error('Fixture root must be a real temporary directory');
  // Check physical containment above, but send paths under FILES_ROOT exactly as the server spells it.
  // Windows can spell the TEMP parent with an alias (for example an 8.3 name).
  return { root:path.resolve(input), physical:root };
}
export async function scenario(t) {
  let srv, client, dir, previous, moved = false;
  t.after(async()=>{
    try {
      if (moved && client && previous) await call(client,'workspace_set_cwd',{path:previous});
    } finally {
      try { if (client) await client.close(); }
      finally { try { if (srv?.stop) await srv.stop(); } finally { if (dir) await fs.rm(dir,{recursive:true,force:true,maxRetries:4}); } }
    }
  });
  srv = externalTarget() ?? await startServer();
  client = await connect(srv);
  const scope = await call(client,'workspace_get_cwd');
  const { root, physical } = await verifyRoot(scope.files_root);
  previous = scope.cwd;
  if (typeof previous !== 'string' || !path.isAbsolute(previous)
      || ![root,physical].some(p => path.relative(p,path.resolve(previous)) === '')) {
    throw new Error('Dedicated fixture must start at its own root');
  }
  dir = await fs.mkdtemp(path.join(root,'case-'));
  const token = randomUUID(), proof = path.join(dir,'fixture.txt');
  await fs.writeFile(proof,token,{flag:'wx'});
  const check = await call(client,'file_read',{path:proof});
  assert.equal(check.data,token,'The connected server does not share the designated local scratch directory');
  return { client, srv, root, dir, async changeCwd(){ moved=true; return call(client,'workspace_set_cwd',{path:dir}); } };
}
