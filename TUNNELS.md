# Tunnel providers and motion preferences

## Desktop settings

Open **Settings**. The groups are Appearance, Public connection, Server, and Security & sandbox.
- **Interface animations** controls transitions, button feedback and decorative traffic particles.
- **Background animations** independently controls the slow aurora. Disabling it removes its CSS animation; it does not keep an invisible animation running.
- Appearance is saved automatically on this device. The existing `mcp-terminal-animation` preference is retained; its disabled value disables both categories when migrating. The new background preference is `mcp-terminal-background-animation`.
- System **Reduced Motion** overrides decorative movement, including when changed while the app is open. Monitoring and functional loading indicators remain available.
- The dialog uses Radix/shadcn primitives: focus stays in the dialog, Escape closes it, and selects/switches support the keyboard. Light/dark settings follow the system scheme.

## Choose a connection

| Provider | Requirement | Important limits |
| --- | --- | --- |
| No tunnel | None | Local MCP URL; no public tunnel process. |
| ngrok | Built-in SDK, ngrok account/token | Domain availability, traffic and fixed domains depend on the provider plan. |
| Tuna | Install Tuna CLI; `tuna login` or API key with `tunnels:connect` | Assigned free permanent subdomain is account-bound. Arbitrary names/custom domains may require a subscription. |
| Cloudflare — named | Install cloudflared; connector token and an already routed HTTPS hostname | Route the hostname in Cloudflare to this local host/port. Do not put an interactive Access login in front of MCP unless supported by the client. |
| Cloudflare — quick | Install cloudflared | **Testing only.** The hostname changes on restart and [Quick Tunnels do not support SSE](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/). Try `/mcp` for non-streaming requests, not `/sse`. Remains **Unverified**. |
| LocalTunnel | Explicitly install `npm install -g localtunnel` | Experimental. A password/interstitial page can block MCP clients. Requested subdomains are not guaranteed. Always marked **Unverified**. |

Save, then explicitly **Restart** (or Start if stopped). Saving never restarts a running server. The active connection and Bearer key stay unchanged until restart. Provider-specific settings are retained when switching. Only one tunnel runs at a time.

The endpoint card and tray show the active provider/state and let you copy the MCP URL. **Connected** means an address was assigned or a named Cloudflare connector connected, not that an external MCP session was verified. **Unverified** additionally means known provider restrictions. Disconnection or failure clears the public URL.

## Configuration

See `.env.example`. Set `TUNNEL_PROVIDER=none|ngrok|tuna|cloudflare|localtunnel`. If absent/empty, old `NGROK_ENABLED` behavior and `NGROK_*` values (including `NGROK_TOKEN`) are retained. An explicit provider takes priority.

- ngrok: `NGROK_AUTHTOKEN`, `NGROK_DOMAIN`.
- Tuna: `TUNA_API_KEY`, `TUNA_SUBDOMAIN`, optional `TUNA_EXECUTABLE`.
- Cloudflare: optional `CLOUDFLARED_EXECUTABLE`; `CLOUDFLARE_MODE=quick|named`. Named mode also needs `CLOUDFLARE_TUNNEL_TOKEN` and `CLOUDFLARE_PUBLIC_URL=https://mcp.example.com` (origin only, no `/mcp`).
- LocalTunnel: optional `LOCALTUNNEL_EXECUTABLE`, `LOCALTUNNEL_SUBDOMAIN`.

Executable settings are paths, never shell command lines. On Windows, the installed global npm `lt.cmd` resolves to its fixed LocalTunnel JS entry, run without a shell. Restart the desktop app after changing PATH. No automatic CLI downloads, `npx` installs, logins, DNS changes or provider-account tunnel creation.

## Security

MCP still uses **Authorization: Bearer <MCP_API_KEY>** (or the existing x-api-key mechanism). Provider credentials are separate. Keep sandbox restrictions and explicit allowed hosts. Only the exact active tunnel hostname is temporarily allowed, then removed on disconnect/stop. Never use `ALLOWED_HOSTS=*`.

Keys entered in Settings are stored in the local configuration file, not an OS credential vault. Protect that file with your Windows account permissions. Keys are masked in the UI; tunnel subprocess arguments/logs intentionally omit them. CLI subprocesses are not given the MCP key or other providers’ credentials. Tuna’s inspector is disabled.

The CLI process tree is stopped on server stop/restart/exit. Startup times out after 40 seconds and terminates that process rather than leaving an invisible tunnel running.

## Official references

- [ngrok SDK/docs](https://ngrok.com/docs/)
- [Tuna HTTP, API keys and domain limits](https://tuna.am/docs/tunnels/http/)
- [Tuna noninteractive output / TUNA_TUI=0](https://tuna.am/blog/cli-v0-36-tui/)
- [Install cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)
- [Quick Tunnel limitations](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [Cloudflare run parameters / TUNNEL_TOKEN](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/cloudflared-parameters/run-parameters/)
- [LocalTunnel official CLI README](https://github.com/localtunnel/localtunnel)

Building does not certify external tunnels. Verify with your own MCP client and installed CLI/account. Browser-gated services can be unsuitable even when a public URL is printed.
