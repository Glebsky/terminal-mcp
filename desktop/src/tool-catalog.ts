export interface ToolInfo {
  name: string;
  description: string;
}

export interface ToolGroup {
  id: string;
  title: string;
  description: string;
  tools: ToolInfo[];
}

/** MCP tools exposed by the server, grouped for the settings screen. Keep in sync with src/tools/index.ts. */
export const toolGroups: ToolGroup[] = [
  {
    id: "terminal",
    title: "Terminal",
    description: "Shell access on this computer. The most powerful tool; disable it if agents only need files or the browser.",
    tools: [{ name: "terminal_execute", description: "Run PowerShell or cmd commands." }],
  },
  {
    id: "files-read",
    title: "Files · read",
    description: "Read-only access to files inside the sandbox root (or everywhere with unrestricted access).",
    tools: [
      { name: "file_read", description: "Read text or binary files." },
      { name: "file_list", description: "List directory contents." },
      { name: "file_search", description: "Find files by name or content." },
      { name: "file_stat", description: "Show file or folder metadata." },
    ],
  },
  {
    id: "files-write",
    title: "Files · modify",
    description: "Tools that create, change or remove files.",
    tools: [
      { name: "file_write", description: "Create, overwrite or append to files." },
      { name: "file_replace", description: "Replace text inside a file." },
      { name: "file_mkdir", description: "Create folders." },
      { name: "file_move", description: "Move or rename files and folders." },
      { name: "file_delete", description: "Permanently delete files and folders." },
    ],
  },
  {
    id: "workspace",
    title: "Workspace",
    description: "Active working directory used by file and terminal tools.",
    tools: [
      { name: "workspace_get_cwd", description: "Show the active working directory." },
      { name: "workspace_set_cwd", description: "Switch the active working directory." },
    ],
  },
  {
    id: "browser",
    title: "Browser automation",
    description: "Control a Chrome/Edge page: open sites, read content, click, type and take screenshots.",
    tools: [
      { name: "browser_open", description: "Launch a browser and open a URL." },
      { name: "browser_navigate", description: "Navigate the active tab to a URL." },
      { name: "browser_get_content", description: "Read text, HTML or title of the page." },
      { name: "browser_screenshot", description: "Capture a screenshot of the page." },
      { name: "browser_evaluate", description: "Run JavaScript inside the page." },
      { name: "browser_click", description: "Click an element." },
      { name: "browser_type", description: "Type into an input field." },
      { name: "browser_close", description: "Close the launched browser or disconnect from yours." },
    ],
  },
  {
    id: "browser-tabs",
    title: "Your open browser",
    description: "Attach to an already running browser with its tabs and logged-in sessions.",
    tools: [
      { name: "browser_connect", description: "Connect via the remote debugging port." },
      { name: "browser_list_tabs", description: "List open tabs." },
      { name: "browser_select_tab", description: "Choose which tab the browser tools work with." },
      { name: "browser_new_tab", description: "Open a new tab." },
    ],
  },
];

export const allToolNames: string[] = toolGroups.flatMap(group => group.tools.map(tool => tool.name));

export function parseDisabledTools(value: string): Set<string> {
  return new Set(value.split(/[;,\s]+/).map(name => name.trim().toLowerCase()).filter(Boolean));
}

export function serializeDisabledTools(names: Iterable<string>): string {
  return [...new Set(names)].sort().join(";");
}
