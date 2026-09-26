import { execFile } from "node:child_process";
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
