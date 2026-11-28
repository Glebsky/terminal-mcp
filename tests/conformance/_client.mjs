import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

export function localEndpoint(value) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname)
      || !u.port || u.username || u.password || u.search || u.hash || u.pathname !== '/mcp') {
    throw new Error('Conformance requires a dedicated loopback endpoint on an explicit port ending in /mcp. Do not use a live server.');
  }
  return u;
}

export async function connect(target, transportName = 'http') {
  const endpoint = localEndpoint(target.mcpUrl);
  const session = new Client({ name: 'spec009-conformance', version: '1' }, { capabilities: {} });
  const lifetime = new AbortController();
  const guardedFetch = (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== endpoint.origin) throw new Error('Test transport refused a different origin');
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    // SDK 1.30 optionally starts an unbounded notification GET after sending initialized.
    // This finite RPC client does not subscribe: cancel that optional request BEFORE I/O.
    // All RPC responses are real; the dedicated SSE client below exercises /sse + /messages.
    if (transportName === 'http' && method === 'GET' && url.pathname === endpoint.pathname) {
      throw new DOMException('This request/response client does not subscribe to notifications', 'AbortError');
    }
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${target.key}`);
    // Tie permitted requests to the fixture lifetime; do not keep HTTP connections for another case.
    const upstream = init.signal ?? (input instanceof Request ? input.signal : undefined);
    const signal = upstream ? AbortSignal.any([upstream,lifetime.signal]) : lifetime.signal;
    headers.set('Connection','close');
    return fetch(input, { ...init, headers, signal, redirect: 'error' });
  };
  const transport = transportName === 'sse'
    ? new SSEClientTransport(new URL('/sse', endpoint), { fetch: guardedFetch })
    : new StreamableHTTPClientTransport(endpoint, { fetch: guardedFetch });
  try { await session.connect(transport, { timeout: 15000 }); }
  catch (error) { lifetime.abort(); await transport.close().catch(() => {}); throw error; }
  return {
    listTools: session.listTools.bind(session), callTool: session.callTool.bind(session),
    async close() { try { await session.close(); } finally { lifetime.abort(); } },
  };
}

const fields = ['name', 'title', 'description', 'inputSchema', 'annotations'];
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical); // Array order is meaningful in JSON Schema.
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export async function toolContract(client) {
  const tools = [], seen = new Set(), cursors = new Set();
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    for (const t of page.tools) {
      if (seen.has(t.name)) throw new Error(`Duplicate registered tool: ${t.name}`);
      seen.add(t.name);
      tools.push(Object.fromEntries(fields.filter(k => t[k] !== undefined).map(k => [k, canonical(t[k])])));
    }
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error('Repeated tools/list cursor');
    cursors.add(cursor);
  } while (cursor);
  return tools.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
