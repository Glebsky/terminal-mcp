# Agent Specification: MCP Terminal

Technical specification and operational guide for AI Agents (Notion Custom Agents, Claude, Cursor, Antigravity, and autonomous LLM agents) interacting with this MCP server.

---

## 1. System Overview

- **Server Identifier**: `notion-terminal-files`
- **Protocol**: [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)
- **Transports**: Streamable HTTP (`/mcp`) & Standard SSE (`/sse` + `/messages`)
- **Health Check**: `GET /health`
- **Server Info**: `GET /`
- **Authentication**: HTTP Authorization header (`Authorization: Bearer <API_KEY>`) or `x-api-key: <API_KEY>`

```
┌────────────────────────────────────────┐
│        AI Agent (e.g. Notion)          │
└───────────────────┬────────────────────┘
                    │  Streamable HTTP (JSON-RPC / MCP)
                    ▼
┌────────────────────────────────────────┐
│     Ngrok / Cloudflare Public Tunnel   │
└───────────────────┬────────────────────┘
                    │
┌───────────────────▼────────────────────┐
│      MCP Terminal Server        │
│  - Timing-Safe Authentication          │
│  - Host Header Validation              │
│  - Sandboxed / Full Access FS          │
│  - UTF-8 Windows Console Integration   │
│  - Structured Audit Logging            │
└────────────────────────────────────────┘
```

---

## 2. Security & Execution Model

### 2.1 Sandboxing (`FULL_ACCESS`)
- **When `FULL_ACCESS=false` (Default Sandbox)**:
  - All file and directory paths are strictly jailed within `FILES_ROOT` (e.g., `./workspace` or custom configured path).
  - Path traversal attempts (`../`, symlink escapes, absolute paths pointing outside `FILES_ROOT`) are immediately rejected with an error.
  - Working directories (`cwd`) for `terminal_execute` default to `FILES_ROOT`.
- **When `FULL_ACCESS=true` (Unrestricted Mode)**:
  - The agent has full access to the host filesystem with permissions of the host user running the server.

### 2.2 Limits and Buffers
- `MAX_OUTPUT_BYTES` (default: 1 MB): Terminal output exceeding this limit is capped with `truncated: true`.
- `MAX_FILE_BYTES` (default: 10 MB): File read/write operations exceeding this limit require offset pagination or are rejected.
- `COMMAND_TIMEOUT_MS` (default: 120,000 ms, max: 900,000 ms): Long running processes are automatically killed with their full process tree.

---

## 3. Tool Specifications

### 3.1 `terminal_execute`
Execute a terminal command on the host (PowerShell or cmd.exe) with native UTF-8 encoding.

#### Input Schema
| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `command` | `string` | Yes | - | The shell command string to execute. |
| `shell` | `"powershell" \| "cmd"` | No | `"powershell"` | Target Windows shell interpreter. |
| `cwd` | `string` | No | Sandbox root | Absolute or relative working directory. |
| `timeout_ms` | `number` | No | Server default | Execution timeout in milliseconds (max: 900,000). |

#### Response Format
```json
{
  "content": [
    {
      "type": "text",
      "text": "{\n  \"exitCode\": 0,\n  \"stdout\": \"...\",\n  \"stderr\": \"...\",\n  \"timedOut\": false,\n  \"truncated\": false\n}"
    }
  ],
  "isError": false
}
```

- The call always returns within `timeout_ms + 2 s`. After the shell exits, output is drained for at most 1 s; if a background child (e.g. `start /b ...`) still holds the output pipe, the result includes `"backgroundLeft": true` and that child keeps running.
- If the client disconnects or cancels the request, the process tree is killed and the result includes `"aborted": true`.
- With `shell: "cmd"` the command text reaches cmd verbatim (quotes, `&`, `|`, `%`, `^`, `!` behave as in `cmd /c`), and built-ins such as `echo` and `dir` print UTF-8.
- stdout and stderr are capped at `MAX_OUTPUT_BYTES` each (`"truncated": true`) and cut at a character boundary. The rest cannot be fetched: redirect long output to a file and read it with `file_read`.

---

### 3.2 `file_search`
Search files by glob pattern (e.g., `*.ts`) and/or search for text/regex inside file contents (Grep).

#### Input Schema
| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | `string` | Yes | - | Base directory to search within. |
| `pattern` | `string` | No | - | Filename glob pattern (e.g. `*.ts`, `*config*`). |
| `query` | `string` | No | - | Substring or regex pattern to search within files. |
| `case_sensitive` | `boolean` | No | `false` | Case sensitive search matching. |
| `max_results` | `number` | No | `100` | Maximum number of matches to return (max: 1,000). |

#### Response Format
```json
{
  "root": "C:\\workspace\\project",
  "results": [
    {
      "path": "C:\\workspace\\project\\src\\config.ts",
      "line": 15,
      "column": 7,
      "snippet": "const PORT = integerEnv(\"PORT\", 3000);"
    }
  ],
  "truncated": false
}
```

- `column` is the 1-based position of the match in the line (UTF-16 characters); `snippet` is up to 500 characters of the line around the match, copied verbatim.
- Long lines are searched completely (in overlapping windows; a single match longer than 1,000 characters on a line longer than 4,000 can be missed).
- Files up to `MAX_FILE_BYTES` are searched. Whatever could not be searched (larger files, unreadable files or directories) is listed in `skipped` (`[{ "path", "reason" }]`, up to 50) with `skipped_total`, so empty `results` without `skipped` really means "not found". Binary files are ignored.
- Text that is not UTF-8 is decoded with the system ANSI code page (e.g. windows-1251), files with a UTF-16 BOM are read as UTF-16; such matches carry `encoding`. `file_replace` still refuses non-UTF-8 files.

---

### 3.3 `file_replace`
Replace an exact block of code or text inside a file without rewriting the entire file.

#### Input Schema
| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | `string` | Yes | - | Path to the target file. |
| `target` | `string` | Yes | - | Exact string/block of code to replace. |
| `replacement` | `string` | Yes | - | Replacement string/block of code. |
| `allow_multiple` | `boolean` | No | `false` | Allow replacing multiple occurrences across the file. |

#### Response Format
```json
{
  "path": "C:\\workspace\\project\\src\\config.ts",
  "replacements": 1
}
```

- Writes to the same path are serialized and atomic (temp file + rename), so parallel edits of one file do not lose each other.
- Retrying an edit that already landed is safe: if `target` is gone and `replacement` occurs exactly once, the answer is `"replacements": 0, "already_applied": true` instead of an error.
- Files that are not valid UTF-8 (e.g. cp1251) are rejected; edit them with `terminal_execute`.

---

### 3.4 `file_read`
Read text or binary files with optional chunking/offset.

#### Input Schema
| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | `string` | Yes | - | Path to the file. |
| `encoding` | `"utf8" \| "base64"` | No | `"utf8"` | Content encoding ("utf8" for text, "base64" for binaries). |
| `offset` | `number` | No | `0` | Byte offset to begin reading. |
| `length` | `number` | No | `MAX_FILE_BYTES` | Maximum number of bytes to read. |

#### Response Format
```json
{
  "path": "C:\\workspace\\project\\src\\main.ts",
  "size": 4096,
  "offset": 0,
  "bytes_read": 4096,
  "truncated": false,
  "encoding": "utf8",
  "data": "... file content ..."
}
```

- With `encoding: "utf8"` a chunk never splits a character: the end moves back to the last whole character, an `offset` inside a character moves back to its first byte (the response `offset` is the actual one), and a `length` shorter than one character still returns that whole character.
- While `truncated` is `true`, the response has `next_offset`. Read the next chunk from `next_offset`, not from `offset + length`, or the bytes trimmed at the edge are skipped.
- `base64` returns the exact requested bytes. Read non-UTF-8 text (e.g. cp1251) as base64.

---

### 3.5 `file_write`
Create, overwrite, or append content to a file. Missing parent directories are created automatically.

#### Input Schema
| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | `string` | Yes | - | Path to target file. |
| `data` | `string` | Yes | - | Text content or base64-encoded binary data. |
| `encoding` | `"utf8" \| "base64"` | No | `"utf8"` | Encoding of `data`. |
| `append` | `boolean` | No | `false` | If `true`, appends data instead of overwriting. |

#### Response Format
```json
{
  "path": "C:\\workspace\\project\\src\\main.ts",
  "bytes_written": 128,
  "appended": false
}
```

---

### 3.6 `file_list`
List files and subdirectories in a directory path.

#### Input Schema
| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | `string` | Yes | - | Directory path. |
| `recursive` | `boolean` | No | `false` | Scan directory recursively. |
| `max_entries` | `number` | No | `500` | Max entries to return (max: 10,000). |
| `offset` | `number` | No | `0` | Entries to skip; pass `next_offset` from the previous page. |

When `truncated` is `true`, the response has `next_offset`. Pages are consistent while the directory does not change.

---

### 3.7 `file_stat`
Inspect file or directory metadata (size, created/modified timestamps, mode).

#### Input Schema
| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | Yes | Target path to inspect. |

---

### 3.8 `file_mkdir`
Create a directory and all missing parent directories.

#### Input Schema
| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | Yes | Path of directory to create. |

---

### 3.9 `file_move`
Move or rename a file or directory.

#### Input Schema
| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `source` | `string` | Yes | - | Source path. |
| `destination` | `string` | Yes | - | Destination path. |
| `overwrite` | `boolean` | No | `false` | Overwrite destination if it already exists. |

If the move succeeded but the backup of the overwritten destination could not be removed, the answer is still a success and includes `backup_left` with the backup path.

---

### 3.10 `file_delete`
Delete a file or directory.

#### Input Schema
| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | `string` | Yes | - | Path to delete. |
| `recursive` | `boolean` | No | `false` | Set to `true` to delete non-empty directories. |

---

### 3.11 `workspace_get_cwd`
Get the current active working directory and root directory path.

#### Input Schema
*(No parameters)*

#### Response Format
```json
{
  "cwd": "C:\\OSPanel\\home\\sandustry",
  "files_root": "C:\\OSPanel\\home"
}
```

---

### 3.12 `workspace_set_cwd`
Change the active working directory for subsequent file operations and terminal commands (e.g. switch to `"sandustry"`). Allows using short relative paths within that project.

#### Input Schema
| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | Yes | Subdirectory name (e.g. `"sandustry"`) or path to set as current working directory. |

#### Response Format
```json
{
  "cwd": "C:\\OSPanel\\home\\sandustry",
  "files_root": "C:\\OSPanel\\home",
  "message": "Active working directory switched to: C:\\OSPanel\\home\\sandustry"
}
```

- Over SSE (`/sse`) each session has its own working directory, starting from the shared one at connect time; `workspace_set_cwd`, a bare `cd` in `terminal_execute` and the reset after `file_delete` change only that session. Stateless `/mcp` requests share one process-wide working directory.
- Relative paths for writes (`file_write`, `file_replace`, `file_move`, `file_delete`, `file_mkdir`, `browser_screenshot` path) resolve only against the working directory, never silently against `FILES_ROOT`. Reads, search, `workspace_set_cwd` and the `cwd` of `terminal_execute` still fall back to `FILES_ROOT`.

---

### 3.13 `browser_open`
Open a webpage in the host browser (Chrome or Edge). By default launches a visible browser window (`headless: false`) so you can visually interact and test web applications.

#### Input Schema
| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | `string` | Yes | - | Webpage URL (e.g. `http://localhost:3000`, `https://example.com`). |
| `headless` | `boolean` | No | `false` | If `false`, opens a real visible browser window. If `true`, runs headlessly. |
| `browser` | `"chrome" \| "edge"` | No | `"chrome"` | Preferred host browser (Google Chrome or Microsoft Edge). |

---

### 3.14 `browser_navigate`
Navigate the active browser page to a new URL.

#### Input Schema
| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | `string` | Yes | - | Target URL to navigate to. |
| `wait_until` | `"load" \| "domcontentloaded" \| "networkidle0"` | No | `"load"` | Navigation wait condition. |
| `timeout_ms` | `number` | No | `30000` | Navigation timeout in milliseconds (max: 120,000). |

---

### 3.15 `browser_evaluate`
Evaluate arbitrary JavaScript code inside the active webpage context. Returns the evaluated value as JSON.

#### Input Schema
| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `script` | `string` | Yes | - | JavaScript code or expression to run (e.g. `document.title`, `window.__APP_STATE__`). |

#### Response Format
```json
{
  "result": { "title": "Dashboard", "userCount": 42 },
  "url": "http://localhost:3000/dashboard",
  "title": "Dashboard"
}
```

---

### 3.16 `browser_click`
Click an HTML element matching a CSS selector on the active page.

#### Input Schema
| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `selector` | `string` | Yes | - | CSS selector (e.g. `"button.submit"`, `"#login"`, `"a[href='/settings']"`). |
| `timeout_ms` | `number` | No | `10000` | Wait timeout in milliseconds (max: 60,000). |

---

### 3.17 `browser_type`
Type text into an input or textarea element on the active page.

#### Input Schema
| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `selector` | `string` | Yes | - | CSS selector of input/textarea. |
| `text` | `string` | Yes | - | Text string to type into the element. |
| `clear` | `boolean` | No | `false` | Whether to clear existing text before typing. |
| `timeout_ms` | `number` | No | `10000` | Wait timeout in milliseconds (max: 60,000). |

---

### 3.18 `browser_get_content`
Extract readable text, raw HTML, or title from the active webpage or a specific selector.

#### Input Schema
| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `type` | `"text" \| "html" \| "title"` | No | `"text"` | Content type to extract. |
| `selector` | `string` | No | - | Optional CSS selector to target a specific container element. |
| `offset` | `number` | No | `0` | First character to return (UTF-16 index); pass `next_offset` from the previous page. |
| `length` | `number` | No | - | Maximum number of characters to return. |

The response has `content`, `offset`, `length`, `total_length` and `truncated`, plus `next_offset` while `truncated` is `true`. `MAX_OUTPUT_BYTES` counts UTF-8 bytes; page edges never split a character. If the page changes between calls, the pieces may not line up.

---

### 3.19 `browser_screenshot`
Capture a screenshot of the active browser page. Can save to file or return base64.

#### Input Schema
| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | `string` | No | - | Optional file path to save PNG screenshot to. |
| `full_page` | `boolean` | No | `false` | Capture full scrollable page or visible viewport. |

---

### 3.20 `browser_close`
Close the active browser instance and all tabs.

#### Input Schema
*(No parameters)*

---

## 4. Agent Best Practices & Recommended Workflows

### 1. Code Editing Workflow
- **Search first**: Use `file_search` with `query` to locate the exact file and line number containing relevant functions or classes.
- **Inspect**: Use `file_read` to inspect surrounding code context.
- **Targeted Edits**: Use `file_replace` with a distinct surrounding chunk of code to perform edits cleanly without rewriting entire files.

### 2. Terminal Commands
- UTF-8 encoding is enabled by default for both PowerShell and cmd.exe. Cyrillic and multilingual characters are preserved properly.
- Long-running commands automatically terminate after `COMMAND_TIMEOUT_MS` along with any spawned child processes.

### 3. Relative Paths & Multi-Project Workspaces
- You can freely use short relative paths like `src/index.ts`, `sandustry/src/index.ts`, or `./package.json`.
- The server automatically resolves relative paths against the active project folder.
- Use `workspace_set_cwd(path: "project_name")` or pass `cwd` in `terminal_execute` or inspect a directory with `file_list` / `file_search` to switch the active project directory at any time.

### 4. Browser Automation & Live Testing
- **Test Web Applications**: After modifying web files, open the local dev server using `browser_open(url: "http://localhost:3000")`.
- **Inspect DOM & State**: Run `browser_evaluate(script: "document.querySelector('h1').innerText")` to verify page rendering.
- **Form Submissions & Interaction**: Use `browser_type` to fill in inputs and `browser_click` to click buttons.
- **Visual Verification**: Use `browser_screenshot` to confirm layouts, styles, and responsive design.
- **Cleanup**: Call `browser_close` once your testing session is complete.

---

## 5. Working on This Repository (Coding Agents)

Rules for agents that change the code of MCP Terminal itself (server, Electron shell, desktop UI).

### 5.1 Layout
- `src/`: headless MCP server (Node.js, Express, ESM, `tsconfig.json`). Tools live in `src/tools/`, registrations in `src/tools/index.ts`.
- `desktop/src/main/`: Electron main process, preload and server manager (`tsconfig.electron.json`).
- `desktop/src/renderer/`: React 19 + Tailwind 4 UI (`tsconfig.desktop.json`, Vite root is `desktop/`).
  - `components/Monitor.tsx`: connection monitor. `components/flow/`: DATA FLOW band (`flowRibbonEngine.ts` canvas engine without React, `FlowRibbon.tsx` wrapper, `EasedValue.tsx` eased counters).
  - `i18n/en.ts` is the reference dictionary: its keys type `uk.ts` and `ru.ts`, so every new key goes into all three files.
  - `styles/liquid-glass.css`: dark glass base styles. `styles/settings.css`: settings and light-theme overrides. `appTheme.css`: colour tokens.
- `desktop/preview/flow.html`: dev-only bench for the data flow band (not part of the app bundle).
- `docs/specs/SPEC-NNN-*.md`: feature specifications (Russian): context, requirements (FR), design, task list, acceptance criteria.

### 5.2 Commands
| Task | Command |
|---|---|
| Type-check server, desktop UI and Electron | `npm run check` |
| Build the renderer | `npm run build:renderer` |
| Full build | `npm run build` |
| Desktop dev mode (Vite on 5173 + Electron) | `npm run app:dev` |
| Monitor server test | `npm run test:monitor` |
| Data flow band bench | `npx vite --port 5174`, open `http://localhost:5174/preview/flow.html#heavy` (scenarios: `idle`, `trickle`, `steady`, `bursts`, `heavy`, `upload`, `offline`) |

Run `npm run check` and `npm run build:renderer` before every commit that touches `desktop/`.

### 5.3 Conventions
- **Spec first.** UI or behaviour features get a `docs/specs/SPEC-NNN` file (or an update of an existing one). Keep the task checkboxes current and mark superseded requirements instead of deleting them.
- **Motion.** Every animated element respects the `animation` prop (`interfaceMotion`) and `prefers-reduced-motion`, and has a static fallback. CSS animations are switched off under `.motion-off` (except `.functional-motion`).
- **Per-frame work** goes to canvas or CSS custom properties, never to React state at 60 fps. Write CSS variables only when the value actually changes.
- **Data flow band colours:** `#3cc8ff -> #4a92ff -> #6a6dff -> #b26bff`. Keep `BAND_STOPS` in `flowRibbonEngine.ts` and `.flow-direction-*` in `liquid-glass.css` in sync.
- **Tunable constants** of the band (`FULL_SCALE_BYTES`, `CROSSING_SECONDS`, `ATTACK_SECONDS`, `RELEASE_SECONDS`, `STALE_MS`, `IDLE_PEAK`) are documented in SPEC-003; update the spec when you change them.
- **Commits** follow Conventional Commits: `feat(desktop): ...`, `fix(auth): ...`, `docs: ...`.
- **Line endings** are normalised by Git (LF in the index, CRLF in the Windows working tree); do not convert files by hand.
- **Verify edits.** After `file_replace` or `file_write`, re-read the changed region or run the type-check. Pay extra attention to files with non-ASCII text (i18n dictionaries, Russian docs).
- Do not commit local artefacts: `.env`, screenshots, `*.bak`, logs, `dist*/`, `release/`.
