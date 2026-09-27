import { run } from "./tools/exec.js";

export const isMac = process.platform === "darwin";

/** osascript with arguments passed as argv, so text is never interpreted as AppleScript. */
function osascript(lines: string[], args: string[] = []) {
  return run("osascript", [...lines.flatMap((l) => ["-e", l]), ...args], process.cwd());
}

export interface MacStatus {
  battery?: { percent: number; charging: boolean; remaining?: string };
  diskFreeGB: number;
  diskTotalGB: number;
  memoryFreePct?: number;
  load1: number;
  cpus: number;
  uptime?: string;
  volume?: number;
  muted?: boolean;
  frontApp?: string;
}

export async function macStatus(): Promise<MacStatus> {
  const [batt, df, load, cpus, mem, vol, boot, front] = await Promise.all([
    run("pmset", ["-g", "batt"], "/"),
    run("df", ["-k", "/"], "/"),
    run("sysctl", ["-n", "vm.loadavg"], "/"),
    run("sysctl", ["-n", "hw.ncpu"], "/"),
    run("memory_pressure", ["-Q"], "/"),
    osascript(["set s to get volume settings", 'return (output volume of s as text) & "," & (output muted of s as text)']),
    run("sysctl", ["-n", "kern.boottime"], "/"),
    frontmostApp(),
  ]);

  const status: MacStatus = { diskFreeGB: 0, diskTotalGB: 0, load1: 0, cpus: Number(cpus.stdout.trim()) || 1 };

  const b = batt.stdout.match(/(\d+)%;\s*([\w ]+);\s*([\d:]+ remaining|\(no estimate\))?/);
  if (b) {
    status.battery = {
      percent: Number(b[1]),
      charging: !/discharging/.test(b[2]) && /charg|charged|finishing/.test(b[2] + batt.stdout),
      remaining: b[3]?.includes("remaining") ? b[3].replace(" remaining", "") : undefined,
    };
    if (/AC Power/.test(batt.stdout)) status.battery.charging = true;
  }

  const d = df.stdout.trim().split("\n")[1]?.split(/\s+/);
  if (d) {
    status.diskTotalGB = (Number(d[1]) * 1024) / 1e9;
    status.diskFreeGB = (Number(d[3]) * 1024) / 1e9;
  }
  status.load1 = Number(load.stdout.match(/[\d.]+/)?.[0] ?? 0);
  const m = mem.stdout.match(/free percentage:\s*(\d+)%/);
  if (m) status.memoryFreePct = Number(m[1]);

  const [v, muted] = vol.stdout.trim().split(",");
  if (v && v !== "missing value") status.volume = Number(v);
  if (muted) status.muted = muted === "true";

  const bootSec = Number(boot.stdout.match(/sec = (\d+)/)?.[1]);
  if (bootSec) {
    const h = (Date.now() / 1000 - bootSec) / 3600;
    status.uptime = h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)} days`;
  }
  status.frontApp = front?.name;
  return status;
}

/** One line for the startup banner, with a warning flag if something needs attention. */
export function statusLine(s: MacStatus): { text: string; warn: boolean } {
  const parts: string[] = [];
  let warn = false;
  if (s.battery) {
    const low = !s.battery.charging && s.battery.percent <= 20;
    warn ||= low;
    parts.push(
      `battery ${s.battery.percent}%${s.battery.charging ? " charging" : s.battery.remaining ? ` (${s.battery.remaining} left)` : ""}${low ? " ⚠" : ""}`,
    );
  }
  const diskLow = s.diskFreeGB < 15;
  warn ||= diskLow;
  parts.push(`${Math.round(s.diskFreeGB)} GB free${diskLow ? " ⚠" : ""}`);
  if (s.memoryFreePct !== undefined) {
    const memLow = s.memoryFreePct < 10;
    warn ||= memLow;
    parts.push(`memory ${s.memoryFreePct}% free${memLow ? " ⚠" : ""}`);
  }
  const busy = s.load1 > s.cpus;
  parts.push(`load ${s.load1.toFixed(1)}/${s.cpus} cores${busy ? " ⚠" : ""}`);
  warn ||= busy;
  return { text: parts.join(" · "), warn };
}

export function formatStatus(s: MacStatus): string {
  const lines = [statusLine(s).text.replace(/ · /g, "\n")];
  if (s.volume !== undefined) lines.push(`volume ${s.volume}%${s.muted ? " (muted)" : ""}`);
  if (s.uptime) lines.push(`up ${s.uptime}`);
  if (s.frontApp) lines.push(`front app: ${s.frontApp}`);
  return lines.join("\n");
}

export async function frontmostApp(): Promise<{ name?: string; bundleId?: string } | undefined> {
  if (!isMac) return undefined;
  const asn = (await run("lsappinfo", ["front"], "/")).stdout.trim();
  if (!asn) return undefined;
  const info = (await run("lsappinfo", ["info", "-only", "bundleid", "-only", "name", asn], "/")).stdout;
  return {
    bundleId: info.match(/"CFBundleIdentifier"="([^"]+)"/)?.[1],
    name: info.match(/"LSDisplayName"="([^"]+)"/)?.[1],
  };
}

/**
 * True if the terminal Elena runs in is the front app. The terminal's bundle id comes from
 * __CFBundleIdentifier, which Terminal, iTerm, VS Code and others set. Undefined if unknown.
 */
export async function terminalIsFrontmost(): Promise<boolean | undefined> {
  const mine = process.env.__CFBundleIdentifier;
  if (!isMac || !mine) return undefined;
  const front = await frontmostApp();
  return front?.bundleId ? front.bundleId === mine : undefined;
}

export async function showNotification(title: string, body: string, sound?: string) {
  if (!isMac) return;
  await osascript(
    [
      "on run argv",
      sound
        ? "display notification (item 2 of argv) with title (item 1 of argv) sound name (item 3 of argv)"
        : "display notification (item 2 of argv) with title (item 1 of argv)",
      "end run",
    ],
    [title, body.slice(0, 200), ...(sound ? [sound] : [])],
  );
}

export async function setVolume(percent: number) {
  return osascript(["on run argv", "set volume output volume (item 1 of argv as integer)", "end run"], [String(percent)]);
}

export async function setMuted(muted: boolean) {
  return osascript([`set volume output muted ${muted ? "true" : "false"}`]);
}

// Friendly names models (and people) use → the app's real name.
const APP_ALIASES: Record<string, string> = {
  vscode: "Visual Studio Code", code: "Visual Studio Code", "vs code": "Visual Studio Code",
  chrome: "Google Chrome", "google chrome": "Google Chrome", safari: "Safari", firefox: "Firefox",
  arc: "Arc", terminal: "Terminal", iterm: "iTerm", iterm2: "iTerm", finder: "Finder",
  xcode: "Xcode", simulator: "Simulator", "ios simulator": "Simulator", "android studio": "Android Studio",
  slack: "Slack", postman: "Postman", docker: "Docker", "activity monitor": "Activity Monitor",
  notes: "Notes", mail: "Mail", calendar: "Calendar", music: "Music", spotify: "Spotify", cursor: "Cursor",
};

export function appName(name: string): string {
  return APP_ALIASES[name.trim().toLowerCase()] ?? name.trim();
}
