import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import { textResult, errorResult } from "./types.js";
import { executeCommand } from "./command.js";
import {
  readFile,
  writeFile,
  replaceInFile,
  searchFiles,
  listFiles,
  statPath,
  createDirectory,
  movePath,
  deletePath,
  getActiveWorkingDir,
  setActiveWorkingDir,
} from "./filesystem.js";
import { browserManager } from "./browser.js";

/**
 * Register every tool except those listed in DISABLED_TOOLS. Disabled tools are removed
 * right after registration, so they never appear in tools/list and cannot be called.
 */
export function registerAllTools(server: McpServer): void {
  const disabled = config.disabledTools;
  if (disabled.size === 0) {
    registerTools(server);
    return;
  }
  const filtered = new Proxy(server, {
    get(target, prop, receiver) {
      if (prop !== "registerTool") return Reflect.get(target, prop, receiver);
      return (name: string, ...rest: unknown[]) => {
        const register = target.registerTool as unknown as (...args: unknown[]) => RegisteredTool;
        const tool = register.call(target, name, ...rest);
        if (disabled.has(name)) tool.remove();
        return tool;
      };
    },
  });
  registerTools(filtered);
}

function registerTools(server: McpServer): void {
  server.registerTool(
    "terminal_execute",
    {
      title: "Execute a terminal command",
      description:
        "Execute a PowerShell or cmd command on the host. This has unrestricted host privileges when FULL_ACCESS=true.",
      inputSchema: {
        command: z.string().min(1).describe("The command to execute"),
        shell: z.enum(["powershell", "cmd"]).default("powershell").describe("Shell type to execute command in"),
        cwd: z.string().optional().describe("Working directory for command execution"),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .max(900_000)
          .optional()
          .describe("Command timeout in milliseconds (default: COMMAND_TIMEOUT_MS, max: 900000)"),
      },
    },
    async ({ command, shell, cwd, timeout_ms }) => {
      try {
        const result = await executeCommand(command, shell, cwd, timeout_ms);
        return textResult(result, result.exitCode !== 0 || result.timedOut);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "file_read",
    {
      title: "Read a file",
      description: "Read a text or binary file from the host filesystem.",
      inputSchema: {
        path: z.string().min(1).describe("Path to the file to read"),
        encoding: z.enum(["utf8", "base64"]).default("utf8").describe("File content encoding"),
        offset: z.number().int().nonnegative().default(0).describe("Byte offset to start reading from"),
        length: z
          .number()
          .int()
          .positive()
          .max(config.maxFileBytes)
          .optional()
          .describe(`Number of bytes to read (max: ${config.maxFileBytes})`),
      },
    },
    async ({ path: inputPath, encoding, offset, length }) => {
      try {
        const result = await readFile(inputPath, encoding, offset, length);
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "file_write",
    {
      title: "Write a file",
      description: "Create, overwrite, or append to a file. Parent directories are created automatically.",
      inputSchema: {
        path: z.string().min(1).describe("Path to the file to write"),
        data: z.string().describe("Content to write into the file"),
        encoding: z.enum(["utf8", "base64"]).default("utf8").describe("Encoding of input data"),
        append: z.boolean().default(false).describe("If true, appends data to the end of the file"),
      },
    },
    async ({ path: inputPath, data, encoding, append }) => {
      try {
        const result = await writeFile(inputPath, data, encoding, append);
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "file_replace",
    {
      title: "Replace text in file",
      description:
        "Replace an exact substring or block of code in a file without rewriting the whole file.",
      inputSchema: {
        path: z.string().min(1).describe("Path to the file"),
        target: z.string().min(1).describe("The exact text/code chunk to replace"),
        replacement: z.string().describe("The replacement text/code chunk"),
        allow_multiple: z
          .boolean()
          .default(false)
          .describe("If true, replaces all occurrences. If false, fails if target appears more than once."),
      },
    },
    async ({ path: inputPath, target, replacement, allow_multiple }) => {
      try {
        const result = await replaceInFile(inputPath, target, replacement, allow_multiple);
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "file_search",
    {
      title: "Search files",
      description:
        "Search files by name pattern (e.g. *.ts) and/or search for text/regex inside file contents.",
      inputSchema: {
        path: z.string().min(1).describe("Base directory to search in"),
        pattern: z
          .string()
          .optional()
          .describe("Filename glob pattern (e.g. *.ts, *config*, *.json)"),
        query: z
          .string()
          .optional()
          .describe("Text or regex to search inside file contents"),
        case_sensitive: z
          .boolean()
          .default(false)
          .describe("Whether content search is case sensitive"),
        max_results: z
          .number()
          .int()
          .positive()
          .max(1000)
          .default(100)
          .describe("Maximum number of results to return"),
      },
    },
    async ({ path: inputPath, pattern, query, case_sensitive, max_results }) => {
      try {
        const result = await searchFiles(inputPath, pattern, query, case_sensitive, max_results);
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "file_list",
    {
      title: "List files",
      description: "List files and directories at a host path.",
      inputSchema: {
        path: z.string().min(1).describe("Directory path to list"),
        recursive: z.boolean().default(false).describe("Whether to list subdirectories recursively"),
        max_entries: z
          .number()
          .int()
          .positive()
          .max(10_000)
          .default(500)
          .describe("Maximum number of items to return"),
      },
    },
    async ({ path: inputPath, recursive, max_entries }) => {
      try {
        const result = await listFiles(inputPath, recursive, max_entries);
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "file_stat",
    {
      title: "Inspect a path",
      description: "Return metadata for a file or directory.",
      inputSchema: {
        path: z.string().min(1).describe("Path to inspect"),
      },
    },
    async ({ path: inputPath }) => {
      try {
        const result = await statPath(inputPath);
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "file_mkdir",
    {
      title: "Create a directory",
      description: "Create a directory and any missing parent directories.",
      inputSchema: {
        path: z.string().min(1).describe("Path of directory to create"),
      },
    },
    async ({ path: inputPath }) => {
      try {
        const result = await createDirectory(inputPath);
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "file_move",
    {
      title: "Move or rename a path",
      description: "Move or rename a file or directory.",
      inputSchema: {
        source: z.string().min(1).describe("Source path"),
        destination: z.string().min(1).describe("Destination path"),
        overwrite: z.boolean().default(false).describe("Whether to overwrite existing destination"),
      },
    },
    async ({ source, destination, overwrite }) => {
      try {
        const result = await movePath(source, destination, overwrite);
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "file_delete",
    {
      title: "Delete a path",
      description:
        "Permanently delete a file or directory. Recursive directory deletion must be explicitly enabled.",
      inputSchema: {
        path: z.string().min(1).describe("Path of file or directory to delete"),
        recursive: z.boolean().default(false).describe("Required to be true to delete non-empty directories"),
      },
    },
    async ({ path: inputPath, recursive }) => {
      try {
        const result = await deletePath(inputPath, recursive);
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "workspace_get_cwd",
    {
      title: "Get current working directory",
      description: "Get the current active working directory and files root.",
      inputSchema: {},
    },
    async () => {
      try {
        return textResult({
          cwd: getActiveWorkingDir(),
          files_root: config.filesRoot,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "workspace_set_cwd",
    {
      title: "Set current working directory",
      description:
        "Change the active working directory for subsequent file operations and terminal commands (e.g. 'sandustry'). Allows using short relative paths within that project.",
      inputSchema: {
        path: z.string().min(1).describe("Subdirectory name or path to set as current working directory"),
      },
    },
    async ({ path: inputPath }) => {
      try {
        const cwd = setActiveWorkingDir(inputPath);
        return textResult({
          cwd,
          files_root: config.filesRoot,
          message: `Active working directory switched to: ${cwd}`,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "browser_open",
    {
      title: "Open URL in browser",
      description:
        "Open a webpage in host browser (Chrome or Edge). By default launches a visible browser window (headless=false) so you can test web applications visually.",
      inputSchema: {
        url: z.string().min(1).describe("The URL to open (e.g. http://localhost:3000, http://127.0.0.1:8080, https://...)"),
        headless: z.boolean().default(false).describe("If false (default), opens a real visible browser window. If true, runs headlessly."),
        browser: z.enum(["chrome", "edge"]).default("chrome").describe("Preferred browser (defaults to Google Chrome, falls back to Microsoft Edge)"),
      },
    },
    async ({ url, headless, browser }) => {
      try {
        const result = await browserManager.open({ url, headless, browser });
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "browser_navigate",
    {
      title: "Navigate to URL",
      description: "Navigate the active browser page to a new URL.",
      inputSchema: {
        url: z.string().min(1).describe("Target URL to navigate to"),
        wait_until: z.enum(["load", "domcontentloaded", "networkidle0"]).default("load").describe("Condition to wait for"),
        timeout_ms: z.number().int().positive().max(120_000).default(30_000).describe("Navigation timeout in milliseconds"),
      },
    },
    async ({ url, wait_until, timeout_ms }) => {
      try {
        const result = await browserManager.navigate({ url, waitUntil: wait_until, timeoutMs: timeout_ms });
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "browser_evaluate",
    {
      title: "Execute JavaScript in browser",
      description:
        "Evaluate arbitrary JavaScript code inside the active browser webpage context. Returns the evaluated value as JSON.",
      inputSchema: {
        script: z.string().min(1).describe("JavaScript code or expression to run (e.g. document.title, window.__STATE__, or an async function)"),
      },
    },
    async ({ script }) => {
      try {
        const result = await browserManager.evaluate({ script });
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "browser_click",
    {
      title: "Click element on webpage",
      description: "Click an HTML element matching a CSS selector in the active browser page.",
      inputSchema: {
        selector: z.string().min(1).describe("CSS selector of element to click (e.g. 'button.submit', '#login', 'a[href=\"/about\"]')"),
        timeout_ms: z.number().int().positive().max(60_000).default(10_000).describe("Wait timeout for element in milliseconds"),
      },
    },
    async ({ selector, timeout_ms }) => {
      try {
        const result = await browserManager.click({ selector, timeoutMs: timeout_ms });
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "browser_type",
    {
      title: "Type text into element",
      description: "Type text into an input or textarea element on the active browser page.",
      inputSchema: {
        selector: z.string().min(1).describe("CSS selector of input/textarea element"),
        text: z.string().describe("Text string to type into the element"),
        clear: z.boolean().default(false).describe("Whether to clear existing text before typing"),
        timeout_ms: z.number().int().positive().max(60_000).default(10_000).describe("Wait timeout for element in milliseconds"),
      },
    },
    async ({ selector, text, clear, timeout_ms }) => {
      try {
        const result = await browserManager.type({ selector, text, clear, timeoutMs: timeout_ms });
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "browser_get_content",
    {
      title: "Get webpage content",
      description: "Extract readable text, raw HTML, or title from the active webpage or a specific selector.",
      inputSchema: {
        type: z.enum(["text", "html", "title"]).default("text").describe("Type of content: 'text' (rendered text), 'html' (DOM HTML), or 'title'"),
        selector: z.string().optional().describe("Optional CSS selector to target a specific container element"),
      },
    },
    async ({ type, selector }) => {
      try {
        const result = await browserManager.getContent({ type, selector });
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "browser_screenshot",
    {
      title: "Take webpage screenshot",
      description: "Capture a screenshot of the active browser page. Can save to file or return base64.",
      inputSchema: {
        path: z.string().optional().describe("Optional file path to save PNG screenshot to (e.g. 'screenshots/test1.png')"),
        full_page: z.boolean().default(false).describe("Whether to capture full scrollable page or visible viewport only"),
      },
    },
    async ({ path: outputPath, full_page }) => {
      try {
        const result = await browserManager.screenshot({ path: outputPath, fullPage: full_page });
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "browser_connect",
    {
      title: "Connect to running browser",
      description:
        "Attach to an already running Chrome/Edge with its open tabs, cookies and logged-in sessions via the remote debugging port, instead of launching a new browser. " +
        "After connecting, browser_get_content, browser_evaluate, browser_screenshot, browser_click and browser_type work on the selected tab (by default the tab the user is looking at). " +
        "The browser must run with --remote-debugging-port=9222 and a non-default --user-data-dir; set launch_if_missing=true to start such a browser with a persistent profile.",
      inputSchema: {
        endpoint: z
          .string()
          .optional()
          .describe("DevTools endpoint: a port (9222), http://127.0.0.1:9222 or ws://... Defaults to BROWSER_CDP_URL or http://127.0.0.1:9222"),
        launch_if_missing: z
          .boolean()
          .default(false)
          .describe("If nothing listens on the endpoint, start Chrome/Edge with remote debugging and a persistent profile (it stays open after disconnect)"),
        browser: z.enum(["chrome", "edge"]).default("chrome").describe("Browser to start when launch_if_missing=true"),
        timeout_ms: z.number().int().positive().max(120_000).default(20_000).describe("How long to wait for a started browser to accept connections"),
      },
    },
    async ({ endpoint, launch_if_missing, browser, timeout_ms }) => {
      try {
        const result = await browserManager.connect({
          ...(endpoint ? { endpoint } : {}),
          launchIfMissing: launch_if_missing,
          browser,
          timeoutMs: timeout_ms,
        });
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "browser_list_tabs",
    {
      title: "List browser tabs",
      description: "List open tabs (index, url, title, whether visible to the user and whether active for browser_* tools) in the current browser session.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await browserManager.listTabs();
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "browser_select_tab",
    {
      title: "Select browser tab",
      description:
        "Choose which open tab subsequent browser_* tools operate on: by index (from browser_list_tabs), by URL or title substring, or with no arguments the tab the user is currently looking at.",
      inputSchema: {
        index: z.number().int().min(0).optional().describe("Tab index from browser_list_tabs"),
        url_contains: z.string().min(1).optional().describe("Case-insensitive substring of the tab URL"),
        title_contains: z.string().min(1).optional().describe("Case-insensitive substring of the tab title"),
        bring_to_front: z.boolean().default(false).describe("Also switch the visible tab in the browser window"),
      },
    },
    async ({ index, url_contains, title_contains, bring_to_front }) => {
      try {
        const result = await browserManager.selectTab({
          ...(index !== undefined ? { index } : {}),
          ...(url_contains ? { urlContains: url_contains } : {}),
          ...(title_contains ? { titleContains: title_contains } : {}),
          bringToFront: bring_to_front,
        });
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "browser_new_tab",
    {
      title: "Open new tab",
      description: "Open a new tab in the current browser session (optionally navigating to a URL) and make it the active tab for browser_* tools.",
      inputSchema: {
        url: z.string().min(1).optional().describe("URL to open in the new tab"),
      },
    },
    async ({ url }) => {
      try {
        const result = await browserManager.newTab(url ? { url } : {});
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "browser_close",
    {
      title: "Close browser",
      description:
        "Close the browser launched by this server. If attached via browser_connect, only disconnects and leaves the user's browser and tabs open.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await browserManager.close();
        return textResult(result);
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
