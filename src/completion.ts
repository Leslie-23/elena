import type { Interface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { stripVTControlCharacters } from "node:util";
import chalk from "chalk";

/** A slash command, for autocomplete. `args` completes the next word from what's typed so far. */
export interface CommandSpec {
  name: string;
  about: string;
  args?: (words: string[]) => string[];
}

/** The best completion for `line`: the full completed line, plus a short description to show beside it. */
export function suggest(line: string, commands: CommandSpec[]): { completion: string; about?: string } | undefined {
  if (!line.startsWith("/")) return undefined;
  const words = line.split(" ");
  if (words.length === 1) {
    const cmd = commands.find((c) => c.name.startsWith(line) && c.name !== line);
    return cmd ? { completion: cmd.name, about: cmd.about } : undefined;
  }
  const cmd = commands.find((c) => c.name === words[0]);
  if (!cmd?.args) return undefined;
  const partial = words[words.length - 1];
  const option = cmd.args(words.slice(1, -1)).find((o) => o.startsWith(partial) && o !== partial);
  return option ? { completion: [...words.slice(0, -1), option].join(" ") } : undefined;
}

/** Every completion for `line`, for Tab (readline shows the list when there's more than one). */
export function completions(line: string, commands: CommandSpec[]): string[] {
  if (!line.startsWith("/")) return [];
  const words = line.split(" ");
  if (words.length === 1) return commands.filter((c) => c.name.startsWith(line)).map((c) => c.name);
  const cmd = commands.find((c) => c.name === words[0]);
  if (!cmd?.args) return [];
  const partial = words[words.length - 1];
  const head = words.slice(0, -1).join(" ");
  return cmd.args(words.slice(1, -1)).filter((o) => o.startsWith(partial)).map((o) => `${head} ${o}`);
}

/** What to list under the prompt: every match for what's typed, with descriptions for commands. */
export function menuItems(line: string, commands: CommandSpec[]): { label: string; about?: string }[] {
  if (!line.startsWith("/")) return [];
  const words = line.split(" ");
  if (words.length === 1) return commands.filter((c) => c.name.startsWith(line)).map((c) => ({ label: c.name, about: c.about }));
  return completions(line, commands).map((full) => ({ label: full.split(" ").pop() ?? full }));
}

const MAX_ROWS = 12;

/**
 * Slash-command help while typing, like Claude Code's menu and fish's suggestions:
 * - "/" alone lists every command under the prompt;
 * - as you type, the list narrows, the first match is highlighted and shown in grey after the cursor;
 * - → at the end of the line, or Tab, takes it.
 */
export class Autosuggest {
  private ghost = "";
  private menuShown = false;

  constructor(
    private rl: Interface,
    private commands: () => CommandSpec[],
    private active: () => boolean,
  ) {}

  attach() {
    if (!stdout.isTTY) return;
    // Before readline handles a key: wipe the ghost and menu, so readline redraws a clean line.
    stdin.prependListener("keypress", () => this.clear());
    // After it: accept on →, then draw the next suggestion.
    stdin.on("keypress", (_s: string, key: { name?: string } | undefined) => {
      if (!this.active()) return;
      const line = this.line();
      if (key?.name === "right" && this.cursor() === line.length) {
        const s = line === "/" ? undefined : suggest(line, this.commands());
        if (s) this.rl.write(s.completion.slice(line.length));
      }
      setImmediate(() => this.draw());
    });
  }

  /** Readline's current input and cursor (public in practice, not in the typings). */
  private line(): string {
    return (this.rl as unknown as { line: string }).line ?? "";
  }
  private cursor(): number {
    return (this.rl as unknown as { cursor: number }).cursor ?? 0;
  }

  private clear() {
    if (!this.ghost && !this.menuShown) return;
    // We only draw with the cursor at the end of the input, so this erases just our text and the menu below.
    stdout.write("\x1b[0J");
    this.ghost = "";
    this.menuShown = false;
  }

  private draw() {
    if (!this.active()) return;
    const line = this.line();
    if (this.cursor() !== line.length || !line.startsWith("/")) return;
    const commands = this.commands();
    const width = stdout.columns || 80;
    const promptWidth = stripVTControlCharacters(this.rl.getPrompt()).length;
    const col = promptWidth + line.length;

    // "/" alone: no guess, just the full list. Otherwise the first match, in grey.
    const s = line === "/" ? undefined : suggest(line, commands);
    const items = menuItems(line, commands);
    const rows = items.length > 1 ? this.menuRows(items, s?.completion.split(" ").pop(), width) : [];

    if (rows.length) {
      // Make room below without losing our place, then draw the list and come back to the cursor.
      stdout.write("\n".repeat(rows.length) + `\x1b[${rows.length}A` + `\x1b[${col + 1}G`);
      stdout.write("\x1b7" + rows.map((r) => "\n\r\x1b[2K" + r).join("") + "\x1b8");
      this.menuShown = true;
    }
    if (s) {
      const rest = s.completion.slice(line.length);
      const room = width - col - rest.length - 1;
      // With the list showing, the descriptions are already in it.
      const about = !rows.length && s.about && room > 12 ? `  ${s.about.slice(0, room - 2)}` : "";
      this.ghost = rest + about;
      if (this.ghost) stdout.write(chalk.dim(rest) + chalk.dim.italic(about) + `\x1b[${this.ghost.length}D`);
    }
  }

  /** The list, in one or two columns, with the match that → would take highlighted. */
  private menuRows(items: { label: string; about?: string }[], highlight: string | undefined, width: number): string[] {
    const labelWidth = Math.max(...items.map((i) => i.label.length)) + 2;
    const cols = width >= 100 && items.length > 6 ? 2 : 1;
    const colWidth = Math.floor((width - 4) / cols);
    const cell = (i: { label: string; about?: string }) => {
      const about = i.about ? i.about.slice(0, Math.max(0, colWidth - labelWidth - 2)) : "";
      const text = i.label.padEnd(labelWidth) + about;
      const padded = text.padEnd(colWidth);
      if (i.label === highlight) return chalk.green.bold(i.label.padEnd(labelWidth)) + chalk.dim(padded.slice(labelWidth));
      return chalk.cyan(i.label.padEnd(labelWidth)) + chalk.dim(padded.slice(labelWidth));
    };
    const perCol = Math.ceil(items.length / cols);
    const shown = Math.min(perCol, MAX_ROWS);
    const rows: string[] = [];
    for (let r = 0; r < shown; r++) {
      rows.push("  " + Array.from({ length: cols }, (_, c) => items[c * perCol + r]).filter(Boolean).map(cell).join(""));
    }
    const hidden = items.length - shown * cols;
    if (hidden > 0) rows.push(chalk.dim(`  …and ${hidden} more; keep typing to narrow it down`));
    return rows;
  }
}
