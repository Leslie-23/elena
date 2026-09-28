import type { Interface } from "node:readline/promises";
import { clearLine, cursorTo } from "node:readline";
import { stdout } from "node:process";
import chalk from "chalk";
import { green } from "./brand.js";

export type Level = "info" | "ok" | "warn" | "error" | "step";

const STYLE: Record<Level, (s: string) => string> = {
  info: chalk.cyan,
  ok: chalk.green,
  warn: chalk.yellow,
  error: chalk.red,
  step: chalk.dim,
};

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const clip = (s: string, n = 40) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** What Elena is doing while a tool runs, in words: "Searching for “calculateFare”". */
export function activityFor(name: string, args: Record<string, unknown>): string {
  const a = (k: string) => (typeof args[k] === "string" || typeof args[k] === "number" ? String(args[k]) : "");
  switch (name) {
    case "read_file": return `Reading ${clip(a("path"))}`;
    case "list_directory": return `Looking in ${clip(a("path") || ".")}`;
    case "search": return `Searching for “${clip(a("pattern"), 30)}”`;
    case "git_status": case "git_diff": case "git_log": return "Checking git";
    case "port_owner": return `Checking port ${a("port")}`;
    case "listening_ports": return "Checking which ports are in use";
    case "calculate": return "Calculating";
    case "run_command": return `Running ${clip(a("command"))}`;
    case "start_process": return `Starting ${a("name")}`;
    case "process_logs": return `Reading ${a("name")}'s logs`;
    case "stop_process": return `Stopping ${a("name")}`;
    case "scan_project": return "Scanning the project";
    case "delegate": return "A subagent is investigating";
    case "ask_expert": return "Handing off to a cloud agent";
    case "remember": case "recall": case "forget": return "Checking memory";
    case "mac_open": return `Opening ${clip(a("target"))}`;
    case "mac_status": return "Checking the Mac";
    default: return `Using ${name}`;
  }
}

/**
 * Terminal output that works while background tasks are running:
 * messages that arrive while the user is typing are printed above the prompt,
 * and the prompt (with what they've typed so far) is redrawn underneath.
 */
export class UI {
  private rl?: Interface;
  private waitingForInput = false;
  /** True while answer text is being streamed mid-line. */
  private midLine = false;
  /** The animated "⠹ Thinking… 4s" line, while Elena is busy and not yet writing. */
  private spin?: { label: string; since: number; frame: number; timer: NodeJS.Timeout };

  attach(rl: Interface) {
    this.rl = rl;
  }

  get isWaitingForInput(): boolean {
    return this.waitingForInput;
  }

  /** Something to show at the end of the status line, e.g. the context bar. */
  statusSuffix?: () => string;

  async ask(prompt: string): Promise<string> {
    if (!this.rl) throw new Error("UI not attached");
    this.stopStatus(); // an approval prompt replaces the spinner
    this.endLine();
    this.waitingForInput = true;
    try {
      return await this.rl.question(prompt);
    } finally {
      this.waitingForInput = false;
    }
  }

  /** Print a status line. Safe to call at any time, from any background task. */
  notify(message: string, level: Level = "info") {
    const text = message
      .split("\n")
      .map((l, i) => (i === 0 ? STYLE[level](`  ${l}`) : chalk.dim(l)))
      .join("\n");
    if (this.waitingForInput && this.rl && stdout.isTTY) {
      clearLine(stdout, 0);
      cursorTo(stdout, 0);
      stdout.write(text + "\n");
      this.rl.prompt(true); // redraw the prompt and whatever the user had typed
    } else if (this.spin) {
      // Print above the spinner, then draw it again underneath.
      stdout.write("\r\x1b[2K" + text + "\n");
      this.renderStatus();
    } else {
      this.endLine();
      console.log(text);
    }
  }

  /**
   * Show (or update) the animated status line: what Elena is doing, and for how long.
   * Only on a real terminal; `fallback` is printed once instead when output is piped.
   */
  status(label: string, fallback?: string) {
    if (!stdout.isTTY) {
      if (fallback) this.notify(fallback, "step");
      return;
    }
    this.endLine();
    if (this.spin) {
      if (this.spin.label !== label) Object.assign(this.spin, { label, since: Date.now() });
      return;
    }
    this.spin = { label, since: Date.now(), frame: 0, timer: setInterval(() => this.renderStatus(), 90) };
    this.spin.timer.unref?.();
    this.renderStatus();
  }

  stopStatus() {
    if (!this.spin) return;
    clearInterval(this.spin.timer);
    this.spin = undefined;
    stdout.write("\r\x1b[2K");
  }

  private renderStatus() {
    if (!this.spin) return;
    const s = this.spin;
    const secs = Math.floor((Date.now() - s.since) / 1000);
    const frame = FRAMES[s.frame++ % FRAMES.length];
    const suffix = this.statusSuffix ? `  ${this.statusSuffix()}` : "";
    const line = `${chalk.cyan(frame)} ${chalk.dim(`${s.label}…${secs >= 1 ? ` ${secs}s` : ""}`)}${suffix}`;
    stdout.write("\r\x1b[2K" + line);
  }

  /** Stream a piece of Elena's answer. */
  token(text: string) {
    this.stopStatus();
    if (!this.midLine) stdout.write(`\n${green.bold("elena ›")} `);
    this.midLine = true;
    stdout.write(text);
  }

  /** A tool call starts: log it, and say what's happening while it runs. */
  toolCall(name: string, args: Record<string, unknown>) {
    this.stopStatus();
    this.endLine();
    console.log(chalk.dim(`  → ${name} ${JSON.stringify(args)}`));
    this.status(activityFor(name, args));
  }

  /** Ends the turn. Prints `answer` only if it wasn't streamed (e.g. the step-limit message). */
  finishTurn(answer: string, seconds: number, model?: string, extra?: string) {
    this.stopStatus();
    const lastWasStreamed = this.midLine;
    this.endLine();
    if (!lastWasStreamed) console.log(`\n${green.bold("elena ›")} ${answer}`);
    console.log(chalk.dim(`  (${seconds.toFixed(1)}s${model ? ` · ${model}` : ""}`) + (extra ? chalk.dim(" · ") + extra : "") + chalk.dim(")") + "\n");
  }

  endLine() {
    if (this.midLine) stdout.write("\n");
    this.midLine = false;
  }
}
