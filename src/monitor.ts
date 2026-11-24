import type { Request, Response, NextFunction } from "express";

// Only authenticated MCP payload bodies are measured. Headers and network framing
// are intentionally excluded, and neither tokens nor payload contents are retained.
const requestSizes = new WeakMap<Request, number>();
let enabled = true;
let received = 0;
let sent = 0;
let totalReceived = 0;
let totalSent = 0;
let totalRequests = 0;
let nextId = 0;
let getOpenSseCount: () => number = () => 0;
export function setSseCountProvider(provider: () => number): void { getOpenSseCount = provider; }

export interface ClientItem {
  client: string;
  displayName: string;
  version?: string;
  peer: string;
  operation: string;
  lastSeen: string;
  requests: number;
}

export interface ClientIdentity {
  displayName: string;
  version?: string;
}

const active = new Map<number, { client: string; operation: string; kind: "sse" | "http" }>();
const recent = new Map<string, ClientItem>();
const operations = new Map<string, { received: number; sent: number }>();

const sessionClients = new Map<string, ClientIdentity>();
const socketClients = new WeakMap<object, ClientIdentity>();
const peerClients = new Map<string, { identity: ClientIdentity; timestamp: number }>();

export function forgetSessionClient(sessionId: string): void {
  sessionClients.delete(sessionId);
}

export function recordRequestBody(req: Request, body: Buffer): void {
  requestSizes.set(req, body.length);
}

function sizeOf(chunk: unknown, encoding?: unknown): number {
  if (typeof chunk === "string") return Buffer.byteLength(chunk, typeof encoding === "string" ? encoding as BufferEncoding : "utf8");
  return chunk instanceof Uint8Array ? chunk.byteLength : 0;
}

function addBytes(operation: string, direction: "received" | "sent", count: number): void {
  if (!enabled || !count) return;
  const item = operations.get(operation) || { received: 0, sent: 0 };
  item[direction] += count;
  operations.set(operation, item);
  if (direction === "received") { received += count; totalReceived += count; }
  else { sent += count; totalSent += count; }
}

function safeLabel(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 80) || fallback : fallback;
}

export function formatPeer(address: string | undefined): string {
  if (!address) return "unknown peer";
  let clean = address.trim();
  if (clean.startsWith("::ffff:")) clean = clean.slice(7);
  if (clean === "::1" || clean === "127.0.0.1") return "localhost";
  return clean || "unknown peer";
}

export function formatUserAgent(ua: string | undefined): string {
  if (!ua || !ua.trim()) return "unknown client";
  const str = ua.trim();
  if (/undici/i.test(str)) return "Node.js (MCP Client)";
  if (/node-fetch/i.test(str)) return "Node.js Client";
  if (/axios/i.test(str)) return "Axios Client";
  if (/python-requests/i.test(str)) return "Python Client";
  if (/@modelcontextprotocol\/inspector/i.test(str)) return "MCP Inspector";
  if (/@modelcontextprotocol/i.test(str)) return "MCP SDK";
  if (/cursor/i.test(str)) return "Cursor";
  if (/claude-desktop|claude/i.test(str)) return "Claude Desktop";
  if (/antigravity/i.test(str)) return "Antigravity";
  if (/notion/i.test(str)) return "Notion AI";
  if (/curl\//i.test(str)) return "cURL";
  if (/Go-http-client/i.test(str)) return "Go Client";
  if (/edg\//i.test(str)) return "Edge (Web)";
  if (/chrome\//i.test(str) && /safari\//i.test(str)) return "Chrome (Web)";
  if (/firefox\//i.test(str)) return "Firefox (Web)";
  if (/safari\//i.test(str) && !/chrome\//i.test(str)) return "Safari (Web)";
  if (/mozilla/i.test(str)) return "Web Client";
  return safeLabel(str, "unknown client");
}

export function formatClientName(name: string): string {
  const trimmed = safeLabel(name, "unknown client");
  const lower = trimmed.toLowerCase();
  if (lower === "cursor") return "Cursor";
  if (lower === "claude-desktop" || lower === "claude") return "Claude Desktop";
  if (lower === "visual studio code" || lower === "vscode") return "VS Code";
  if (lower === "notion-agent" || lower === "notion") return "Notion AI";
  if (lower === "antigravity") return "Antigravity";
  return trimmed;
}

function resolveClientIdentity(req: Request, body: Record<string, any>, peer: string): ClientIdentity {
  const rawSessionId = req.query?.sessionId;
  const sessionId = typeof rawSessionId === "string" ? rawSessionId.trim() : (typeof req.headers["mcp-session-id"] === "string" ? (req.headers["mcp-session-id"] as string).trim() : undefined);

  const clientInfo = body.params?.clientInfo;
  if (clientInfo && typeof clientInfo.name === "string" && clientInfo.name.trim()) {
    const identity: ClientIdentity = {
      displayName: formatClientName(clientInfo.name),
      version: typeof clientInfo.version === "string" && clientInfo.version.trim() ? clientInfo.version.trim() : undefined,
    };
    if (sessionId) sessionClients.set(sessionId, identity);
    if (req.socket) socketClients.set(req.socket, identity);
    peerClients.set(peer, { identity, timestamp: Date.now() });
    return identity;
  }

  if (sessionId && sessionClients.has(sessionId)) {
    return sessionClients.get(sessionId)!;
  }

  if (req.socket && socketClients.has(req.socket)) {
    return socketClients.get(req.socket)!;
  }

  if (peerClients.has(peer)) {
    const cached = peerClients.get(peer)!;
    if (Date.now() - cached.timestamp < 10 * 60 * 1000) {
      return cached.identity;
    }
    peerClients.delete(peer);
  }

  const ua = req.get("user-agent");
  return { displayName: formatUserAgent(ua) };
}

export function monitorRequest(req: Request, res: Response, next: NextFunction): void {
  if (!process.send) { next(); return; }
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const method = safeLabel(body.method, `${req.method} ${req.path}`);
  const operation = method === "tools/call" ? safeLabel(body.params?.name, method) : method;
  // Address is the direct socket peer, not the easily spoofed X-Forwarded-For.
  // Behind a tunnel this may identify the tunnel rather than the original user.
  const peer = formatPeer(req.socket.remoteAddress);
  const identity = resolveClientIdentity(req, body, peer);
  const versionStr = identity.version ? ` v${identity.version}` : "";
  const client = `${identity.displayName}${versionStr} · ${peer}`;
  const id = ++nextId;
  if (enabled) {
    const previous = recent.get(client);
    recent.delete(client);
    recent.set(client, {
      client,
      displayName: identity.displayName,
      version: identity.version,
      peer,
      operation,
      lastSeen: new Date().toISOString(),
      requests: (previous?.requests || 0) + 1,
    });
    while (recent.size > 50) recent.delete(recent.keys().next().value!);
    totalRequests++;
    active.set(id, { client, operation, kind: req.path === "/sse" ? "sse" : "http" });
    addBytes(operation, "received", requestSizes.get(req) || 0);
  }

  const write = res.write.bind(res);
  const end = res.end.bind(res);
  res.write = ((chunk: unknown, ...args: unknown[]) => {
    addBytes(operation, "sent", sizeOf(chunk, args[0]));
    return (write as (...args: any[]) => boolean)(chunk, ...args);
  }) as typeof res.write;
  res.end = ((...args: unknown[]) => {
    addBytes(operation, "sent", sizeOf(args[0], args[1]));
    return (end as (...args: any[]) => Response)(...args);
  }) as typeof res.end;
  res.once("close", () => active.delete(id));
  next();
}

export function setMonitoringEnabled(value: boolean): void {
  enabled = value;
  received = sent = totalReceived = totalSent = totalRequests = 0;
  operations.clear();
  active.clear();
  recent.clear();
  sessionClients.clear();
  peerClients.clear();
}

const timer = setInterval(() => {
  if (!enabled || !process.connected || !process.send) return;
  const snapshot = {
    received, sent, totalReceived, totalSent, totalRequests,
    activeRequests: getOpenSseCount() + [...active.values()].filter(item => item.kind === "http").length,
    activeSse: getOpenSseCount(),
    activeHttp: [...active.values()].filter(item => item.kind === "http").length,
    recentClients: [...recent.values()].reverse(),
    operations: [...operations.entries()].map(([operation, bytes]) => ({ operation, ...bytes })),
    sampledAt: Date.now(),
  };
  received = sent = 0;
  operations.clear();
  try { process.send({ type: "monitor:snapshot", snapshot }, () => {}); } catch { /* parent disconnected */ }
}, 1000);
timer.unref();
