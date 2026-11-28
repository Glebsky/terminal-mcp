// Explicit maintainer action only: ordinary tests never update the reference.
import assert from 'node:assert/strict';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { startServer } from '../tests/conformance/_server.mjs';
import { connect, toolContract } from '../tests/conformance/_client.mjs';

const folder = new URL('../contracts/', import.meta.url);
const file = new URL('tools.json', folder), tmp = new URL(`.tools-${randomUUID()}.tmp`, folder);
const srv = await startServer(); // Ignore MCP_URL/MCP_KEY; never snapshot the developer's running service.
try {
  const client = await connect(srv);
  let result;
  try { result = await toolContract(client); } finally { await client.close(); }
  assert.equal(result.length, 24, 'Review the expected count before changing the public tool set');
  await mkdir(folder, { recursive: true });
  await writeFile(tmp, JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  await rename(tmp, file);
  console.log(`Wrote contracts/tools.json (${result.length} tools)`);
} finally { try { await rm(tmp, { force: true }); } finally { await srv.stop(); } }
