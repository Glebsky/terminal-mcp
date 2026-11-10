// Generates the app icons from the SVG artwork in this folder:
//   icon.svg     detailed artwork, used from 48 px up and for icon.png
//   icon-32.svg  simplified artwork for 24-40 px
//   icon-16.svg  pixel-aligned artwork for 16-20 px
// Output: icon.ico (window, taskbar, tray and .exe icon on Windows) and icon.png (512 px).
// Run with: npm run icons
"use strict";

const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (!app) {
  console.error("Run this script with Electron: npm run icons");
  process.exit(1);
}

const dir = __dirname;
const pngSize = 512;
const icoEntries = [
  [16, "icon-16.svg"],
  [20, "icon-16.svg"],
  [24, "icon-32.svg"],
  [32, "icon-32.svg"],
  [40, "icon-32.svg"],
  [48, "icon.svg"],
  [64, "icon.svg"],
  [128, "icon.svg"],
  [256, "icon.svg"],
];
// Entries up to this size are stored as 32-bit BMP for the widest Windows support; larger ones as PNG.
const maxBmpSize = 64;

// Runs inside the hidden window: draws the SVG at exactly `size` pixels.
async function rasterize(svgText, size, withPixels) {
  const sized = svgText.replace(/<svg\b([^>]*)>/, (match, attrs) =>
    "<svg" + attrs.replace(/\s(width|height)="[^"]*"/g, "") + ' width="' + size + '" height="' + size + '">');
  const image = new Image();
  image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(sized);
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, size, size);
  return {
    png: canvas.toDataURL("image/png").split(",")[1],
    rgba: withPixels ? Array.from(context.getImageData(0, 0, size, size).data) : null,
  };
}

function toBmp(size, rgba) {
  const maskStride = Math.ceil(size / 32) * 4;
  const pixels = Buffer.alloc(size * size * 4);
  const mask = Buffer.alloc(maskStride * size);
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y; // BMP rows are stored bottom-up
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4;
      const to = (row * size + x) * 4;
      pixels[to] = rgba[from + 2];
      pixels[to + 1] = rgba[from + 1];
      pixels[to + 2] = rgba[from];
      pixels[to + 3] = rgba[from + 3];
      if (rgba[from + 3] === 0) mask[row * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // BITMAPINFOHEADER
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // colour bitmap + AND mask
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(pixels.length + mask.length, 20);
  return Buffer.concat([header, pixels, mask]);
}

function toIco(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2); // resource type: icon
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size % 256, entry); // 0 means 256
    header.writeUInt8(size % 256, entry + 1);
    header.writeUInt16LE(1, entry + 4); // colour planes
    header.writeUInt16LE(32, entry + 6); // bits per pixel
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

// Keep Chromium's profile out of %APPDATA% and render on the CPU so the output is reproducible.
app.setPath("userData", path.join(os.tmpdir(), "mcp-terminal-icon-build"));
app.disableHardwareAcceleration();

app
  .whenReady()
  .then(async () => {
    const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
    await win.loadURL("data:text/html,<!doctype html><title>icons</title>");
    const sources = new Map();
    const render = (file, size, withPixels) => {
      if (!sources.has(file)) sources.set(file, fs.readFileSync(path.join(dir, file), "utf8"));
      return win.webContents.executeJavaScript(
        "(" + rasterize + ")(" + JSON.stringify(sources.get(file)) + ", " + size + ", " + withPixels + ")",
      );
    };
    const images = [];
    for (const [size, file] of icoEntries) {
      const asBmp = size <= maxBmpSize;
      const { png, rgba } = await render(file, size, asBmp);
      images.push({ size, data: asBmp ? toBmp(size, rgba) : Buffer.from(png, "base64") });
    }
    fs.writeFileSync(path.join(dir, "icon.ico"), toIco(images));
    const { png } = await render("icon.svg", pngSize, false);
    fs.writeFileSync(path.join(dir, "icon.png"), Buffer.from(png, "base64"));
    console.log("icon.ico: " + icoEntries.map(([size]) => size).join(", ") + " px");
    console.log("icon.png: " + pngSize + " px");
    win.destroy();
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
