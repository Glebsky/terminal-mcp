# Security Policy

## Supported versions

Security fixes are applied to the latest release on the default branch.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting feature under the repository's **Security** tab. Do not disclose a suspected vulnerability in a public issue or discussion.

Include the affected version, reproduction steps, potential impact, and any suggested mitigation. Remove API keys, access tokens, personal paths, tunnel URLs, command output containing secrets, and other private data from the report.

## Operational Warning & Threat Model

This project exposes powerful host capabilities over MCP:
1. **Terminal Command Execution (`terminal_execute`)**: Powershell and CMD execution on the host machine.
2. **Filesystem Operations (`file_*`)**: Reading, writing, modifying, and deleting files and directories.
3. **Workspace Management (`workspace_*`)**: Switching active working directory across projects.
4. **Host Browser Automation (`browser_*`)**: Launching Chrome/Edge, interacting with DOM elements, evaluating arbitrary JavaScript, and accessing local web services (e.g. `http://localhost:*`).

### Server-owned data (SPEC-010)

The server blocks content reads and changes to its own environment files, its explicit configuration directory (the parent of `DOTENV_PATH`), `AUDIT_LOG_FILE` and optional `PROTECTED_PATHS`. Search omits those paths. Directory listings and file stats can still expose names, timestamps and sizes; protected entries are marked. Parent moves or deletes that would affect protected data are rejected. Local file navigation checks the policy before opening a browser or tab. Denials are logged without file contents. The owner's desktop configuration editor is separate from MCP tools.

Keep explicit configuration in a dedicated private directory. The default environment-name rule applies in the server's startup directory only; `.env.example` is not private by name unless it is inside another protected location. A service should not be run under an account with more permissions than the work requires.

Tool output masks exact configured credential values of at least eight characters, not arbitrary strings that look like passwords. Output filters are not data-loss prevention and do not protect arbitrary encoded, binary or split values. File-tool policy is not a sandbox for shell processes or general browser execution. Use OS isolation and disable unneeded tools when the client is not fully trusted. Tool annotations are hints, not enforcement. This revision has no MCP-visible override of the server-owned file policy.

### Security Controls & Best Practices

- **Sandboxing (`FULL_ACCESS=false`)**: Keep sandboxed mode enabled whenever possible. All filesystem operations and terminal working directories will be strictly restricted within `FILES_ROOT`. Any attempts at path traversal (`../`, absolute outside paths, symlink escapes) are rejected.
- **Unrestricted Mode (`FULL_ACCESS=true`)**: Allows file tools outside `FILES_ROOT` and child processes inherit the privileges of the host account. The server-owned file rules below still apply. Only enable this in trusted, private local environments.
- **Authentication**: The default MCP authentication method accepts a bearer key or x-api-key header. Bearer/query modes require a key of at least 32 characters. Keep authentication enabled and use a trusted client.
- **Host Header Validation**: Prevents DNS rebinding and host spoofing attacks via `ALLOWED_HOSTS`.
- **Public Tunneling**: Never expose the local HTTP port directly to the raw internet without an authenticated HTTPS gateway or encrypted tunnel (Ngrok SDK or Cloudflare Tunnel).
