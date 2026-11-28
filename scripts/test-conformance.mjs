import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../',import.meta.url));
function node(args) {
  const run = spawnSync(process.execPath,args,{cwd:root,stdio:'inherit'});
  if (run.error) throw run.error;
  if (run.status !== 0) process.exit(run.status ?? 1);
}
if (Boolean(process.env.MCP_URL) !== Boolean(process.env.MCP_KEY)) throw new Error('Set MCP_URL and MCP_KEY together');
if (!process.env.MCP_URL) node(['node_modules/typescript/bin/tsc','-p','tsconfig.json']);
const files=readdirSync(new URL('../tests/conformance/',import.meta.url)).filter(x=>x.endsWith('.test.mjs')).sort();
if (!files.length) throw new Error('No conformance tests found');
// Explicit files work on Windows and Node 20; no shell-specific wildcard expansion.
node(['--test','--test-concurrency=1',...files.map(name=>'tests/conformance/'+name)]);
