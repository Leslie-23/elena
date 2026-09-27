import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appName, formatStatus, isMac, macStatus, setMuted, setVolume } from "../mac.js";
import { defineTool, str } from "./types.js";
import { resolveInRoot, run } from "./exec.js";

const notMac = "This only works on macOS.";
const LOCAL_URL = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/.*)?$/i;

function asUrl(target: string): string | null {
  if (/^https?:\/\//i.test(target)) return target;
  if (LOCAL_URL.test(target)) return `http://${target}`;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(target) && !existsSync(target)) return `https://${target}`; // github.com/x
  return null;
}

export const macOpenTool = defineTool(
  "mac_open",
  "Open something on the Mac: an app ('vscode', 'chrome', 'simulator'), a URL ('localhost:6969/docs', 'https://…'), " +
    "or a file/folder in the project (optionally with a given app, e.g. open the project in VS Code with target '.' and app 'vscode').",
  {
    target: { type: "string", description: "App name, URL, or path relative to the project root", required: true },
    app: { type: "string", description: "App to open the URL or path with (optional)" },
  },
  async (args, ctx) => {
    if (!isMac) return notMac;
    const target = str(args, "target");
    const app = typeof args.app === "string" && args.app.trim() ? appName(args.app) : undefined;
    const withApp = app ? ["-a", app] : [];

    const url = asUrl(target);
    if (url) {
      // Local dev servers open freely; anything on the internet is confirmed, in case a file or log suggested it.
      if (!LOCAL_URL.test(url.replace(/^https?:\/\//, "")) && !(await ctx.confirm(`Open ${url}${app ? ` in ${app}` : ""}?`))) {
        return "User declined.";
      }
      const res = await run("open", [...withApp, url], "/");
      if (!res.ok) return `Couldn't open ${url}: ${res.stderr.trim()}`;
      ctx.notify?.(`↗ Opened ${url}${app ? ` in ${app}` : ""}`);
      return `Opened ${url}.`;
    }

    // A path inside the project?
    const candidate = path.resolve(ctx.root, target);
    if (existsSync(candidate)) {
      const full = await resolveInRoot(ctx.root, target);
      const res = await run("open", [...withApp, full], "/");
      if (!res.ok) return `Couldn't open ${target}: ${res.stderr.trim()}`;
      ctx.notify?.(`↗ Opened ${path.relative(ctx.root, full) || "project folder"}${app ? ` in ${app}` : ""}`);
      return `Opened ${full}${app ? ` with ${app}` : ""}.`;
    }

    // Otherwise it's an app name.
    const name = appName(target);
    const res = await run("open", ["-a", name], "/");
    if (!res.ok) return `No app called "${name}" found. (${res.stderr.trim()})`;
    ctx.notify?.(`↗ Opened ${name}`);
    return `Opened ${name}.`;
  },
);

export const macStatusTool = defineTool(
  "mac_status",
  "Check the Mac's health: battery, free disk, memory, CPU load, volume, uptime and the front app.",
  {},
  async () => (isMac ? formatStatus(await macStatus()) : notMac),
);

export const macControlTool = defineTool(
  "mac_control",
  "Control the Mac. Actions: 'volume' (value 0-100), 'mute', 'unmute', 'screenshot' (saved to the Desktop), 'lock' (locks the screen).",
  {
    action: { type: "string", description: "volume | mute | unmute | screenshot | lock", required: true },
    value: { type: "number", description: "Volume percent, for action 'volume'" },
  },
  async (args, ctx) => {
    if (!isMac) return notMac;
    const action = str(args, "action").toLowerCase();
    switch (action) {
      case "volume": {
        const v = Math.round(Number(args.value));
        if (!Number.isFinite(v) || v < 0 || v > 100) return "Volume must be 0-100.";
        await setVolume(v);
        ctx.notify?.(`🔊 Volume ${v}%`);
        return `Volume set to ${v}%.`;
      }
      case "mute":
      case "unmute":
        await setMuted(action === "mute");
        ctx.notify?.(action === "mute" ? "🔇 Muted" : "🔊 Unmuted");
        return action === "mute" ? "Muted." : "Unmuted.";
      case "screenshot": {
        const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
        const file = path.join(os.homedir(), "Desktop", `Elena screenshot ${stamp}.png`);
        const res = await run("screencapture", ["-x", file], "/");
        if (!res.ok || !existsSync(file)) {
          return "Screenshot failed. The terminal may need Screen Recording permission: System Settings → Privacy & Security → Screen Recording.";
        }
        ctx.notify?.(`📸 Saved ${file}`);
        return `Saved screenshot to ${file}. (You can't see images; tell the user where it is.)`;
      }
      case "lock": {
        if (!(await ctx.confirm("Lock the screen now?"))) return "User declined.";
        await run("pmset", ["displaysleepnow"], "/");
        return "Screen locked (display asleep; it locks if your Mac requires a password on wake).";
      }
      default:
        return `Unknown action "${action}". Use volume, mute, unmute, screenshot or lock.`;
    }
  },
);

export const clipboardTool = defineTool(
  "clipboard",
  "Copy text to the Mac clipboard (action 'copy'), or read what's on it (action 'read', asks the user first).",
  {
    action: { type: "string", description: "copy | read", required: true },
    text: { type: "string", description: "Text to copy, for action 'copy'" },
  },
  async (args, ctx) => {
    if (!isMac) return notMac;
    const action = str(args, "action").toLowerCase();
    if (action === "copy") {
      const text = str(args, "text");
      const { spawn } = await import("node:child_process");
      await new Promise<void>((resolve, reject) => {
        const p = spawn("pbcopy");
        p.on("error", reject);
        p.on("close", () => resolve());
        p.stdin.end(text);
      });
      ctx.notify?.(`📋 Copied ${text.length > 60 ? text.slice(0, 57).replace(/\s+/g, " ") + "…" : text.replace(/\s+/g, " ")}`);
      return "Copied to the clipboard.";
    }
    if (action === "read") {
      // The clipboard often holds passwords or tokens.
      if (!(await ctx.confirm("Let Elena read your clipboard?"))) return "User declined.";
      const res = await run("pbpaste", [], "/");
      return res.stdout || "(clipboard is empty or not text)";
    }
    return `Unknown action "${action}". Use copy or read.`;
  },
);
