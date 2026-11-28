// SPEC-009 FR-4: neutral control protocol over stdio ([CTL] JSON lines out, JSON lines in).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as net from "node:net";
import { startServer, ctlEvents, freePort, sleep } from "./_server.mjs";

const send = (srv, message) => srv.proc.stdin.write(JSON.stringify(message) + "\n");

async function initialize(srv) {
  const res = await fetch(srv.mcpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${srv.key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "conf-client", version: "1" } } }),
  });
  await res.text();
  return res.status;
}

test("stdio control: ready event, monitor snapshots without secrets, shutdown exits 0", async () => {
  const srv = await startServer({ env: { MCP_CONTROL: "stdio" } });
  try {
    await srv.stdout.waitFor((l) => l.startsWith("[CTL] ") && l.includes('"server:ready"'));

    send(srv, { type: "monitor:set", enabled: true });
    await sleep(150);
    assert.equal(await initialize(srv), 200);
    const line = await srv.stdout.waitFor((l) => l.startsWith("[CTL] ") && l.includes('"monitor:snapshot"') && /"totalRequests":[1-9]/.test(l), 5000);
    const snapshot = JSON.parse(line.slice(6)).snapshot;
    assert.ok(snapshot.recentClients.some((c) => String(c.client).includes("conf-client") || String(c.displayName ?? "").toLowerCase().includes("conf-client")));
    assert.ok(!srv.stdout.lines.join("\n").includes(srv.key), "key must never appear on stdout");

    send(srv, { type: "shutdown" });
    const { code } = await Promise.race([srv.exited, sleep(6000).then(() => ({ code: "timeout" }))]);
    assert.equal(code, 0);
  } finally {
    await srv.stop();
  }
});

test("stdio control: busy port reports server:error and exits 1", async () => {
  const port = await freePort();
  const blocker = net.createServer().listen(port, "127.0.0.1");
  await new Promise((r) => blocker.once("listening", r));
  const srv = await startServer({ port, waitReady: false, env: { MCP_CONTROL: "stdio" } });
  try {
    const { code } = await Promise.race([srv.exited, sleep(8000).then(() => ({ code: "timeout" }))]);
    assert.equal(code, 1);
    const error = ctlEvents(srv.stdout.lines).find((e) => e.type === "server:error");
    assert.ok(error, "server:error event expected");
    assert.equal(error.code, "EADDRINUSE");
    assert.equal(error.port, port);
  } finally {
    blocker.close();
    await srv.stop();
  }
});
