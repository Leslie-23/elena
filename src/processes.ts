import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import net from "node:net";
import path from "node:path";
import { SHELL } from "./tools/exec.js";

const MAX_LINES = 1000;
const PORT_WAIT_MS = 90_000;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export interface ManagedProcess {
  name: string;
  command: string;
  cwd: string;
  pid: number;
  port?: number;
  status: "starting" | "running" | "exited";
  exitCode: number | null;
  startedAt: number;
  logFile: string;
  lines: string[];
}

export type Notify = (message: string, level?: "info" | "ok" | "warn") => void;

/** Tries a TCP connect to 127.0.0.1:port. */
export function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    sock.setTimeout(500);
    sock.once("connect", () => (sock.destroy(), resolve(true)));
    sock.once("error", () => resolve(false));
    sock.once("timeout", () => (sock.destroy(), resolve(false)));
  });
}

/**
 * Long-running processes Elena started (dev servers, watchers). Each gets its own
 * process group so stopping it also stops whatever it spawned.
 */
export class ProcessManager {
  private procs = new Map<string, ManagedProcess & { child: ChildProcess; log: WriteStream }>();

  constructor(
    private logDir: string,
    private notify: Notify = () => {},
  ) {}

  start(name: string, command: string, cwd: string, port?: number): ManagedProcess {
    const existing = this.procs.get(name);
    if (existing && existing.status !== "exited") throw new Error(`A process named "${name}" is already running (pid ${existing.pid}).`);

    mkdirSync(this.logDir, { recursive: true });
    const logFile = path.join(this.logDir, `${name.replace(/[^\w.-]/g, "_")}.log`);
    const log = createWriteStream(logFile, { flags: "a" });
    log.write(`\n=== ${new Date().toISOString()} $ ${command}\n`);

    const child = spawn(SHELL, ["-c", command], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    const proc = {
      name, command, cwd, port, child, log, logFile,
      pid: child.pid ?? -1,
      status: "starting" as ManagedProcess["status"],
      exitCode: null as number | null,
      startedAt: Date.now(),
      lines: [] as string[],
    };
    this.procs.set(name, proc);

    let partial = { out: "", err: "" };
    const onData = (stream: "out" | "err") => (chunk: Buffer) => {
      log.write(chunk);
      const text = partial[stream] + chunk.toString().replace(ANSI, "");
      const parts = text.split(/\r?\n/);
      partial[stream] = parts.pop() ?? "";
      proc.lines.push(...parts.map((l) => (stream === "err" ? `[err] ${l}` : l)));
      if (proc.lines.length > MAX_LINES) proc.lines.splice(0, proc.lines.length - MAX_LINES);
    };
    child.stdout!.on("data", onData("out"));
    child.stderr!.on("data", onData("err"));

    child.on("error", (err) => {
      proc.lines.push(`[elena] failed to start: ${err.message}`);
    });
    child.on("close", (code, signal) => {
      for (const s of ["out", "err"] as const) if (partial[s]) proc.lines.push(partial[s]);
      const wasStopped = proc.status === "exited";
      proc.status = "exited";
      proc.exitCode = code;
      log.end(`=== exited code=${code} signal=${signal}\n`);
      if (wasStopped) return;
      if (code === 0) this.notify(`${name} finished (exit 0).`, "info");
      else {
        const tail = crashHint(proc.lines).map((l) => `      ${l}`).join("\n");
        this.notify(`${name} exited with code ${code ?? signal}. /logs ${name} for more.${tail ? "\n" + tail : ""}`, "warn");
      }
    });

    if (port) this.waitForPort(proc, port);
    else proc.status = "running";
    return proc;
  }

  private async waitForPort(proc: ManagedProcess, port: number) {
    const deadline = Date.now() + PORT_WAIT_MS;
    while (Date.now() < deadline && proc.status === "starting") {
      if (await portInUse(port)) {
        proc.status = "running";
        this.notify(`${proc.name} is up on :${port} (${((Date.now() - proc.startedAt) / 1000).toFixed(1)}s).`, "ok");
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (proc.status === "starting") {
      proc.status = "running";
      this.notify(`${proc.name} is running but nothing is listening on :${port} after ${PORT_WAIT_MS / 1000}s. /logs ${proc.name}`, "warn");
    }
  }

  get(name: string): ManagedProcess | undefined {
    return this.procs.get(name);
  }

  list(): ManagedProcess[] {
    return [...this.procs.values()];
  }

  running(): ManagedProcess[] {
    return this.list().filter((p) => p.status !== "exited");
  }

  logs(name: string, count = 50, filter?: string): string {
    const proc = this.procs.get(name);
    if (!proc) throw new Error(`No process named "${name}". Running: ${this.list().map((p) => p.name).join(", ") || "none"}`);
    let lines = proc.lines;
    if (filter) {
      const needle = filter.toLowerCase();
      lines = lines.filter((l) => l.toLowerCase().includes(needle));
    }
    return lines.slice(-count).join("\n") || "(no output yet)";
  }

  /** SIGTERM the whole group, then SIGKILL if it hasn't exited after 3s. */
  async stop(name: string): Promise<boolean> {
    const proc = this.procs.get(name);
    if (!proc || proc.status === "exited") return false;
    proc.status = "exited"; // mark first so the close handler doesn't report a crash
    const exited = new Promise<void>((r) => proc.child.once("close", () => r()));
    const kill = (sig: NodeJS.Signals) => {
      try {
        process.kill(-proc.pid, sig);
      } catch {
        // group already gone
      }
    };
    kill("SIGTERM");
    const timer = setTimeout(() => kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(timer);
    return true;
  }

  async stopAll(): Promise<string[]> {
    const names = this.running().map((p) => p.name);
    await Promise.all(names.map((n) => this.stop(n)));
    return names;
  }
}

/** The most useful line(s) from a crashed process: the last error line, else the last few non-empty lines. */
function crashHint(lines: string[]): string[] {
  const meaningful = lines.filter((l) => l.replace(/^\[err\]/, "").trim() && !/^(\[err\] )?Node\.js v\d/.test(l));
  const error = [...meaningful].reverse().find((l) => /\b(\w*Error|ERR!|Exception|EADDRINUSE|Cannot find|failed)\b/i.test(l));
  return error ? [error.length > 200 ? error.slice(0, 200) + "…" : error] : meaningful.slice(-3);
}

export function describeProcess(p: ManagedProcess): string {
  const age = Math.round((Date.now() - p.startedAt) / 1000);
  const uptime = age < 60 ? `${age}s` : age < 3600 ? `${Math.round(age / 60)}m` : `${(age / 3600).toFixed(1)}h`;
  const state = p.status === "exited" ? `exited (${p.exitCode})` : p.status;
  return `${p.name}  ${state}  pid ${p.pid}${p.port ? `  :${p.port}` : ""}  ${uptime}  $ ${p.command}`;
}
