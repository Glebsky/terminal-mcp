import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, Tray, nativeImage } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ServerManager } from "./server-manager.js";
import { tunnelProviderLabels, type ServerStatus } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isDev = !app.isPackaged && (process.env.NODE_ENV === "development" || !!process.env.VITE_DEV_SERVER_URL);
// dist-desktop/main -> dist-desktop -> projectRoot (2 levels up)
const projectRoot = path.resolve(__dirname, "../..");
const pngIconPath = path.join(projectRoot, "desktop", "icon.png");
const svgIconPath = path.join(projectRoot, "desktop", "icon.svg");
const icoIconPath = path.join(projectRoot, "desktop", "icon.ico");
// Windows gets the .ico: it carries hand-tuned 16-40 px artwork for the window, taskbar and tray.
const appIconPath = process.platform === "win32" && fs.existsSync(icoIconPath)
  ? icoIconPath
  : fs.existsSync(pngIconPath) ? pngIconPath : svgIconPath;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let serverManager: ServerManager | null = null;
let isQuitting = false;
let shutdownInProgress = false;
let shutdownComplete = false;
let hasShownTrayNotification = false;

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  mainWindow.focus();
}

function hideMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();

  if (!hasShownTrayNotification && tray) {
    hasShownTrayNotification = true;
    try {
      tray.displayBalloon({
        title: "MCP Terminal",
        content: "Приложение свернуто в трей и продолжает работать. Кликните по значку в трее, чтобы открыть его.",
      });
    } catch {
      // Ignore balloon errors
    }
  }
  updateTrayMenu(serverManager?.getStatus());
}

function toggleMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isVisible()) {
    if (mainWindow.isFocused()) {
      hideMainWindow();
    } else {
      mainWindow.focus();
    }
  } else {
    showMainWindow();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 740,
    minWidth: 860,
    minHeight: 600,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    titleBarStyle: "hidden",
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });

  // The app window only shows the bundled UI: no pop-ups and no navigation elsewhere.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = isDev
      ? url.startsWith(process.env.VITE_DEV_SERVER_URL || "http://localhost:5173")
      : url.startsWith("file://");
    if (!allowed) event.preventDefault();
  });

  if (isDev) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL || "http://localhost:5173");
  } else {
    const htmlPath = path.join(projectRoot, "dist-renderer", "index.html");
    void mainWindow.loadFile(htmlPath);
  }

  // Intercept window close to minimize to tray instead of quitting
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      hideMainWindow();
      return false;
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.on("show", () => {
    updateTrayMenu(serverManager?.getStatus());
  });

  mainWindow.on("hide", () => {
    updateTrayMenu(serverManager?.getStatus());
  });
}

function updateTrayMenu(status?: ServerStatus) {
  if (!tray) return;

  const currentStatus = status || serverManager?.getStatus();
  const isRunning = currentStatus?.state === "running";
  const isStarting = currentStatus?.state === "starting";
  const isWindowVisible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();

  const statusLabel = isRunning
    ? `Статус: Работает (порт ${currentStatus?.port})`
    : isStarting
      ? "Статус: Запуск сервера..."
      : currentStatus?.state === "error"
        ? "Статус: Ошибка"
        : "Статус: Остановлен";

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: isWindowVisible ? "Скрыть окно в трей" : "Открыть MCP Terminal",
      click: () => {
        if (isWindowVisible) {
          hideMainWindow();
        } else {
          showMainWindow();
        }
      },
    },
    { type: "separator" },
    {
      label: statusLabel,
      enabled: false,
    },
  ];

  template.push({ label: `Tunnel: ${currentStatus ? tunnelProviderLabels[currentStatus.tunnelProvider] : "Local only"} · ${currentStatus?.tunnelState || "disabled"}`, enabled: false });
  if (currentStatus?.state === "running") {
    const host = ["0.0.0.0", "::", "[::]"].includes(currentStatus.host) ? "127.0.0.1" : currentStatus.host;
    const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    const mcpUrl = `${currentStatus.tunnelUrl || `http://${authority}:${currentStatus.port}`}/mcp`;
    template.push({ label: currentStatus.tunnelState === "unverified" ? "Copy MCP URL (unverified)" : "Copy MCP URL", click: () => clipboard.writeText(mcpUrl) });
  }
  if (currentStatus?.tunnelUrl) {
    template.push({
      label: "🌐 Открыть публичный адрес",
      click: () => {
        if (currentStatus.tunnelUrl) void shell.openExternal(currentStatus.tunnelUrl);
      },
    });
  }

  template.push(
    { type: "separator" },
    isRunning
      ? {
          label: "Остановить сервер",
          click: async () => {
            await serverManager?.stop();
          },
        }
      : {
          label: "Запустить сервер",
          enabled: !isStarting,
          click: async () => {
            await serverManager?.start();
          },
        },
    {
      label: "Перезапустить сервер",
      enabled: isRunning && !isStarting,
      click: async () => {
        await serverManager?.restart();
      },
    },
    { type: "separator" },
    {
      label: "Выход из приложения",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  );

  const contextMenu = Menu.buildFromTemplate(template);
  tray.setContextMenu(contextMenu);

  const tooltipText = isRunning
    ? `MCP Terminal — Работает (порт ${currentStatus?.port})`
    : "MCP Terminal — Остановлен";
  tray.setToolTip(tooltipText);
}

function createTray() {
  if (tray) return;

  const trayIcon = nativeImage.createFromPath(appIconPath);
  tray = new Tray(trayIcon);

  tray.on("click", () => {
    toggleMainWindow();
  });

  tray.on("double-click", () => {
    showMainWindow();
  });

  updateTrayMenu();
}

// Use a distinct profile before taking Electron's single-instance lock. This keeps
// the legacy Notion Terminal MCP running independently, with its data untouched.
app.setName("mcp-terminal");
app.setPath("userData", path.join(app.getPath("appData"), "mcp-terminal"));
if (process.platform === "win32") app.setAppUserModelId("com.mcpterminal.desktop");
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(() => {
  let configDir: string;

  if (app.isPackaged) {
    // Portable mode: electron-builder sets PORTABLE_EXECUTABLE_DIR when running as portable exe
    // Use a dedicated portable data directory, even alongside a legacy executable.
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
    if (portableDir) {
      configDir = path.join(portableDir, "MCP Terminal Data");
    } else {
      configDir = path.join(app.getPath("userData"), "config");
    }
  } else {
    // Dev mode — use project root
    configDir = projectRoot;
  }

  serverManager = new ServerManager(projectRoot, configDir);

  createWindow();
  createTray();

  // Setup callbacks from ServerManager to Renderer and Tray
  serverManager.setCallbacks(
    (log) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("log:entry", log);
      }
    },
    (status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("server:status-change", status);
      }
      updateTrayMenu(status);
    },
  );

  serverManager.setMonitorCallback((snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("monitor:snapshot", snapshot);
  });
  ipcMain.handle("monitor:set", (_event, enabled: unknown) => {
    if (typeof enabled === "boolean") serverManager?.setMonitoring(enabled);
  });

  // IPC Handlers
  ipcMain.handle("server:start", async () => {
    return await serverManager?.start();
  });

  ipcMain.handle("server:stop", async () => {
    return await serverManager?.stop();
  });

  ipcMain.handle("server:restart", async () => {
    return await serverManager?.restart();
  });

  ipcMain.handle("server:status", async () => {
    return serverManager?.getStatus();
  });

  ipcMain.handle("config:get", async () => {
    return await serverManager?.getEnvConfig();
  });

  ipcMain.handle("config:save", async (_event, newConfig) => {
    return await serverManager?.saveEnvConfig(newConfig);
  });

  ipcMain.handle("dialog:select-folder", async () => {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
      title: "Select Files Sandbox Root Directory",
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle("token:generate", async () => {
    return crypto.randomBytes(32).toString("hex");
  });

  ipcMain.handle("logs:clear", async () => {
    return;
  });

  // Window Controls & Tray
  ipcMain.on("window:minimize", () => {
    mainWindow?.minimize();
  });

  ipcMain.on("window:maximize", () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.on("window:close", () => {
    mainWindow?.close();
  });

  ipcMain.on("window:hide-to-tray", () => {
    hideMainWindow();
  });

  ipcMain.on("app:quit", () => {
    isQuitting = true;
    app.quit();
  });

  ipcMain.on("shell:open-external", (_event, url) => {
    if (typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"))) {
      void shell.openExternal(url);
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      showMainWindow();
    }
  });
});

app.on("before-quit", (event) => {
  isQuitting = true;
  if (!serverManager || shutdownComplete) return;
  // Electron does not await async event handlers. Hold the quit until the
  // child server has released its port (or the manager's timeout expires).
  event.preventDefault();
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  void serverManager.stop().catch((error) => {
    console.error("Failed to stop MCP server during shutdown:", error);
  }).finally(() => {
    shutdownComplete = true;
    app.quit();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && isQuitting) {
    app.quit();
  }
});
}

