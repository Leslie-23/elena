import type { Interface } from "node:readline/promises";
import { clearLine, cursorTo } from "node:readline";
import { stdout } from "node:process";
import chalk from "chalk";

export type Level = "info" | "ok" | "warn" | "error" | "step";

const STYLE: Record<Level, (s: string) => string> = {
  info: chalk.cyan,
  ok: chalk.green,
  warn: chalk.yellow,
  error: chalk.red,
  step: chalk.dim,
};

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

  attach(rl: Interface) {
    this.rl = rl;
  }

  async ask(prompt: string): Promise<string> {
    if (!this.rl) throw new Error("UI not attached");
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
    } else {
      this.endLine();
      console.log(text);
    }
  }

  /** Stream a piece of Elena's answer. */
  token(text: string) {
    if (!this.midLine) stdout.write(`\n${chalk.magenta("elena ›")} `);
    this.midLine = true;
    stdout.write(text);
  }

  toolCall(name: string, args: Record<string, unknown>) {
    this.endLine();
    console.log(chalk.dim(`  → ${name} ${JSON.stringify(args)}`));
  }

  /** Ends the turn. Prints `answer` only if it wasn't streamed (e.g. the step-limit message). */
  finishTurn(answer: string, seconds: number) {
    const lastWasStreamed = this.midLine;
    this.endLine();
    if (!lastWasStreamed) console.log(`\n${chalk.magenta("elena ›")} ${answer}`);
    console.log(chalk.dim(`  (${seconds.toFixed(1)}s)\n`));
  }

  endLine() {
    if (this.midLine) stdout.write("\n");
    this.midLine = false;
  }
}
