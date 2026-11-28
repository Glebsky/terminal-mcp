# Desktop ↔ server control protocol (SPEC-009)

This is a private, local parent/child pipe, **not** MCP's stdio transport and not an HTTP endpoint. The MCP client is unchanged. The launcher supplies `MCP_CONTROL=stdio` and owns the child's stdin, stdout and stderr. Node IPC is not required. Existing parents that fork a Node server with IPC still receive the same event objects; with both channels attached the same event is sent to both. The desktop uses only stdio, so it never counts an event twice.

## Framing

UTF-8, one compact JSON object per line; LF or CRLF. The parent sends **bare JSON lines** on stdin. The child prefixes event lines on stdout with the six literal characters `[CTL] ` (including the space). Other stdout lines remain logs; `[AUDIT]` lines keep their existing format. Stderr is diagnostic text only. Pipe chunks, UTF-8 characters and lines need not have the same boundaries. Flush ready/error events before returning/exiting. Never send credentials, auth headers, file contents or command bodies in an event. The TS producer also redacts known credential values before either delivery.

The receiver ignores unknown event types and non-JSON control lines rather than displaying their payload as a log. Keep snapshots bounded; desktop accepts a framed line up to 2 Mi UTF-16 code units including the prefix, ignoring over-limit frames. This limit applies to a *single record*, not a pipe read. Ordinary logs still use the previous line buffer. Only a structured ready event changes the desktop to running; a log that says “listening” is not a readiness signal.

## Commands: desktop → server

| Object | Meaning |
| --- | --- |
| `{"type":"monitor:set","enabled":true}` (or `false`) | Set sampling to the given boolean. The current implementation resets the interval and totals on changes, as before. The desktop sends its current setting on launch. |
| `{"type":"shutdown"}` | Graceful stop; repeated requests are harmless. In stdio mode EOF on stdin also means the owner is gone. Normal shutdown exits 0. |

## Events: server → desktop

| `type` | Additional fields and observable effect |
| --- | --- |
| `server:ready` | No fields required. The local HTTP listener has bound. This does **not** prove tunnel/client connectivity. |
| `server:error` | `code: string`, `port: number`, `message: string`. Startup failures exit 1. For `EADDRINUSE`, keep the port-specific error visible after process exit. |
| `tunnel:status` | `provider: none/ngrok/tuna/cloudflare/localtunnel`; `state: disabled/starting/connected/unverified/error`. Optional `url` and `error`. Missing values clear any previous values. `url` is an origin, not a credential or a URL for a tool to invoke. |
| `monitor:snapshot` | `snapshot` object as below. Only when monitoring is enabled and a control channel is attached. Not displayed as a log line. |

A monitor snapshot has numeric `received`, `sent` (bytes this interval), `totalReceived`, `totalSent`, `totalRequests`, `activeRequests`, `activeSse`, `activeHttp`, `sampledAt` (Unix epoch ms); `recentClients` and `operations` are arrays. A recent client contains `client`, `displayName`, optional `version`, `peer`, `operation`, `lastSeen` (ISO timestamp), and `requests` (number). An operation contains `operation`, `received`, `sent`. The counter semantics and cadence are unchanged. Extra fields do not require a renderer update. A disconnected child is never sent commands through a closed input pipe.

## Checks

`npm run test:conformance` verifies ready/error, redacted snapshots, tunnel disabled, shutdown and EOF using a real isolated server. `npm run test:desktop-control` runs the real desktop manager against a child that **has no IPC channel**, including fragmented frames, a large snapshot, ordinary logs, and a busy-port error. `npm run test:monitor` exercises the legacy IPC path. See the [test modes and prerequisites](../tests/conformance/README.md).
