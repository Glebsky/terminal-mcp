// Control channel between the desktop shell and this server (SPEC-009 FR-4).
// Events go to Node IPC when the parent forked us with an IPC channel and, with MCP_CONTROL=stdio,
// to stdout as "[CTL] <json>" lines. Commands arrive over Node IPC or, with MCP_CONTROL=stdio,
// as JSON lines on stdin. The stdio form is language-neutral, so a non-Node server can speak it too.
import { createInterface } from "node:readline";

export interface ControlMessage {
  type: string;
  [key: string]: unknown;
}

const stdioMode = (process.env.MCP_CONTROL || "").trim().toLowerCase() === "stdio";

/** True when a parent listens for control events (IPC or stdio protocol). */
export function isAttached(): boolean {
  return stdioMode || Boolean(process.connected && process.send);
}

/** Send an event to the parent; `done` runs once every channel has flushed it. Never include secrets. */
export function emit(event: ControlMessage, done?: () => void): void {
  let pending = 0;
  let finished = false;
  const finish = () => {
    pending -= 1;
    if (pending <= 0 && !finished) { finished = true; done?.(); }
  };
  if (process.connected && process.send) {
    pending += 1;
    try { process.send(event, () => finish()); } catch { finish(); }
  }
  if (stdioMode) {
    pending += 1;
    try { process.stdout.write(`[CTL] ${JSON.stringify(event)}\n`, () => finish()); } catch { finish(); }
  }
  if (pending === 0 && !finished) { finished = true; done?.(); }
}

/**
 * Subscribe to parent commands. With the stdio protocol, closing stdin means the parent is gone,
 * so it is delivered as a "shutdown" command (no orphaned server).
 */
export function onCommand(handler: (command: ControlMessage) => void): void {
  const dispatch = (message: unknown) => {
    if (message && typeof message === "object" && typeof (message as ControlMessage).type === "string") {
      handler(message as ControlMessage);
    }
  };
  process.on("message", dispatch);
  if (!stdioMode) return;
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    try { dispatch(JSON.parse(text)); } catch { /* malformed control line: ignored */ }
  });
  lines.on("close", () => dispatch({ type: "shutdown" }));
}
