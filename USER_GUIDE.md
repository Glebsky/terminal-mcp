# User Guide: MCP Terminal

Complete illustrated guide to installation, configuration, architecture, and usage of the MCP server and Desktop GUI application.

[🇷🇺 Читать на русском языке (USER_GUIDE_RU.md)](USER_GUIDE_RU.md) | [🇬🇧 Read in English (USER_GUIDE.md)](USER_GUIDE.md)

---

## Table of Contents

1. [Introduction and Capabilities](#1-introduction-and-capabilities)
2. [Launch and Build Methods](#2-launch-and-build-methods)
   - [Option A: Desktop Application (.exe)](#option-a-desktop-application-exe-recommended)
   - [Option B: Quick Windows Batch Scripts (.bat)](#option-b-quick-windows-batch-scripts-bat)
   - [Option C: Command Line (Node.js & npm)](#option-c-command-line-nodejs--npm)
   - [Option D: Free Cloudflare Tunnel (start-public.ps1)](#option-d-free-cloudflare-tunnel-start-publicps1-no-account-required)
3. [Desktop GUI Overview](#3-desktop-gui-overview)
4. [Connecting to Notion (Step-by-Step)](#4-connecting-to-notion-step-by-step)
5. [Architecture and Security](#5-architecture-and-security)
   - [Sandbox vs Full Host Access](#sandbox-vs-full-host-access)
   - [Transports: Streamable HTTP and MCP SSE](#transports-streamable-http-and-mcp-sse)
   - [Tunneling: Ngrok and Cloudflare](#tunneling-ngrok-and-cloudflare)
6. [MCP Tools Reference (20 Tools)](#6-mcp-tools-reference-20-tools)
7. [FAQ and Troubleshooting](#7-faq-and-troubleshooting)

---

## 1. Introduction and Capabilities

**MCP Terminal** is a bridge between artificial intelligence agents (Notion Custom Agents, Claude, Cursor, Antigravity) and your local operating system. The server conforms to the official **Model Context Protocol (MCP)** specification via **Streamable HTTP** and **Server-Sent Events (SSE)** transports.

### Key Capabilities:
- 🖥️ **Desktop GUI (Liquid Glass Dark)**: Sleek Electron + React desktop interface featuring real-time server controls, live audit logs, and one-click copy buttons for Notion endpoints.
- ⚡ **Terminal Execution**: Run PowerShell or CMD commands with native UTF-8 encoding (preserving non-Latin characters and symbols).
- 📁 **Filesystem Operations**: Read, write, safe targeted code replacement (`file_replace`), regex grep and glob search (`file_search`), directory creation, file moving, and recursive deletion.
- 🗂️ **Workspace Management**: Dynamic working directory switching (`workspace_set_cwd`), enabling agents to work across multiple projects within a repository using short relative paths.
- 🌐 **Built-in Ngrok SDK**: Instant public secure HTTPS tunnel for Notion without router port forwarding.
- ☁️ **Free Cloudflare Quick Tunnel**: Included `start-public.ps1` script to launch a public tunnel with zero accounts or registration.
- 🌍 **Browser Automation**: Launch host browsers (Google Chrome or Microsoft Edge), execute arbitrary JavaScript, click elements, fill forms, test local services (`http://localhost:...`), and capture full-page screenshots.
- 🛡️ **Security & Hardening**: Constant-time token verification (`crypto.timingSafeEqual`), Host header validation (DNS Rebinding protection), and configurable sandboxing (`FILES_ROOT`).

---

## 2. Launch and Build Methods

### Option A: Desktop Application (.exe) *(Recommended)*

Windows binaries are available in the `release/` folder:
- **`release/MCP Terminal Portable.exe`** — Standalone portable version. Requires no installation and launches immediately. Configuration (`.env`) and the `workspace/` folder are stored in `MCP Terminal Data/` beside the executable. If you move the folder, check the configured absolute workspace path.
- **`release/MCP Terminal Setup 2.0.0.exe`** — Standard Windows setup installer (creates Desktop and Start Menu shortcuts).

**How to run:**
1. Launch the `.exe` file.
2. Open **Settings (.env)** and configure:
   - `MCP_API_KEY` (or click the dice icon to generate a secure 64-char hex key).
   - `NGROK_ENABLED=true`, `NGROK_AUTHTOKEN`, and your `NGROK_DOMAIN` (if using a persistent free domain).
3. Click **Start Server**.

---

### Option B: Quick Windows Batch Scripts (.bat)

To build and compile binaries easily without typing long terminal commands:

- **`build.bat`** — Launches an interactive Windows build menu:
  ```text
  =======================================================
          MCP Terminal - Build Wizard
  =======================================================

   [1] Build Portable version (Portable.exe)
   [2] Build Setup wizard installer (Setup.exe)
   [3] Build Both (Portable + Setup)
   [4] Unpack to release\win-unpacked
   [5] Clean release\ directory

   [0] Exit
  =======================================================
  ```
  Also supports command-line arguments:
  ```cmd
  build.bat portable    rem Build only Portable.exe
  build.bat installer   rem Build Setup.exe installer
  build.bat all         rem Build both packages
  build.bat dir         rem Unpack into win-unpacked directory
  build.bat clean       rem Clean release directory
  ```

- **`build-portable.bat`** — One-click shortcut to build the Portable executable. Simply double-click the file, and `MCP Terminal Portable.exe` will be generated in `release/`.

---

### Option C: Command Line (Node.js & npm)

If you prefer running from the command line or are developing the project:

```powershell
# 1. Install dependencies
npm install

# 2. Setup environment
Copy-Item .env.example .env
npm run token # prints a secure 32-byte hex key for your .env

# 3. Build TypeScript and start CLI server
npm run build
npm run start

# 4. Launch Desktop GUI app (Electron)
npm run app:start

# 5. Build executable packages via npm
npm run package:portable   # Build Portable.exe
npm run package:installer  # Build Setup wizard installer
npm run package:exe        # Build both packages
```

---

### Option D: Free Cloudflare Tunnel (`start-public.ps1`) *(No Account Required)*

If you don't have an Ngrok account, run the zero-config Cloudflare Quick Tunnel script:

```powershell
.\start-public.ps1
```

**Automated steps performed by the script:**
1. If `.env` is missing, runs `setup.ps1` to generate a 32-byte secure API key.
2. Checks for `tools/cloudflared.exe`. If missing, downloads the official Cloudflare binary and **validates its Authenticode signature** (signed by Cloudflare, Inc.).
3. Compiles the TypeScript codebase (`npm run build`).
4. Starts the MCP server on `http://127.0.0.1:3000` and validates the `GET /health` endpoint.
5. Launches an ephemeral Cloudflare tunnel (`https://<random>.trycloudflare.com`).
6. Prints a clean banner with the ready-to-copy Notion URL (`https://<random>.trycloudflare.com/mcp`) and authorization header.
7. Gracefully terminates both the server and tunnel upon `Ctrl+C`.

---

## 3. Desktop GUI Overview

The desktop interface is designed for real-time visibility and convenience:

```
┌────────────────────────────────────────────────────────────────────────┐
│ [>_] MCP Terminal   v2.0.0    [● RUNNING | Port 3000] [Ngrok]   │
├────────────────────────────────────────────────────────────────────────┤
│ [ ▶ Start / ■ Stop ]  [ ⟳ Restart ]       📁 C:\...\workspace  [⚙ Settings]│
├────────────────────────────────────────────────────────────────────────┤
│ Notion & MCP Endpoints                                                 │
│ ┌───────────────────────────────┐ ┌──────────────────────────────────┐ │
│ │ 🔗 Notion Public URL (Ngrok)  │ │ 🖥️ Local MCP URL                 │ │
│ │ https://...ngrok-free.dev/mcp │ │ http://127.0.0.1:3000/mcp        │ │
│ │ [Copy]                        │ │ [Copy]                           │ │
│ └───────────────────────────────┘ └──────────────────────────────────┘ │
│ ┌───────────────────────────────┐ ┌──────────────────────────────────┐ │
│ │ 🔑 Raw Token (No "Bearer")    │ │ 🔑 Full Authorization Header     │ │
│ │ 1d3e8f...9a12  👁 [Copy Token]│ │ Bearer 1d3e8f...  [Copy Header]  │ │
│ └───────────────────────────────┘ └──────────────────────────────────┘ │
│  🌐 Ngrok Base Domain: https://statue-egomaniac-storable.ngrok-free.dev │
├────────────────────────────────────────────────────────────────────────┤
│ Real-time Activity Logs & Audit Stream                                 │
│ [11:24:00] [MCP] MCP Terminal listening on http://127.0.0.1:3000│
│ [11:24:02] [AUDIT] FILE_READ: workspace/src/index.ts (200 OK)         │
└────────────────────────────────────────────────────────────────────────┘
```

### Copy Cards:
1. **Notion Public URL (Ngrok `/mcp`)**: Full HTTPS URL pointing to `/mcp`. Paste this directly into Notion.
2. **Local MCP URL**: Local endpoint `http://127.0.0.1:3000/mcp` for local debugging with MCP Inspector.
3. **Raw Token**: Raw secret key without prefix. Includes a visibility toggle and copy button.
4. **Full Authorization Header**: Formatted header string `Bearer <token>`.
5. **Ngrok Base Domain**: Base tunnel hostname.

### Settings Modal:
Click **Settings (.env)** to configure server options visually:
- **API Key**: Secret access token. The dice button generates a fresh 64-character hex key.
- **Network (`PORT` and `HOST`)**: Server port (default: `3000`) and binding address (`127.0.0.1`).
- **Access Mode (`FULL_ACCESS`)**:
  - `false` (Default): Agent is jailed inside `FILES_ROOT`. Path traversal outside this folder is blocked.
  - `true`: Agent has unrestricted access to the host filesystem with your Windows user permissions.
- **Files Root (`FILES_ROOT`)**: Base directory path for sandbox mode.
- **Ngrok Tunnel**: `NGROK_ENABLED`, `NGROK_AUTHTOKEN`, and `NGROK_DOMAIN`.
- **Allowed Hosts (`ALLOWED_HOSTS`)**: Semicolon-separated hostnames for DNS Rebinding defense.
- **Limits**: `COMMAND_TIMEOUT_MS`, `MAX_OUTPUT_BYTES`, and `MAX_FILE_BYTES`.

### System Tray:
- **Minimize to Tray**: The minimize button (`ArrowDownToLine`) hides the window from the Windows taskbar.
- **Close Button (`X`)**: Stops the MCP server (if it is running) and quits the app. Alt+F4 and closing from the taskbar do the same. To keep the server running in the background, use Minimize to Tray instead.
- **Tray Menu (Right Click)**: Toggle window visibility, view live server status, open Ngrok URL, start/stop/restart server, or exit completely.

---

## 4. Connecting to Notion (Step-by-Step)

1. **Start the server** in the desktop app (click **Start Server**).
2. Verify that the **Ngrok Public Live** badge is green.
3. Click **Copy** on the **Notion Public URL (Ngrok /mcp)** card.
4. Open **Notion**:
   - Go to your Notion Agent settings or **Settings & Members** → **Connections** → **Add Connection** (Custom MCP).
   - In **Server URL**, paste the copied URL:
     ```text
     https://<your-domain>.ngrok-free.dev/mcp
     ```
   - In **Authentication**:
     - Header Name: `Authorization`
     - Header Value: Click **Copy Header** in the app (`Bearer <your_token>`) or **Copy Token** (if Notion auto-prepends Bearer).
5. Click **Connect / Test**. Notion will automatically discover all 20 available tools.

---

## 5. Architecture and Security

```
 Notion Agent (Cloud)
         │
         │  HTTPS (JSON-RPC over Streamable HTTP or SSE)
         ▼
 Public Tunnel (Ngrok or Cloudflare)
         │
         ▼
 MCP Terminal (Local Node.js/Electron Engine)
  ├── 1. Host Header Check (DNS Rebinding guard)
  ├── 2. Timing-Safe Auth Check (side-channel attack prevention)
  ├── 3. Structured Audit Logger (real-time UI log stream)
  └── 4. Tool Handlers (Terminal / Filesystem / Workspace / Browser)
```

### Sandbox vs Full Host Access

- **`FULL_ACCESS=false` (Default / Recommended)**:
  - All agent filesystem operations are strictly confined within `FILES_ROOT` (`./workspace`).
  - Path traversal attempts (`../`, symlink escapes, absolute paths to `C:\Windows` or `C:\Users`) are rejected with errors.
  - Working directory for terminal commands defaults to `FILES_ROOT`.
- **`FULL_ACCESS=true` (Unrestricted Mode)**:
  - The agent can browse, edit, and execute commands anywhere on your system with your Windows user privileges.

### Transports: Streamable HTTP and MCP SSE

The server supports both Model Context Protocol connection methods:
1. **Streamable HTTP (`/mcp`)** — Modern, stateless high-performance transport defined by the MCP standard. Used by Notion Custom Agents.
2. **MCP SSE Transport (`/sse` + `/messages`)** — Standard Server-Sent Events transport for compatibility with other MCP clients (Cursor, Claude Desktop, local inspectors).

### Tunneling: Ngrok and Cloudflare

1. **Built-in Ngrok SDK (`@ngrok/ngrok`)**:
   - Built into the server process. Supports free persistent static domains (`NGROK_DOMAIN`) so your Notion connection URL remains permanent across restarts.
2. **Cloudflare Quick Tunnel (`start-public.ps1`)**:
   - Free ephemeral tunnel requiring zero registration. Downloads verified `cloudflared.exe` and outputs a temporary `*.trycloudflare.com` URL.

---

## 6. MCP Tools Reference (20 Tools)

### 🖥️ 1. Terminal Execution
| Tool | Description | Parameters |
|---|---|---|
| `terminal_execute` | Execute PowerShell or CMD commands with UTF-8 encoding, configurable timeouts, custom cwd, and recursive process termination | `command`, `shell` (`powershell`/`cmd`), `cwd`, `timeout_ms` (max: 900,000) |

### 📁 2. Filesystem Operations
| Tool | Description | Parameters |
|---|---|---|
| `file_search` | Search files by glob pattern (`*.ts`) and/or search content with regex/text grep; files it could not search are listed in `skipped` | `path`, `pattern`, `query`, `case_sensitive`, `max_results` (max: 1,000) |
| `file_replace` | Safely replace an exact block of code or text in a file without rewriting the entire file | `path`, `target`, `replacement`, `allow_multiple` |
| `file_read` | Read UTF-8 text or Base64 binary files with offset pagination for large files | `path`, `encoding` (`utf8`/`base64`), `offset`, `length` |
| `file_write` | Create, overwrite, or append content to files (creates missing parent directories) | `path`, `data`, `encoding`, `append` |
| `file_list` | List directory contents recursively or flat with file sizes and metadata | `path`, `recursive`, `max_entries` (max: 10,000), `offset` (continue from `next_offset`) |
| `file_stat` | Inspect file/directory metadata (size, timestamps, mode) | `path` |
| `file_mkdir` | Create directories and any missing parent directories recursively | `path` |
| `file_move` | Move or rename files and directories with optional destination overwrite | `source`, `destination`, `overwrite` |
| `file_delete` | Permanently delete files or directories (`recursive: true` for non-empty folders) | `path`, `recursive` |

### 🗂️ 3. Workspace Management
| Tool | Description | Parameters |
|---|---|---|
| `workspace_get_cwd` | Inspect active working directory (`cwd`) and base sandbox root (`files_root`) | *(none)* |
| `workspace_set_cwd` | Switch active working directory (e.g. to a project subfolder), allowing short relative paths | `path` |

### 🌐 4. Browser Automation
| Tool | Description | Parameters |
|---|---|---|
| `browser_open` | Launch host browser (Google Chrome or Microsoft Edge) and navigate to a URL. Opens a visible window by default (`headless: false`) | `url`, `headless`, `browser` (`chrome`/`edge`) |
| `browser_navigate` | Navigate the active browser tab to a new URL with custom wait conditions | `url`, `wait_until`, `timeout_ms` |
| `browser_evaluate` | Execute arbitrary JavaScript in the active page context and return JSON result | `script` |
| `browser_click` | Click an element matching a CSS selector | `selector`, `timeout_ms` |
| `browser_type` | Type text into an input or textarea element with optional field clearing | `selector`, `text`, `clear`, `timeout_ms` |
| `browser_get_content` | Extract rendered text, raw DOM HTML, or page title | `type` (`text`/`html`/`title`), `selector`, `offset` / `length` (pages; continue from `next_offset`) |
| `browser_screenshot` | Capture full-page or viewport screenshots to a PNG file or return base64 | `path`, `full_page` |
| `browser_close` | Close active browser instance and release resources | *(none)* |

Detailed JSON schemas and specifications are available in [`AGENTS.md`](AGENTS.md).

---

## 7. FAQ and Troubleshooting

#### Q: How does Ngrok differ from Cloudflare Quick Tunnel?
**A**:
- **Ngrok** supports a free persistent domain (`myproject.ngrok-free.app`), meaning you never have to re-enter your connection URL in Notion after restarting the server.
- **Cloudflare Quick Tunnel (`start-public.ps1`)** requires no registration or token, but generates a random temporary `*.trycloudflare.com` URL per session.

#### Q: How does the agent switch between multiple projects?
**A**: The agent can invoke `workspace_set_cwd(path: "frontend")` or `workspace_set_cwd(path: "backend")`. Subsequent filesystem operations and terminal commands will run in the selected subfolder using simple relative paths.

Over SSE each connected agent has its own working directory, so two agents in different projects do not redirect each other's writes. Stateless `/mcp` clients share one. A relative write path that does not exist yet is created inside the working directory, never in `FILES_ROOT`.

#### Q: Where is configuration stored when using `.exe`?
**A**:
- **Portable Version (`MCP Terminal Portable.exe`)**: True portable mode. The `.env` file and `workspace/` folder are stored in `MCP Terminal Data/` beside the `.exe`. Check the configured absolute workspace path after moving the folder.
- **Installer Version (Setup.exe)**: Configuration is stored in `%APPDATA%\mcp-terminal\config\.env`.
- **Development / CLI**: Stored in `.env` in the repository root.

#### Q: How can I quickly recompile executables on Windows?
**A**: Run **`build.bat`** for the interactive menu or **`build-portable.bat`** to generate `release\MCP Terminal Portable.exe` in one click.
