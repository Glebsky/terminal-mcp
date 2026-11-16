import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { spawn } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { auditLog } from "../utils/logger.js";
import { resolveTarget } from "./filesystem.js";
import { config } from "../config.js";

export interface BrowserOpenOptions {
  url: string;
  headless?: boolean;
  browser?: "chrome" | "edge";
}

export interface BrowserNavigateOptions {
  url: string;
  waitUntil?: "load" | "domcontentloaded" | "networkidle0";
  timeoutMs?: number;
}

export interface BrowserEvaluateOptions {
  script: string;
}

export interface BrowserClickOptions {
  selector: string;
  timeoutMs?: number;
}

export interface BrowserTypeOptions {
  selector: string;
  text: string;
  clear?: boolean;
  timeoutMs?: number;
}

export interface BrowserGetContentOptions {
  type?: "text" | "html" | "title";
  selector?: string;
}

export interface BrowserScreenshotOptions {
  path?: string;
  fullPage?: boolean;
}

export interface ConsoleLogMessage {
  type: string;
  text: string;
}

export interface BrowserConnectOptions {
  endpoint?: string;
  launchIfMissing?: boolean;
  browser?: "chrome" | "edge";
  timeoutMs?: number;
}

export interface BrowserSelectTabOptions {
  index?: number;
  urlContains?: string;
  titleContains?: string;
  bringToFront?: boolean;
}

export interface BrowserNewTabOptions {
  url?: string;
}

export interface BrowserTabInfo {
  index: number;
  url: string;
  title: string;
  active: boolean;
  visible: boolean;
}

const DEFAULT_CDP_ENDPOINT = "http://127.0.0.1:9222";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Resolve with fallback if the promise does not settle within ms (e.g. frozen/discarded background tabs). */
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.catch(() => fallback),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Normalize a Chrome DevTools Protocol endpoint ("9222", "127.0.0.1:9222", "http://...", "ws://...").
 * Only loopback hosts are allowed unless FULL_ACCESS=true.
 */
export function normalizeCdpEndpoint(input: string): string {
  const trimmed = input.trim();
  const candidate = /^\d+$/.test(trimmed)
    ? "http://127.0.0.1:" + trimmed
    : /^[a-z]+:\/\//i.test(trimmed)
      ? trimmed
      : "http://" + trimmed;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Invalid CDP endpoint: " + input);
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
    throw new Error("CDP endpoint must use http(s) or ws(s): " + input);
  }
  if (!config.fullAccess && !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error("Only loopback CDP endpoints (127.0.0.1 / localhost) are allowed unless FULL_ACCESS=true.");
  }
  return parsed.protocol.startsWith("http") ? parsed.href.replace(/\/$/, "") : parsed.href;
}

async function isCdpAvailable(endpoint: string): Promise<boolean> {
  if (endpoint.startsWith("ws")) return true;
  try {
    const res = await fetch(endpoint + "/json/version", { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForCdp(endpoint: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCdpAvailable(endpoint)) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

/**
 * Normalize and validate a browser URL. Only http(s), about:blank and file URLs are
 * allowed; file URLs must point inside FILES_ROOT unless FULL_ACCESS=true.
 */
export function normalizeBrowserUrl(input: string): string {
  const trimmed = input.trim();
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !/^[a-z0-9.-]+:\d+(?:[/?#]|$)/i.test(trimmed);
  const candidate = hasScheme ? trimmed : "http://" + trimmed;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("Invalid URL: " + input);
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.href;
  if (parsed.href === "about:blank") return parsed.href;
  if (parsed.protocol === "file:") {
    resolveTarget(fileURLToPath(parsed)); // Enforces the FILES_ROOT sandbox.
    return parsed.href;
  }
  throw new Error("Unsupported URL scheme \"" + parsed.protocol + "\". Only http, https, file and about:blank are allowed.");
}

export class BrowserManager {
  private browser: Browser | null = null;
  private activePage: Page | null = null;
  private isHeadless: boolean = false;
  private consoleLogs: ConsoleLogMessage[] = [];
  /** "launched" = browser started by this server; "connected" = attached to the user's running browser via CDP. */
  private mode: "launched" | "connected" = "launched";
  private cdpEndpoint: string | null = null;
  private trackedPages = new WeakSet<Page>();

  /**
   * Find the path to Google Chrome or Microsoft Edge on the host system.
   */
  public getBrowserExecutable(preferred: "chrome" | "edge" = "chrome"): string {
    if (process.env.BROWSER_EXECUTABLE_PATH && fsSync.existsSync(process.env.BROWSER_EXECUTABLE_PATH)) {
      return process.env.BROWSER_EXECUTABLE_PATH;
    }
    if (process.env.PUPPETEER_EXECUTABLE_PATH && fsSync.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
      return process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    const localAppData = process.env.LOCALAPPDATA || "";
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

    const chromePaths = [
      path.join(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
      path.join(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
      path.join(localAppData, "Google\\Chrome\\Application\\chrome.exe"),
    ];

    const edgePaths = [
      path.join(programFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
      path.join(programFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
      path.join(localAppData, "Microsoft\\Edge\\Application\\msedge.exe"),
    ];

    const primaryPaths = preferred === "edge" ? edgePaths : chromePaths;
    const secondaryPaths = preferred === "edge" ? chromePaths : edgePaths;

    for (const p of [...primaryPaths, ...secondaryPaths]) {
      if (fsSync.existsSync(p)) {
        return p;
      }
    }

    throw new Error(
      "No supported browser (Google Chrome or Microsoft Edge) found on the host system. " +
      "Please ensure Chrome or Edge is installed or specify BROWSER_EXECUTABLE_PATH."
    );
  }

  /**
   * Ensure browser instance is launched and ready.
   */
  private async ensureBrowser(headless = false, preferred: "chrome" | "edge" = "chrome"): Promise<Browser> {
    // Attached to the user's own browser: reuse it as-is (headless flag does not apply).
    if (this.browser && this.browser.connected && this.mode === "connected") {
      return this.browser;
    }

    // Optional: BROWSER_CDP_URL makes browser tools attach to an existing browser instead of launching one.
    if (!this.browser && process.env.BROWSER_CDP_URL) {
      const attached = await this.attachToCdp(normalizeCdpEndpoint(process.env.BROWSER_CDP_URL), false, preferred, 15_000);
      return attached.browser;
    }

    if (this.browser && this.browser.connected) {
      if (this.isHeadless !== headless) {
        await this.close();
      } else {
        return this.browser;
      }
    }

    const executablePath = this.getBrowserExecutable(preferred);
    this.isHeadless = headless;

    const args = [
      "--disable-dev-shm-usage",
      "--disable-infobars",
      "--disable-blink-features=AutomationControlled",
    ];

    // Keep the Chromium sandbox enabled; it can only be disabled when running as root on Linux.
    if (process.platform === "linux" && typeof process.getuid === "function" && process.getuid() === 0) {
      args.push("--no-sandbox", "--disable-setuid-sandbox");
    }

    if (!headless) {
      args.push("--start-maximized");
    }

    this.browser = await puppeteer.launch({
      executablePath,
      headless,
      defaultViewport: headless ? { width: 1280, height: 800 } : null,
      args,
    });

    this.mode = "launched";
    this.cdpEndpoint = null;
    this.watchDisconnect(this.browser);

    return this.browser;
  }

  private watchDisconnect(browser: Browser) {
    browser.on("disconnected", () => {
      if (this.browser !== browser) return;
      this.browser = null;
      this.activePage = null;
      this.consoleLogs = [];
      this.cdpEndpoint = null;
      this.mode = "launched";
    });
  }

  /**
   * Ensure an active page is available and set up listeners.
   */
  private async ensurePage(headless = false, preferred: "chrome" | "edge" = "chrome"): Promise<Page> {
    const browser = await this.ensureBrowser(headless, preferred);

    if (this.activePage && !this.activePage.isClosed()) {
      return this.activePage;
    }

    const pages = await browser.pages();
    const page =
      (this.mode === "connected" ? await this.findVisiblePage(pages) : undefined) ??
      pages[0] ??
      (await browser.newPage());

    this.setActivePage(page);
    return page;
  }

  /** Attach console/error listeners once per page and make it the target of subsequent browser_* tools. */
  private setActivePage(page: Page) {
    if (this.activePage !== page) this.consoleLogs = [];
    if (!this.trackedPages.has(page)) {
      this.trackedPages.add(page);
      page.on("console", (msg) => {
        if (this.activePage !== page) return;
        this.consoleLogs.push({ type: msg.type(), text: msg.text() });
        if (this.consoleLogs.length > 100) this.consoleLogs.shift();
      });
      page.on("pageerror", (err: unknown) => {
        if (this.activePage !== page) return;
        const text = err instanceof Error ? err.message : String(err);
        this.consoleLogs.push({ type: "error", text });
        if (this.consoleLogs.length > 100) this.consoleLogs.shift();
      });
      page.on("close", () => {
        if (this.activePage === page) {
          this.activePage = null;
        }
      });
    }
    this.activePage = page;
  }

  private pageState(page: Page): Promise<{ visible: boolean; focused: boolean }> {
    return withTimeout(
      page.evaluate(() => ({ visible: document.visibilityState === "visible", focused: document.hasFocus() })),
      1500,
      { visible: false, focused: false },
    );
  }

  /** Pick the tab the user is looking at: focused + visible first, then any visible tab. */
  private async findVisiblePage(pages: Page[]): Promise<Page | undefined> {
    const states = await Promise.all(pages.map((p) => this.pageState(p)));
    let idx = states.findIndex((st) => st.visible && st.focused);
    if (idx < 0) idx = states.findIndex((st) => st.visible);
    return idx >= 0 ? pages[idx] : undefined;
  }

  private async newTabPage(): Promise<Page> {
    const browser = await this.ensureBrowser(this.isHeadless);
    const page = await browser.newPage();
    this.setActivePage(page);
    return page;
  }

  /**
   * Open browser and navigate to the specified URL.
   */
  public async open(options: BrowserOpenOptions) {
    const { url, headless = false, browser = "chrome" } = options;
    await this.ensureBrowser(headless, browser);
    // When attached to the user's browser, never hijack the tab they are using: open a new one.
    const page = this.mode === "connected" ? await this.newTabPage() : await this.ensurePage(headless, browser);

    const fullUrl = normalizeBrowserUrl(url);

    const response = await page.goto(fullUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    const title = await page.title();
    const currentUrl = page.url();

    auditLog("BROWSER_OPEN", { url: fullUrl, headless, title });

    return {
      url: currentUrl,
      title,
      status: response ? response.status() : 200,
      headless,
      message: `Browser opened and navigated to ${currentUrl}`,
    };
  }

  /**
   * Navigate active page to a new URL.
   */
  public async navigate(options: BrowserNavigateOptions) {
    const { url, waitUntil = "load", timeoutMs = 30_000 } = options;
    const page = await this.ensurePage();

    const fullUrl = normalizeBrowserUrl(url);

    const response = await page.goto(fullUrl, {
      waitUntil,
      timeout: timeoutMs,
    });

    const title = await page.title();
    const currentUrl = page.url();

    auditLog("BROWSER_NAVIGATE", { url: fullUrl, title });

    return {
      url: currentUrl,
      title,
      status: response ? response.status() : 200,
    };
  }

  /**
   * Evaluate custom JavaScript in the browser context.
   */
  public async evaluate(options: BrowserEvaluateOptions) {
    const { script } = options;
    const page = await this.ensurePage();

    const result = await page.evaluate(async (code: string) => {
      try {
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const hasReturn = /\breturn\b/.test(code);
        const fn = new AsyncFunction(hasReturn ? code : `return (${code})`);
        const val = await fn();

        if (val === undefined) return null;
        if (typeof val === "object" && val !== null) {
          try {
            return JSON.parse(JSON.stringify(val));
          } catch {
            return String(val);
          }
        }
        return val;
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : String(err));
      }
    }, script);

    auditLog("BROWSER_EVALUATE", {
      scriptSnippet: script.slice(0, 100),
      hasResult: result !== undefined,
    });

    return {
      result,
      url: page.url(),
      title: await page.title(),
    };
  }

  /**
   * Click an element matching a CSS selector.
   */
  public async click(options: BrowserClickOptions) {
    const { selector, timeoutMs = 10_000 } = options;
    const page = await this.ensurePage();

    await page.waitForSelector(selector, { timeout: timeoutMs, visible: true });
    await page.click(selector);

    auditLog("BROWSER_CLICK", { selector });

    return {
      clicked: true,
      selector,
      url: page.url(),
      title: await page.title(),
    };
  }

  /**
   * Type text into an input or textarea element.
   */
  public async type(options: BrowserTypeOptions) {
    const { selector, text, clear = false, timeoutMs = 10_000 } = options;
    const page = await this.ensurePage();

    await page.waitForSelector(selector, { timeout: timeoutMs, visible: true });

    if (clear) {
      await page.click(selector, { count: 3 });
      await page.keyboard.press("Backspace");
    }

    await page.type(selector, text, { delay: 15 });

    auditLog("BROWSER_TYPE", { selector, textLength: text.length });

    return {
      typed: true,
      selector,
      textLength: text.length,
    };
  }

  /**
   * Get page or element text / HTML / title.
   */
  public async getContent(options: BrowserGetContentOptions) {
    const { type = "text", selector } = options;
    const page = await this.ensurePage();

    let content: string;
    if (type === "title") {
      content = await page.title();
    } else if (type === "html") {
      if (selector) {
        await page.waitForSelector(selector, { timeout: 5000 });
        content = await page.$eval(selector, (el) => el.outerHTML);
      } else {
        content = await page.content();
      }
    } else {
      if (selector) {
        await page.waitForSelector(selector, { timeout: 5000 });
        content = await page.$eval(selector, (el) => (el as HTMLElement).innerText || el.textContent || "");
      } else {
        content = await page.evaluate(() => document.body ? document.body.innerText : "");
      }
    }

    const truncated = content.length > config.maxOutputBytes;
    const data = truncated ? content.slice(0, config.maxOutputBytes) : content;

    auditLog("BROWSER_GET_CONTENT", { type, selector, length: data.length, truncated });

    return {
      type,
      selector: selector || (type === "html" ? "html" : "body"),
      content: data,
      length: data.length,
      truncated,
    };
  }

  /**
   * Capture a screenshot of the page and optionally save it to a file.
   */
  public async screenshot(options: BrowserScreenshotOptions) {
    const { path: outputPath, fullPage = false } = options;
    const page = await this.ensurePage();

    const buffer = await page.screenshot({
      fullPage,
      type: "png",
    });

    let savedPath: string | undefined;

    if (outputPath) {
      savedPath = resolveTarget(outputPath);
      await fs.mkdir(path.dirname(savedPath), { recursive: true });
      await fs.writeFile(savedPath, buffer);
    }

    auditLog("BROWSER_SCREENSHOT", {
      savedTo: savedPath,
      fullPage,
      sizeBytes: buffer.length,
    });

    return {
      saved_to: savedPath,
      full_page: fullPage,
      size_bytes: buffer.length,
      encoding: "image/png",
      base64: savedPath ? undefined : Buffer.from(buffer).toString("base64"),
    };
  }

  /**
   * Attach to an already running Chrome/Edge via the DevTools protocol (remote debugging port).
   */
  public async connect(options: BrowserConnectOptions = {}) {
    const endpoint = normalizeCdpEndpoint(options.endpoint || process.env.BROWSER_CDP_URL || DEFAULT_CDP_ENDPOINT);
    const { browser, launched } = await this.attachToCdp(
      endpoint,
      options.launchIfMissing ?? false,
      options.browser ?? "chrome",
      options.timeoutMs ?? 20_000,
    );
    const version = await browser.version();
    const pages = await browser.pages();
    const visible = await this.findVisiblePage(pages);
    if (visible) this.setActivePage(visible);
    const { tabs } = await this.listTabs();

    auditLog("BROWSER_CONNECT", { endpoint, launched, version, tabs: tabs.length });

    return {
      connected: true,
      endpoint,
      launched,
      version,
      active_tab: tabs.find((t) => t.active) ?? null,
      tabs,
      message: launched
        ? "Started a browser with remote debugging and connected to it. Log in to sites in this window once; the profile is persistent."
        : "Connected to the running browser. Use browser_select_tab to choose which tab other browser_* tools work with.",
    };
  }

  private async attachToCdp(
    endpoint: string,
    launchIfMissing: boolean,
    preferred: "chrome" | "edge",
    timeoutMs: number,
  ): Promise<{ browser: Browser; launched: boolean }> {
    if (this.browser) await this.close();

    let launched = false;
    if (!(await isCdpAvailable(endpoint))) {
      if (!launchIfMissing) {
        throw new Error(
          "No browser with remote debugging found at " + endpoint + ". " +
          "Start Chrome with --remote-debugging-port=9222 --user-data-dir=<profile dir> " +
          "(Chrome 136+ ignores the debugging port for the default profile), " +
          "or call browser_connect with launch_if_missing=true.",
        );
      }
      this.launchDebugBrowser(endpoint, preferred);
      launched = true;
      if (!(await waitForCdp(endpoint, timeoutMs))) {
        throw new Error(
          "Browser was started but " + endpoint + " did not respond within " + timeoutMs + " ms. " +
          "If this profile is already open in a window without remote debugging, close that window and retry.",
        );
      }
    }

    const browser = endpoint.startsWith("ws")
      ? await puppeteer.connect({ browserWSEndpoint: endpoint, defaultViewport: null })
      : await puppeteer.connect({ browserURL: endpoint, defaultViewport: null });

    this.browser = browser;
    this.mode = "connected";
    this.cdpEndpoint = endpoint;
    this.isHeadless = false;
    this.activePage = null;
    this.consoleLogs = [];
    this.watchDisconnect(browser);

    return { browser, launched };
  }

  /** Start a detached browser with a debugging port and a persistent profile; it keeps running after the server exits. */
  private launchDebugBrowser(endpoint: string, preferred: "chrome" | "edge") {
    const url = new URL(endpoint);
    if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
      throw new Error("launch_if_missing works only with a local endpoint (127.0.0.1 / localhost).");
    }
    const port = url.port || "9222";
    const executablePath = this.getBrowserExecutable(preferred);
    const profileDir =
      process.env.BROWSER_DEBUG_PROFILE_DIR ||
      path.join(process.env.LOCALAPPDATA || os.homedir(), "terminal-mcp", "browser-profile");
    fsSync.mkdirSync(profileDir, { recursive: true });

    const child = spawn(
      executablePath,
      [
        "--remote-debugging-port=" + port,
        "--user-data-dir=" + profileDir,
        "--no-first-run",
        "--no-default-browser-check",
        "--start-maximized",
      ],
      { detached: true, stdio: "ignore" },
    );
    child.on("error", () => {});
    child.unref();

    auditLog("BROWSER_LAUNCH_DEBUG", { executablePath, port, profileDir });
  }

  private async requireBrowser(): Promise<Browser> {
    if (this.browser && this.browser.connected) return this.browser;
    if (process.env.BROWSER_CDP_URL) return this.ensureBrowser();
    throw new Error("No browser session. Call browser_connect to attach to your running browser, or browser_open to launch one.");
  }

  /**
   * List open tabs of the current browser session.
   */
  public async listTabs(): Promise<{ mode: "launched" | "connected"; endpoint: string | null; count: number; tabs: BrowserTabInfo[] }> {
    const browser = await this.requireBrowser();
    const pages = await browser.pages();
    const tabs = await Promise.all(
      pages.map(async (page, index) => {
        const [title, state] = await Promise.all([withTimeout(page.title(), 1500, ""), this.pageState(page)]);
        return { index, url: page.url(), title, active: page === this.activePage, visible: state.visible };
      }),
    );
    return { mode: this.mode, endpoint: this.cdpEndpoint, count: tabs.length, tabs };
  }

  /**
   * Make a tab the target of browser_get_content / evaluate / click / type / screenshot.
   */
  public async selectTab(options: BrowserSelectTabOptions) {
    const { index, urlContains, titleContains, bringToFront = false } = options;
    const browser = await this.requireBrowser();
    const pages = await browser.pages();

    let page: Page | undefined;
    if (index !== undefined) {
      page = pages[index];
    } else if (urlContains || titleContains) {
      const urlNeedle = urlContains?.toLowerCase();
      const titleNeedle = titleContains?.toLowerCase();
      for (const candidate of pages) {
        if (urlNeedle && !candidate.url().toLowerCase().includes(urlNeedle)) continue;
        if (titleNeedle && !(await withTimeout(candidate.title(), 1500, "")).toLowerCase().includes(titleNeedle)) continue;
        page = candidate;
        break;
      }
    } else {
      page = await this.findVisiblePage(pages);
    }

    if (!page) throw new Error("Tab not found. Call browser_list_tabs to see available tabs.");

    this.setActivePage(page);
    if (bringToFront) await page.bringToFront();

    const title = await withTimeout(page.title(), 1500, "");
    const selectedIndex = pages.indexOf(page);
    auditLog("BROWSER_SELECT_TAB", { index: selectedIndex, url: page.url() });

    return { index: selectedIndex, url: page.url(), title, message: "Active tab: " + (title || page.url()) };
  }

  /**
   * Open a new tab (optionally navigating to a URL) and make it active.
   */
  public async newTab(options: BrowserNewTabOptions = {}) {
    const page = await this.newTabPage();
    let status: number | null = null;
    if (options.url) {
      const response = await page.goto(normalizeBrowserUrl(options.url), { waitUntil: "domcontentloaded", timeout: 30_000 });
      status = response ? response.status() : null;
    }
    await page.bringToFront().catch(() => {});
    const title = await withTimeout(page.title(), 1500, "");
    auditLog("BROWSER_NEW_TAB", { url: page.url() });
    return { url: page.url(), title, status };
  }

  /**
   * Retrieve recent console and error logs emitted by the page.
   */
  public getConsoleLogs(): ConsoleLogMessage[] {
    return [...this.consoleLogs];
  }

  /**
   * Close the browser instance.
   */
  public async close() {
    if (this.browser && this.mode === "connected") {
      const browser = this.browser;
      const endpoint = this.cdpEndpoint;
      this.browser = null;
      this.activePage = null;
      this.consoleLogs = [];
      this.cdpEndpoint = null;
      this.mode = "launched";
      try {
        await browser.disconnect();
      } catch {}
      auditLog("BROWSER_DISCONNECT", { endpoint });
      return {
        closed: false,
        disconnected: true,
        message: "Disconnected from your browser. It keeps running with all tabs open.",
      };
    }

    if (this.browser) {
      try {
        await this.browser.close();
      } catch {}
      this.browser = null;
      this.activePage = null;
      this.consoleLogs = [];
      auditLog("BROWSER_CLOSE", {});
    }

    return {
      closed: true,
      message: "Browser closed successfully",
    };
  }
}

export const browserManager = new BrowserManager();

// Automatically close browser on process termination
process.on("beforeExit", () => {
  void browserManager.close();
});
process.on("SIGINT", () => {
  void browserManager.close();
});
process.on("SIGTERM", () => {
  void browserManager.close();
});
