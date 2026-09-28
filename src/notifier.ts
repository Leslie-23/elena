import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { run } from "./tools/exec.js";

/**
 * Elena.app: a tiny, windowless app in ~/.elena whose only job is posting notifications,
 * so they show Elena's icon and name instead of Script Editor's (what osascript uses).
 * It's built from native/notify.swift the first time it's needed, on Macs with Swift installed.
 */

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(repo, "native", "notify.swift");
const ICON = path.join(repo, "assets", "elena.icns");
export const APP = path.join(config.home, "Elena.app");
const BINARY = path.join(APP, "Contents", "MacOS", "elena-notify");
const BUNDLE_ID = "io.github.leslie23.elena";

/** Changes when the Swift source or the icon changes, so the app is rebuilt after an update. */
function buildId(): string {
  const h = createHash("sha256");
  h.update(readFileSync(SOURCE));
  h.update(readFileSync(ICON));
  return h.digest("hex").slice(0, 12);
}

function infoPlist(version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleName</key><string>Elena</string>
  <key>CFBundleDisplayName</key><string>Elena</string>
  <key>CFBundleExecutable</key><string>elena-notify</string>
  <key>CFBundleIconFile</key><string>elena</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <!-- No Dock icon, no menu bar: it posts a notification and exits. -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
`;
}

export type NotifierState = "ready" | "built" | "unavailable";

let building: Promise<NotifierState> | undefined;

/** Make sure Elena.app exists and is current. Builds it (once, ~10s) if needed. */
export function ensureNotifier(): Promise<NotifierState> {
  return (building ??= (async (): Promise<NotifierState> => {
    if (process.platform !== "darwin" || !existsSync(SOURCE) || !existsSync(ICON)) return "unavailable";
    const version = buildId();
    const plist = path.join(APP, "Contents", "Info.plist");
    if (existsSync(BINARY) && existsSync(plist) && readFileSync(plist, "utf8").includes(`<string>${version}</string>`)) {
      return "ready";
    }
    if (!(await run("swiftc", ["--version"], "/")).ok) return "unavailable";

    rmSync(APP, { recursive: true, force: true });
    mkdirSync(path.join(APP, "Contents", "MacOS"), { recursive: true });
    mkdirSync(path.join(APP, "Contents", "Resources"), { recursive: true });
    const compiled = await run("swiftc", ["-O", "-o", BINARY, SOURCE], "/", 180_000);
    if (!compiled.ok) {
      rmSync(APP, { recursive: true, force: true });
      return "unavailable";
    }
    copyFileSync(ICON, path.join(APP, "Contents", "Resources", "elena.icns"));
    writeFileSync(plist, infoPlist(version));
    // Ad-hoc signature: enough for macOS to let a local app post notifications.
    await run("codesign", ["--force", "--sign", "-", APP], "/");
    // Tell Launch Services about it, so Notification Center picks up the name and icon.
    await run("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", APP], "/");
    return "built";
  })().finally(() => (building = undefined)));
}

/**
 * Post a notification from Elena.app. Resolves false if the app isn't available or notifications
 * for it are turned off, so the caller can fall back to osascript.
 */
export async function notifyViaApp(title: string, body: string, sound: boolean): Promise<boolean> {
  if ((await ensureNotifier()) === "unavailable") return false;
  // Launched through Launch Services (`open`), not by running the binary: macOS only grants
  // notification permission to a real app launch. `open` doesn't return the app's exit code,
  // so the app writes it to a status file. -W waits for it, -g keeps focus where it is,
  // -n allows several at once. The first one waits for the user to answer the permission prompt.
  const statusFile = path.join(tmpdir(), `elena-notify-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await run("open", ["-W", "-g", "-n", APP, "--args", title, body, ...(sound ? ["--sound"] : []), "--status", statusFile], "/", 130_000);
  try {
    return readFileSync(statusFile, "utf8").trim() === "0";
  } catch {
    return false; // no status: the app didn't run
  } finally {
    rmSync(statusFile, { force: true });
  }
}
