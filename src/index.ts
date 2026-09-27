#!/usr/bin/env node
import "./quiet.js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { Agent } from "./agent.js";
import { config } from "./config.js";
import { OllamaLLM } from "./llm.js";
import { MemoryStore, formatMemory } from "./memory/store.js";
import { ProcessManager, describeProcess } from "./processes.js";
import { scanProject } from "./project/scan.js";
import { buildReview, estimateReadSeconds } from "./review.js";
import { run } from "./tools/exec.js";
import { UI } from "./ui.js";

const HELP = `Commands:
  /scan              scan the project in the background (or say "scan the project")
  /project           show the saved project summary
  /review            review uncommitted changes (or say "review my changes")
  /ps                background processes Elena started
  /logs <name> [n]   last n lines from a process (default 40)
  /stop <name>       stop a process
  /memories          what Elena remembers here
  /forget <id>       delete a memory
  /help              this list
  exit               quit (stops Elena's background processes)

From your shell:
  elena [dir]          chat
  elena review [dir]   review uncommitted changes and exit
  elena scan [dir]     scan the project, print the summary and exit`;

// Exact phrases handled directly, without a model call. Anything else goes to Elena, who has tools for both.
const SHORTCUTS: [RegExp, string][] = [
  [/^(re)?scan( (the|this|my) (project|repo|codebase))?[.!]?$/i, "/scan"],
  [/^review( (my|the))?( (changes|diff|code))?[.!]?$/i, "/review"],
];

function parseArgs(argv: string[]): { mode: "chat" | "review" | "scan"; root: string } {
  const mode = argv[0] === "review" || argv[0] === "scan" ? argv.shift()! : "chat";
  return { mode: mode as "chat" | "review" | "scan", root: path.resolve(argv[0] ?? process.cwd()) };
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function ago(sqliteUtc: string): string {
  const s = Math.max(0, (Date.now() - new Date(sqliteUtc.replace(" ", "T") + "Z").getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function preview(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

async function main() {
  const { mode, root } = parseArgs(process.argv.slice(2));
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(chalk.red(`Not a directory: ${root}`));
    process.exit(1);
  }

  const ui = new UI();
  const rl = createInterface({ input: stdin, output: stdout });
  ui.attach(rl);

  const memory = new MemoryStore(config.dbPath);
  const processes = new ProcessManager(path.join(config.logDir, path.basename(root)), (msg, level) => ui.notify(msg, level));
  const confirm = async (q: string) => /^y(es)?$/i.test((await ui.ask(chalk.yellow(`? ${q} [y/N] `))).trim());

  // One scan at a time; the /scan command and the scan_project tool share it.
  let scanning: Promise<string> | undefined;
  const scan = (background = false): Promise<string> => {
    if (scanning) {
      ui.notify("A scan is already running.", "info");
      return scanning;
    }
    ui.notify(
      background ? `🔍 Scanning ${path.basename(root)} in the background. Keep chatting; I'll tell you when it's done.` : `🔍 Scanning ${path.basename(root)}…`,
    );
    scanning = scanProject(root, (step) => ui.notify(`· ${step}`, "step"))
      .then((res) => {
        memory.saveScan(root, res.summary, res.gitHead);
        agent.refreshSystemPrompt();
        ui.notify(`✓ Scan finished in ${(res.ms / 1000).toFixed(1)}s: ${res.headline}. /project to view.`, "ok");
        return res.summary;
      })
      .catch((err) => {
        ui.notify(`Scan failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        throw err;
      })
      .finally(() => (scanning = undefined));
    return scanning;
  };

  const agent = new Agent(
    new OllamaLLM(),
    { root, memory, processes, confirm, notify: (m) => ui.notify(m, "ok"), scan: () => scan(false) },
    {
      onToken: (t) => ui.token(t),
      onThinking: () => ui.notify("💭 thinking…", "step"),
      onToolCall: (name, args) => ui.toolCall(name, args),
      onToolResult: (_name, result) => config.debug && ui.notify(preview(result), "step"),
    },
  );

  let shuttingDown = false;
  async function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    const running = processes.running().map((p) => p.name);
    if (running.length) {
      ui.notify(`Stopping ${running.join(", ")}…`);
      await processes.stopAll();
    }
    rl.close();
    memory.close();
    process.exit(code);
  }
  rl.on("SIGINT", () => void shutdown(130));
  process.on("SIGTERM", () => void shutdown(143));

  async function turn(input: string, opts: { think?: boolean } = {}) {
    const started = Date.now();
    try {
      const answer = await agent.send(input, opts);
      ui.finishTurn(answer, (Date.now() - started) / 1000);
    } catch (err) {
      ui.endLine();
      const msg = err instanceof Error ? err.message : String(err);
      if (/ECONNREFUSED|fetch failed/.test(msg)) ui.notify(`Can't reach Ollama at ${config.host}. Is it running? (brew services start ollama)`, "error");
      else if (/not found/i.test(msg) && msg.includes(config.model)) ui.notify(`Model ${config.model} isn't pulled. Run: ollama pull ${config.model}`, "error");
      else ui.notify(`Error: ${msg}`, "error");
    }
  }

  async function review() {
    ui.notify("🔎 Preparing a review of your uncommitted changes…");
    const input = await buildReview(root, (step) => ui.notify(`· ${step}`, "step"));
    if (typeof input === "string") return ui.notify(input);
    const tokensK = (input.chars / 3.5 / 1000).toFixed(1);
    const skipped = input.skipped.length ? ` Left out for size: ${input.skipped.join(", ")}.` : "";
    ui.notify(
      `Reviewing ${input.files.length} file${input.files.length === 1 ? "" : "s"} (~${tokensK}k tokens; about ${estimateReadSeconds(input.chars)}s to read${config.reviewThink ? ", then it thinks it through, usually under a minute" : ""}).${skipped}`,
    );
    await turn(input.prompt, { think: config.reviewThink });
  }

  /** Returns false if `input` isn't a command. */
  async function command(input: string): Promise<boolean> {
    const [cmd, ...rest] = input.split(/\s+/);
    switch (cmd) {
      case "/scan":
        scan(true).catch(() => {}); // runs in the background; result is reported via notify
        return true;
      case "/project": {
        const s = memory.getScan(root);
        console.log(s ? chalk.dim(`  Scanned ${ago(s.scanned_at)}\n`) + s.summary.replace(/^/gm, "  ") : chalk.dim("  No scan yet. /scan"));
        return true;
      }
      case "/review":
        await review();
        return true;
      case "/ps": {
        const all = processes.list();
        console.log(all.length ? all.map((p) => "  " + describeProcess(p)).join("\n") : chalk.dim("  No background processes."));
        return true;
      }
      case "/logs": {
        try {
          console.log(chalk.dim(processes.logs(rest[0] ?? "", Number(rest[1]) || 40).replace(/^/gm, "  ")));
        } catch (err) {
          ui.notify(err instanceof Error ? err.message : String(err), "error");
        }
        return true;
      }
      case "/stop":
        ui.notify((await processes.stop(rest[0] ?? "")) ? `■ Stopped ${rest[0]}.` : `No running process named "${rest[0] ?? ""}".`);
        return true;
      case "/memories": {
        const all = memory.list(root);
        console.log(all.length ? all.map((m) => "  " + formatMemory(m, root)).join("\n") : chalk.dim("  No memories yet."));
        return true;
      }
      case "/forget": {
        const id = Number(rest[0]);
        ui.notify(Number.isInteger(id) && memory.remove(id) ? `Forgot #${id}.` : `No memory #${rest[0] ?? ""}.`);
        return true;
      }
      case "/help":
        console.log(HELP);
        return true;
      default:
        if (cmd.startsWith("/")) {
          ui.notify(`Unknown command ${cmd}.`, "error");
          console.log(HELP);
          return true;
        }
        return false;
    }
  }

  // One-shot modes from the shell.
  if (mode === "scan") {
    await scan(false).then((s) => console.log("\n" + s), () => {});
    return shutdown(0);
  }
  if (mode === "review") {
    await review();
    return shutdown(0);
  }

  console.log(chalk.bold.magenta("Elena") + chalk.dim(" — local developer assistant"));
  console.log(chalk.dim(`${greeting()}. Project: ${root}  ·  Model: ${config.model}`));
  const saved = memory.getScan(root);
  if (saved) {
    const head = (await run("git", ["rev-parse", "HEAD"], root)).stdout.trim();
    const moved = saved.git_head && head && head !== saved.git_head ? ", new commits since" : "";
    console.log(chalk.dim(`Project scan from ${ago(saved.scanned_at)}${moved} (/scan to refresh).`));
  } else {
    console.log(chalk.dim(`No project scan yet. Type /scan or say "scan the project".`));
  }
  const remembered = memory.list(root).length;
  if (remembered) console.log(chalk.dim(`Remembering ${remembered} thing${remembered === 1 ? "" : "s"} (/memories to see).`));
  console.log(chalk.dim("Type /help for commands, 'exit' to quit.\n"));

  while (true) {
    let input: string;
    try {
      input = (await ui.ask(chalk.cyan("you › "))).trim();
    } catch {
      break; // Ctrl+D / closed stdin
    }
    if (!input) continue;
    if (input === "exit" || input === "quit") break;

    const shortcut = SHORTCUTS.find(([re]) => re.test(input))?.[1];
    if (await command(shortcut ?? input)) continue;
    await turn(input);
  }
  await shutdown(0);
}

main();
