# MCP Terminal

[![MCP](https://img.shields.io/badge/MCP-Streamable_HTTP-7c3aed)](https://modelcontextprotocol.io/)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An authenticated, production-ready remote **Model Context Protocol (MCP)** server providing **Terminal Execution** and **Filesystem Tools** to **Notion Custom Agents**, Claude, Cursor, and autonomous AI agents over **Streamable HTTP** and **MCP SSE**.

Includes built-in zero-config public tunneling via the official **Ngrok Node.js SDK** (`@ngrok/ngrok`).

[🇬🇧 English User Guide (USER_GUIDE.md)](USER_GUIDE.md) | [🇷🇺 Руководство на русском (USER_GUIDE_RU.md)](USER_GUIDE_RU.md) | [🇷🇺 Русский README (README_RU.md)](README_RU.md) | [🤖 Agent Spec (AGENTS.md)](AGENTS.md)

---

## Features

- 🖥️ **Liquid Glass Desktop GUI App**: Modern Electron + React desktop interface with system tray integration (hide from taskbar, background execution), live status cards, real-time audit log stream, one-click Notion credentials copy, and visual settings editor.
- ⚡ **Dual MCP Transports**: Fully supports modern **Streamable HTTP** (`/mcp`) and standard **Server-Sent Events** (`/sse` + `/messages`) for maximum compatibility with Notion, Claude, Cursor, and custom clients.

- 🌐 **Built-in Ngrok Tunnel**: Expose your local MCP server to Notion with a single command (`npm run start` or `npm run dev`) using `@ngrok/ngrok`.
- 💻 **Terminal Execution**: Execute PowerShell or cmd commands with configurable timeouts, working directories, and recursive process tree termination.
- 🌍 **Browser Automation**: Launch host browsers (Chrome/Edge), navigate, execute arbitrary JavaScript, click elements, fill inputs, extract DOM text/HTML, and capture screenshots.
- 📁 **Filesystem Operations**: Full set of tools for reading, writing, moving, listing, statting, and deleting files and directories.
- 🔒 **Security & Sandboxing**:
  - **Sandboxed Mode (`FULL_ACCESS=false`)**: Strict path containment inside a configured `FILES_ROOT` with path traversal defense.
  - **Full Host Mode (`FULL_ACCESS=true`)**: Unrestricted access when you need full host automation.
  - **Timing-Safe Auth**: Constant-time comparison (`crypto.timingSafeEqual`) for Bearer tokens and API keys.
  - **Host Header Validation**: Prevents DNS rebinding and unauthorized host header spoofing.
- 🤖 **Agent-First Design**: Detailed specifications and JSON schemas optimized for AI models ([AGENTS.md](AGENTS.md)).

---

## Quick Start

### 1. Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/Glebsky/terminal-mcp.git
cd terminal-mcp
npm install
```

### 2. Environment Setup

Copy `.env.example` to `.env` or run the setup script:

```powershell
# Automated setup (generates a secure 32+ character API key)
.\setup.ps1
```

Or manually:

```powershell
Copy-Item .env.example .env
# Generate a secure token:
npm run token
```

Edit your `.env` file:

```ini
# Required: Secure API Key for Notion
MCP_API_KEY=your_generated_32_char_api_key

PORT=3000
HOST=127.0.0.1

# Ngrok Public Tunnel (Optional but recommended for Notion)
NGROK_ENABLED=true
NGROK_AUTHTOKEN=your_ngrok_authtoken_here
NGROK_DOMAIN=your-static-name.ngrok-free.app

# Security & Sandboxing
FULL_ACCESS=false
FILES_ROOT=./workspace
ALLOWED_HOSTS=localhost:3000;127.0.0.1:3000;*.ngrok-free.app;*.ngrok.app;*.ngrok-free.dev;*.trycloudflare.com
```

### 3. Build & Run

#### Option A: Quick Windows Batch Scripts
- Double-click **`build.bat`** to open an interactive Windows build menu (Portable .exe, Setup installer, both, unpacked dir, or clean).
- Double-click **`build-portable.bat`** to compile and generate `release\MCP Terminal Portable.exe` in one click.

#### Option B: Terminal (Node.js & npm)
```bash
# Build TypeScript
npm run build

# Start production server
npm run start
```

For development with hot reload:

```bash
npm run dev
```

When started with `NGROK_ENABLED=true`, the server will output connection details ready to paste into Notion:

```text
============================================================
             NOTION MCP AGENT CONNECTION READY             
============================================================
URL to paste into Notion:  https://your-domain.ngrok-free.app/mcp

Authentication Header:
  Header Name:   Authorization
  Header Value:  Bearer <your_token>
============================================================
```

#### Alternative: Free Cloudflare Quick Tunnel (No Account Required)

**Testing only:** the address changes on restart. Use `/mcp` for non-streaming requests; `/sse` is not supported. Choose a named tunnel for a stable address. [Cloudflare limitations](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

If you don't have an Ngrok account, run:

```powershell
.\start-public.ps1
```

This PowerShell script automatically:
1. Downloads and validates the official Authenticode-signed `cloudflared` binary into `tools/`.
2. Compiles TypeScript (`npm run build`).
3. Starts the MCP server on `http://127.0.0.1:3000`.
4. Spawns an ephemeral Cloudflare tunnel (`https://<random-subdomain>.trycloudflare.com`).
5. Prints the ready-to-copy Notion endpoint (`https://<random>.trycloudflare.com/mcp`) and `Authorization` header.

---

## Connecting to Notion Custom Agents

1. In Notion, open **Settings & members** → **Connections** (or open your **Notion Custom Agent** settings).
2. Add a new **Custom MCP Connection**.
3. Set **Server URL** to:
   ```text
   https://your-tunnel-url/mcp
   ```
   *(e.g., `https://your-domain.ngrok-free.app/mcp` or `https://xyz.trycloudflare.com/mcp`)*
4. Set **Authentication**:
   - Header Name: `Authorization`
   - Header Value: `Bearer <YOUR_MCP_API_KEY>` (or use `x-api-key: <YOUR_MCP_API_KEY>`)
5. Test the connection. Notion will automatically discover all **24 tools** across terminal execution, filesystem operations, workspace navigation, and host browser automation.

---

## Authentication methods

`AUTH_METHODS` (semicolon-separated, default `bearer`) chooses how clients sign in; any enabled method is accepted. The desktop app has the same switches under **Settings → Security**.

| Method | Client sends | Notes |
|---|---|---|
| `bearer` | `Authorization: Bearer <MCP_API_KEY>` or `x-api-key: <MCP_API_KEY>` | Default and recommended. |
| `query` | `…/mcp?key=<MCP_API_KEY>` (also `api_key`, `token`; `/sse?key=…` works too) | For clients that only take a URL. The key can appear in tunnel/proxy logs. |
| `basic` | HTTP Basic with `BASIC_AUTH_USER` / `BASIC_AUTH_PASSWORD` (12+ chars) | For clients with login/password fields. |
| `none` | nothing | **Anyone who reaches the server or its tunnel controls this PC.** Requires `ALLOW_NO_AUTH=I_UNDERSTAND_ANYONE_CAN_CONTROL_THIS_PC`; consider `DISABLED_TOOLS` and `FULL_ACCESS=false`. |

`MCP_API_KEY` is required only while `bearer` or `query` is enabled. Changes apply after a restart.

## Available MCP Tools (24 Tools)

`tools/list` includes hints about reading, destructive changes, repeated calls and external state. Hints are advisory, not permissions or consent. [Exact schemas and flags](contracts/tools.json).

See [AGENTS.md](AGENTS.md) for full JSON schemas, input parameters, response formats, and agent best practices.

### 🖥️ Terminal Execution
| Tool | Description |
|---|---|
| `terminal_execute` | Execute PowerShell or cmd.exe commands on the host with native UTF-8 encoding, configurable timeouts, custom `cwd`, and process tree termination. |

### 📁 Filesystem Operations
| Tool | Description |
|---|---|
| `file_search` | Search files by glob pattern (`*.ts`) and/or search text/regex within file contents (grep). |
| `file_replace` | Safely replace an exact block of code or text in a file without rewriting the entire file. |
| `file_read` | Read file contents (UTF-8 text or Base64 binary) with offset pagination for large files. |
| `file_write` | Create, overwrite, or append content to files (automatically creates missing parent directories). |
| `file_list` | List directory contents recursively or flat with file sizes and directory metadata. |
| `file_stat` | Inspect file/directory metadata (size, created/modified timestamps, permissions). |
| `file_mkdir` | Create directories and any missing parent directories recursively. |
| `file_move` | Move or rename files and directories, with optional destination overwrite. |
| `file_delete` | Permanently delete files or directories (`recursive: true` required for non-empty directories). |

### 🗂️ Workspace Management
| Tool | Description |
|---|---|
| `workspace_get_cwd` | Inspect the current active working directory and base `files_root` path. |
| `workspace_set_cwd` | Switch the active working directory for subsequent commands and relative path resolution (e.g. switch to a project subdirectory). |

### 🌐 Host Browser Automation
| Tool | Description |
|---|---|
| `browser_open` | Launch host browser (Google Chrome or Microsoft Edge) and navigate to a URL. Opens visible window by default (`headless: false`) for visual live testing. |
| `browser_navigate` | Navigate the active browser tab to a new URL with custom wait conditions (`load`, `domcontentloaded`, `networkidle0`). |
| `browser_evaluate` | Execute arbitrary JavaScript expressions or async functions inside the page context and return the JSON result. |
| `browser_click` | Click an element on the webpage matching a CSS selector. |
| `browser_type` | Type text into an input or textarea element on the active page, with optional field clearing. |
| `browser_get_content` | Extract rendered text, raw DOM HTML, or page title from the document or a specific CSS selector. |
| `browser_screenshot` | Capture full-page or viewport screenshots to a PNG file or return base64. |
| `browser_connect` | Connect to a browser profile explicitly chosen by the owner. |
| `browser_list_tabs` | List tabs in this browser session and identify the active tab. |
| `browser_new_tab` | Open a new tab, optionally navigate, and select it. |
| `browser_select_tab` | Select a tab by index, URL or title; optionally bring it to the front. |
| `browser_close` | Close a browser the server launched, or detach from an existing profile without closing its tabs. |

---

## Configuration Reference (`.env`)

| Variable | Default | Description |
|---|---|---|
| `MCP_API_KEY` | *required for bearer/query* | Secret key for authentication (min 32 characters). |
| `PORT` | `3000` | Port for the HTTP server. |
| `HOST` | `127.0.0.1` | Host address to bind to. |
| `NGROK_ENABLED` | `false` | Enable/disable automatic ngrok tunnel creation on start. |
| `NGROK_AUTHTOKEN` | `""` | Ngrok authtoken (optional if configured globally via ngrok CLI). |
| `NGROK_DOMAIN` | `""` | Static/custom ngrok domain (e.g. `xyz.ngrok-free.app`). |
| `ALLOWED_HOSTS` | `localhost:3000;...` | Semicolon-separated list of allowed `Host` headers. |
| `FULL_ACCESS` | `false` | When `false`, restricts file operations and terminal `cwd` to `FILES_ROOT`. |
| `FILES_ROOT` | `./workspace` | Base directory for the sandbox when `FULL_ACCESS=false`. |
| `COMMAND_TIMEOUT_MS` | `120000` | Default timeout for terminal commands (2 minutes). |
| `MAX_OUTPUT_BYTES` | `1048576` | Max stdout/stderr capture size (1 MB). |
| `MAX_FILE_BYTES` | `10485760` | Max file size read/write limit per request (10 MB). |
| `AUTH_METHODS` | `bearer` | Enabled authentication methods. Prefer header authentication. |
| `BASIC_AUTH_USER`, `BASIC_AUTH_PASSWORD` | unset | Required only when Basic authentication is enabled. |
| `ALLOW_NO_AUTH` | unset | Existing local acknowledgement for unauthenticated mode; keep unset. |
| `TUNNEL_PROVIDER` | `none`¹ | Choose none, ngrok, tuna, cloudflare or localtunnel. |
| `TUNA_EXECUTABLE`, `TUNA_SUBDOMAIN`, `TUNA_API_KEY` | `tuna` / unset | CLI path, optional subdomain and optional provider credential. |
| `CLOUDFLARED_EXECUTABLE`, `CLOUDFLARE_MODE` | `cloudflared` / `quick` | Connector path and mode (quick or named). |
| `CLOUDFLARE_TUNNEL_TOKEN`, `CLOUDFLARE_PUBLIC_URL` | unset | Named tunnel credential and routed HTTPS origin. |
| `LOCALTUNNEL_EXECUTABLE`, `LOCALTUNNEL_SUBDOMAIN` | `lt` / unset | CLI path and optional requested subdomain. |
| `DISABLED_TOOLS` | unset | Names omitted from tools/list and unavailable for calls. |
| `AUDIT_LOG_FILE` | unset | Optional private JSONL log; tool access to its contents is denied. |
| `MAX_SSE_SESSIONS` | `32` | Maximum simultaneous legacy SSE sessions. |
| `DOTENV_PATH` | unset | Optional configuration file; its whole parent directory is reserved for the server. Use a separate private directory. |
| `PROTECTED_PATHS` | unset | Additional private files/directories, separated by semicolons. Prefer absolute paths. |

The server-owned paths remain private to MCP file tools even with `FULL_ACCESS=true`. The desktop owner can still edit the configuration directly. An `ALLOW_SELF_ACCESS` switch is not available in this revision.

¹ Without an explicit provider, legacy `NGROK_ENABLED` still applies. See [Tunnels](TUNNELS.md) and [Security](SECURITY.md).

---

## Project Structure

```
notion-terminal-mcp/
├── desktop/                   # Electron + React Liquid Glass Desktop GUI
│   ├── index.html             # Desktop app HTML entrypoint
│   └── src/
│       ├── main/              # Electron main process (lifecycle, system tray, IPC)
│       │   ├── index.ts       # BrowserWindow & tray menu initialization
│       │   ├── preload.ts     # Context bridge IPC definitions
│       │   └── server-manager.ts # Background MCP server runner & log parser
│       └── renderer/          # React + Tailwind CSS UI components
│           ├── App.tsx        # Liquid Glass UI state & layout
│           ├── components/    # Notion card, controls, log viewer, settings modal
│           └── styles/        # Liquid glass visual styles & animations
├── src/                       # Headless MCP Server (Node.js / Express)
│   ├── config.ts              # Type-safe environment, defaults & validation
│   ├── index.ts               # Server CLI entry point & lifecycle
│   ├── server.ts              # Express HTTP server (Streamable HTTP + MCP SSE endpoints)
│   ├── middleware/
│   │   ├── auth.ts            # Timing-safe token & API key authentication
│   │   └── host.ts            # Host header validation & DNS rebinding guard
│   ├── tools/                 # 24 MCP Tools
│   │   ├── browser.ts         # Puppeteer-core browser automation manager
│   │   ├── command.ts         # Process tree management & execution
│   │   ├── filesystem.ts      # Sandboxed filesystem CRUD operations
│   │   ├── index.ts           # MCP tool registrations
│   │   └── types.ts           # MCP result helpers & interfaces
│   └── tunnel/
│       └── ngrok.ts           # Ngrok SDK manager & Notion connection banner
├── AGENTS.md                  # Detailed AI Agent Specification & JSON schemas
├── USER_GUIDE_RU.md           # Comprehensive Russian documentation & guide
├── build.bat                  # Interactive Windows build menu launcher
├── build-portable.bat         # 1-click portable .exe builder
├── build.ps1                  # Automated PowerShell build script (portable/installer/all/dir/clean)
├── electron-builder.yml       # Windows packaging configuration (Portable + NSIS)
├── package.json
├── setup.ps1                  # PowerShell initial environment setup script
├── start-public.ps1           # Zero-config Cloudflare Quick Tunnel launcher
└── tsconfig*.json
```

---

## Connection Monitor

The **Monitor** tab shows recent clients, open SSE streams, active HTTP requests, request totals and inbound / outbound payload rates (authenticated MCP message bodies only, HTTP headers excluded).

**Data flow band** ([SPEC-003](docs/specs/SPEC-003-data-flow-band.md)): one blue to violet band whose thickness follows the payload volume of the last second on a log scale, from a thin thread for a few bytes to full width at about 4 MiB/s. Inbound swells travel left to right, outbound right to left, with light packets riding on top. Changes are eased; when traffic stops the band fades out smoothly and the "Waiting for traffic" caption fades in. With **Interface animations** off (or system Reduced Motion) the band is drawn statically.

Monitor test: `npm run test:monitor`. Visual bench for the band: `npx vite --port 5174`, then open `http://localhost:5174/preview/flow.html#heavy`.

## Windows Batch & PowerShell Build Scripts

For fast execution without remembering npm commands:

- **`build.bat`** — Interactive command prompt menu:
  - `[1]` Build Portable version (`release\MCP Terminal Portable.exe`)
  - `[2]` Build Setup wizard installer (`release\MCP Terminal Setup 2.0.0.exe`)
  - `[3]` Build Both (Portable + Setup)
  - `[4]` Unpack to `release\win-unpacked`
  - `[5]` Clean `release/` directory
  - Supports CLI arguments: `build.bat portable`, `build.bat installer`, `build.bat all`, `build.bat dir`, `build.bat clean`.
- **`build-portable.bat`** — Direct double-click shortcut to build the Portable `.exe` in one step.
- **`build.ps1`** — Underlying automated PowerShell build engine with error handling and colored logging.

---

## NPM Scripts

- `npm run app:start` — Build and launch the **Desktop GUI App** (Electron + Liquid Glass UI) for local testing without packaging.
- `npm run app:dev` — Launch the Desktop App in live development mode with hot-reload (Vite + Electron).
- `npm run package:portable` — Build standalone **Portable `.exe`**. Output: `release/MCP Terminal Portable.exe`.
- `npm run package:installer` — Build Windows **Setup/Installer `.exe`** (NSIS wizard). Output: `release/MCP Terminal Setup 2.0.0.exe`.
- `npm run package:exe` — Build **both** Portable and Installer executable packages at once.
- `npm run build` — Compile TypeScript server, Electron main/preload, and Vite React renderer.
- `npm run start` — Run headless MCP server from `dist/index.js` (CLI mode).
- `npm run dev` — Run headless MCP server with `tsx watch` (CLI dev mode).
- `npm run check` — Type-check all TypeScript configurations (server, desktop, electron).
- `npm run token` — Generate a cryptographically secure random 32-byte hex token for `MCP_API_KEY`.

---

## Packaging Executables (.exe)

When you need standalone Windows binaries (`.exe`), run `build.bat`, `build-portable.bat`, or use npm:

| Command | Method | Target | Output in `release/` |
|---|---|---|---|
| `build-portable.bat` / `npm run package:portable` | Batch / npm | Portable single executable | `MCP Terminal Portable.exe` |
| `npm run package:installer` | Batch / npm | NSIS Setup Wizard (Start Menu & Desktop shortcuts) | `MCP Terminal Setup 2.0.0.exe` |
| `build.bat all` / `npm run package:exe` | Batch / npm | Both targets (Portable + Installer) | Both files above |

> [!TIP]
> **True Portable Mode**: When running `MCP Terminal Portable.exe`, configuration (`.env`) and the `workspace/` folder are stored in `MCP Terminal Data/` next to the executable. If the portable folder is moved, check the configured absolute workspace path. When installed via Setup wizard, configuration resides in `%APPDATA%\mcp-terminal\config\.env`.

> [!NOTE]
> `npm run app:start` only compiles TypeScript and runs Electron live in development/test mode. It does **not** create `.exe` files in `release/`. To generate `.exe` binaries, always use `build.bat`, `build-portable.bat`, or `npm run package:*`.


---

## Security Policy

Please review [SECURITY.md](SECURITY.md) for security considerations and vulnerability reporting guidelines.
