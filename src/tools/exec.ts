import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

export interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Run a binary with an argv array. No shell, so `;`, `&&`, `$()` and pipes
 * in arguments are inert. Always bounded by a timeout and output cap.
 */
export function run(file: string, args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, timeout: config.commandTimeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : null) : 0;
        resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr || (err && !stdout ? err.message : "")), code });
      },
    );
  });
}

/** zsh on macOS; bash or sh on Linux machines that don't have it. */
export const SHELL = ["/bin/zsh", "/bin/bash", "/bin/sh"].find((s) => existsSync(s)) ?? "/bin/sh";

/**
 * Run a command line through the shell (zsh on macOS). Only for user-approved commands.
 * The command gets its own process group so a timeout kills everything it started,
 * not just the shell (otherwise `npm start` would leave node running).
 */
export function runShell(command: string, cwd: string, timeoutMs: number): Promise<ExecResult & { timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(SHELL, ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const cap = 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => stdout.length < cap && (stdout += d));
    child.stderr.on("data", (d) => stderr.length < cap && (stderr += d));

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // already exited
      }
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, stdout, stderr, code, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: err.message, code: null, timedOut });
    });
  });
}

/** Resolve `p` against root and refuse anything that escapes it (including via symlinks). */
export async function resolveInRoot(root: string, p = "."): Promise<string> {
  const realRoot = await realpath(root);
  const inside = (t: string) => t === realRoot || t.startsWith(realRoot + path.sep);
  // Check the literal path first so we don't reveal whether files outside the root exist.
  if (!inside(path.resolve(realRoot, p))) throw new Error(`Path is outside the project root: ${p}`);
  const target = await realpath(path.resolve(realRoot, p));
  if (!inside(target)) throw new Error(`Path is outside the project root: ${p}`);
  return target;
}

/** Keep the head and tail of long output so the model sees both the start and the end. */
export function truncate(text: string, max = config.maxToolOutput): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const dropped = text.length - max;
  return `${text.slice(0, half)}\n\n... [${dropped} characters truncated] ...\n\n${text.slice(-half)}`;
}

let rgAvailable: boolean | undefined;
export async function hasRipgrep(): Promise<boolean> {
  if (rgAvailable === undefined) rgAvailable = (await run("rg", ["--version"], process.cwd())).ok;
  return rgAvailable;
}
