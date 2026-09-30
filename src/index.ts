#!/usr/bin/env node
import "./quiet.js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync, readFileSync, statSync, watch } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import path from "node:path";
import chalk from "chalk";
import { Agent } from "./agent.js";
import { config } from "./config.js";
import { OllamaLLM, ollama } from "./llm.js";
import { MemoryStore, formatMemory } from "./memory/store.js";
import {
  KNOWN_MODELS,
  ModelRouter,
  TASKS,
  TASK_LABELS,
  classify,
  looksHeavy,
  normalize,
  type Task,
} from "./models.js";
import { ProcessManager, describeProcess } from "./processes.js";
import { scanProject } from "./project/scan.js";
import { buildReview, estimateReadSeconds } from "./review.js";
import { run } from "./tools/exec.js";
import { UI } from "./ui.js";
import { Autosuggest, completions, type CommandSpec } from "./completion.js";
import { banner, tagline } from "./brand.js";
import { ensureNotifier } from "./notifier.js";
import { SubagentManager } from "./subagents.js";
import { Escalation } from "./escalate.js";
import { EXPERTS, EXPERT_LABELS, type ExpertName } from "./experts.js";
import type { ToolContext } from "./tools/types.js";
import { fitHistory, titleFrom } from "./conversations.js";
import {
  formatStatus,
  isMac,
  macStatus,
  showNotification,
  statusLine,
  terminalIsFrontmost,
} from "./mac.js";

const HELP = `Commands:
  /scan              scan the project in the background (or say "scan the project")
  /project           show the saved project summary
  /review            review uncommitted changes (or say "review my changes")
  /model             installed models and which one each task uses
  /model <name>      use one model for everything
  /model <task> <m>  use a model for one task (chat, code, review)
  /model auto        let Elena pick per task again
  /pull <name>       download a model in the background
  /ps                background processes Elena started
  /logs <name> [n]   last n lines from a process (default 40)
  /stop <name>       stop a process
  /claude <task>     hand a heavy task to Claude Code (read-only, background)
  /claude edit <t>   same, but it may edit files (asks first)
  /claude reply <m>  follow up in the latest Claude session (reply #n for task n's)
  /codex <task>      same with Codex; /codex edit <task> to allow edits
  /experts           which cloud agents are installed and signed in
  /review claude     review uncommitted changes with Claude (or codex)
  /bg <task>         send a read-only subagent to investigate in the background
  /tasks             background tasks and their status
  /result <n>        read a background task's report
  /cancel <n>        stop a running background task
  /resume            recent conversations in this project
  /resume <n>|last   pick up a conversation where you left off
  /new               start a fresh conversation
  /context           what's filling Elena's context window
  /compact           trim old tool output and summarise older messages to free up context
  /reload            restart Elena with her latest code, keeping this conversation
  /mac               Mac health: battery, disk, memory, load, volume
  /memories          what Elena remembers here
  /forget <id>       delete a memory
  /help              this list
  exit               quit (stops Elena's background processes)

From your shell:
  elena [dir]          chat
  elena review [dir]   review uncommitted changes and exit
  elena scan [dir]     scan the project, print the summary and exit
  elena setup          check this machine and connect Elena to Claude Code / Codex
  elena mcp [dir]      run as an MCP server (what Claude Code and Codex launch)`;

// Exact phrases handled directly, without a model call. Anything else goes to Elena, who has tools for both.
const SHORTCUTS: [RegExp, string][] = [
  [/^(re)?scan( (the|this|my) (project|repo|codebase))?[.!]?$/i, "/scan"],
  [/^review( (my|the))?( (changes|diff|code))?[.!]?$/i, "/review"],
];

const USAGE = `Usage:
  elena [dir]          chat about a project (default: the current folder)
  elena review [dir]   review uncommitted changes and exit
  elena scan [dir]     scan the project, print the summary and exit
  elena setup          check Ollama and a model; connect Elena to Claude Code / Codex
  elena mcp [dir]      run as an MCP server (what Claude Code and Codex launch)
  elena update         update Elena to the latest version
  elena --version      print the version

Inside Elena, type /help for commands.`;

function version(): string {
  return (
    createRequire(import.meta.url)("../package.json") as { version: string }
  ).version;
}

/** `elena update`: pull the latest code and rebuild, in the folder Elena runs from. */
function runUpdate() {
  const app =
    process.env.ELENA_APP_DIR ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const step = (cmd: string, args: string[]) => {
    console.log(chalk.dim(`$ ${cmd} ${args.join(" ")}`));
    const r = spawnSync(cmd, args, { cwd: app, stdio: "inherit" });
    if (r.status !== 0) {
      console.error(
        chalk.red(
          `\n${cmd} failed. Nothing else was changed; fix the above and run \`elena update\` again.`,
        ),
      );
      process.exit(r.status ?? 1);
    }
  };
  const before = version();
  step("git", ["pull", "--ff-only"]);
  step("npm", ["install", "--no-fund", "--no-audit", "--loglevel=error"]);
  const after = (
    JSON.parse(readFileSync(path.join(app, "package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  console.log(
    chalk.green(
      `\n✓ Elena ${before === after ? `is up to date (${after})` : `updated ${before} → ${after}`}.`,
    ),
  );
}

type Mode = "chat" | "review" | "scan" | "mcp" | "setup";
const MODES = ["review", "scan", "mcp", "setup"];

function parseArgs(argv: string[]): { mode: Mode; root: string } {
  const mode = MODES.includes(argv[0]) ? (argv.shift() as Mode) : "chat";
  return { mode, root: path.resolve(argv[0] ?? process.cwd()) };
}

/** Short startup summary of commands and what Elena can do. /help has the full list. */
function cheatSheet(): string {
  const cmds: [string, string][] = [
    ["/scan", "scan"],
    ["/project", "summary"],
    ["/review", "review diff"],
    ["/model", "models"],
    ["/ps", "processes"],
    ["/logs <name>", "output"],
    ["/stop <name>", "stop one"],
    ["/claude", "cloud agent"],
    ["/codex", "cloud agent"],
    ["/bg <task>", "background"],
    ["/tasks", "bg tasks"],
    ["/result <n>", "bg report"],
    ["/resume", "past chats"],
    ["/new", "fresh chat"],
    ["/context", "context use"],
    ["/compact", "free context"],
    ["/reload", "new code"],
    ["/mac", "mac health"],
    ["/memories", "notes"],
    ["/forget <id>", "delete note"],
    ["/help", "full list"],
  ];
  // Three columns need ~85 chars; fall back to two on narrow terminals.
  const perRow = (stdout.columns ?? 100) >= 88 ? 3 : 2;
  const rows: string[] = [];
  for (let i = 0; i < cmds.length; i += perRow) {
    rows.push(
      cmds
        .slice(i, i + perRow)
        .map(([c, d]) => chalk.cyan(c.padEnd(13)) + chalk.dim(d.padEnd(13)))
        .join("")
        .trimEnd(),
    );
  }
  const tools = [
    "read & search files",
    "git status/diff/log",
    "check ports",
    "subagents",
    "Claude/Codex*",
    "run commands*",
    "start/stop servers*",
    "remember things",
    "open apps & URLs",
    "volume · clipboard · screenshot",
    "lock screen*",
  ];
  const label = (s: string) => chalk.bold(s.padEnd(10));
  return [
    label("Commands") + rows[0],
    ...rows.slice(1).map((r) => " ".repeat(10) + r),
    label("Tools") + chalk.dim(tools.slice(0, 4).join(" · ")),
    " ".repeat(10) +
      chalk.dim(tools.slice(4, 7).join(" · ") + "  ") +
      chalk.yellow("*asks first"),
    " ".repeat(10) + chalk.dim(tools.slice(7, 9).join(" · ")),
    " ".repeat(10) + chalk.dim(tools.slice(9).join(" · ")),
  ].join("\n");
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function ago(sqliteUtc: string): string {
  const s = Math.max(
    0,
    (Date.now() - new Date(sqliteUtc.replace(" ", "T") + "Z").getTime()) / 1000,
  );
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function preview(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

/** One line for the banner: which model(s) each task will use. */
function summarizeModels(router: ModelRouter): string {
  try {
    const picks = TASKS.map((t) => [t, router.pick(t)] as const);
    const auto = picks.every(([, p]) => p.why !== "pinned") ? " (auto)" : "";
    const unique = new Set(picks.map(([, p]) => p.model));
    const better = picks.some(([, p]) => p.suggest)
      ? " · better ones available, /model"
      : "";
    if (unique.size === 1) return `Model: ${[...unique][0]}${auto}${better}`;
    return `Models: ${picks.map(([t, p]) => `${t} ${p.model}`).join(", ")}${better}`;
  } catch {
    return "Model: none usable (/pull qwen3:14b)";
  }
}

async function main() {
  const first = process.argv[2];
  if (first === "--help" || first === "-h" || first === "help")
    return console.log(banner([tagline]) + "\n\n" + USAGE);
  if (first === "--version" || first === "-v") return console.log(version());
  if (first === "update") return runUpdate();
  const { mode, root } = parseArgs(process.argv.slice(2));
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(
      chalk.red(`Not a directory: ${root}`) + chalk.dim("\n\n" + USAGE),
    );
    process.exit(1);
  }
  // These own stdin/stdout themselves, so they start before the chat UI is created.
  if (mode === "mcp") return (await import("./mcp.js")).runMcpServer(root);
  if (mode === "setup") return (await import("./setup.js")).runSetup();

  const ui = new UI();

  /** macOS notification, only when the terminal isn't the front app (so you're not pinged while watching). */
  async function alert(title: string, body: string, sound?: string) {
    if (!config.notify || !isMac) return;
    if ((await terminalIsFrontmost()) === true) return;
    await showNotification(title, body, sound).catch(() => {});
  }
  // Slash commands for autocomplete; filled in once the things they complete (models, processes…) exist.
  let commandSpecs: CommandSpec[] = [];
  const rl = createInterface({
    input: stdin,
    output: stdout,
    // Tab: complete the command (or its argument); a second Tab lists the options when there are several.
    completer: (line: string): [string[], string] => [
      completions(line, commandSpecs),
      line,
    ],
  });
  ui.attach(rl);

  const memory = new MemoryStore(config.dbPath);
  const router = new ModelRouter(memory, config.home, config.model);
  let ollamaUp = true;
  await router.refresh().catch(() => (ollamaUp = false));
  const processes = new ProcessManager(
    path.join(config.logDir, path.basename(root)),
    (msg, level) => {
      ui.notify(msg, level);
      // A server coming up or crashing is worth a ping if you've switched away.
      if (level === "warn")
        void alert("Elena: process stopped", msg.split("\n")[0], "Basso");
      else if (level === "ok") void alert("Elena", msg.split("\n")[0]);
    },
  );
  const confirm = async (q: string) => {
    void alert("Elena needs your OK", q.replace(/\s+/g, " ").trim(), "Glass");
    const yes = /^y(es)?$/i.test(
      (await ui.ask(chalk.yellow(`? ${q} [y/N] `))).trim(),
    );
    ui.status(yes ? "Working on it" : "Carrying on"); // the status line paused for the question
    return yes;
  };

  // One scan at a time; the /scan command and the scan_project tool share it.
  let scanning: Promise<string> | undefined;
  const scan = (background = false): Promise<string> => {
    if (scanning) {
      ui.notify("A scan is already running.", "info");
      return scanning;
    }
    ui.notify(
      background
        ? `🔍 Scanning ${path.basename(root)} in the background. Keep chatting; I'll tell you when it's done.`
        : `🔍 Scanning ${path.basename(root)}…`,
    );
    scanning = scanProject(root, (step) => ui.notify(`· ${step}`, "step"))
      .then((res) => {
        memory.saveScan(root, res.summary, res.gitHead);
        agent.refreshSystemPrompt();
        if (mode === "chat") setTimeout(() => warmUp("New project summary"), 0);
        ui.notify(
          `✓ Scan finished in ${(res.ms / 1000).toFixed(1)}s: ${res.headline}. /project to view.`,
          "ok",
        );
        return res.summary;
      })
      .catch((err) => {
        ui.notify(
          `Scan failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
        throw err;
      })
      .finally(() => (scanning = undefined));
    return scanning;
  };

  let conversationId: number | undefined;

  const toolCtx: ToolContext = {
    root,
    memory,
    processes,
    confirm,
    notify: (m) => ui.notify(m, "ok"),
    scan: () => scan(false),
  };

  const secs = (from: number, to = Date.now()) =>
    ((to - from) / 1000).toFixed(0);
  const subagents = new SubagentManager({
    llm: new OllamaLLM(),
    ctx: toolCtx,
    pickModel: (task) => {
      try {
        return router.pick(classify(task)).model;
      } catch {
        return null;
      }
    },
    onToolCall: (id, name, args) => {
      const label = id === null ? "  ↳ subagent" : `  [#${id}]`;
      const line = `${label} → ${name} ${JSON.stringify(args)}`;
      // Printed above the status line, which keeps showing that the subagent is working.
      ui.notify(line.trim(), "step");
    },
    onFinished: (t) => {
      const first = (t.report ?? "").replace(/\s+/g, " ").trim().slice(0, 90);
      if (t.status === "done") {
        ui.notify(
          `✓ Background task #${t.id} finished (${secs(t.startedAt, t.finishedAt)}s, ${t.steps} steps): ${first}…\n      /result ${t.id} to read it. Elena gets it with your next message.` +
            (t.kind !== "subagent" && t.sessionId
              ? `\n      Follow up: /${t.kind} reply <message> (or /${t.kind} reply #${t.id} …).`
              : ""),
          "ok",
        );
        void alert(`Elena: task #${t.id} done`, first);
      } else if (t.status === "cancelled") {
        ui.notify(`■ Background task #${t.id} cancelled.`);
      } else {
        ui.notify(`Background task #${t.id} failed: ${t.report}`, "error");
      }
    },
  });

  toolCtx.subagents = subagents;

  const escalation = new Escalation({
    root,
    tasks: subagents,
    memory,
    confirm,
    onStep: (id, step) => {
      const t = subagents.get(id);
      ui.notify(
        `[#${id}] ${t ? (EXPERT_LABELS[t.kind as ExpertName] ?? t.kind) : "expert"} › ${step}`,
        "step",
      );
    },
  });
  toolCtx.escalation = escalation;
  toolCtx.slash = (line) => runAsElena(line);
  // Checking the CLIs takes about a second; don't hold up startup for it.
  const expertsReady = escalation.refresh().catch(() => undefined);

  const agent = new Agent(new OllamaLLM(), toolCtx, {
    onToken: (t) => ui.token(t),
    onThinking: () => ui.status("Thinking", "💭 thinking…"),
    onMessage: (m) => {
      conversationId ??= memory.startConversation(root, titleFrom(m.content));
      memory.addMessage(conversationId, m);
    },
    onToolCall: (name, args) => ui.toolCall(name, args),
    onToolResult: (_name, result) => {
      if (config.debug) ui.notify(preview(result), "step");
      ui.status("Reading the result"); // the model now processes the tool output
    },
  });

  let shuttingDown = false;
  async function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    // Stop background work, so a cloud agent doesn't keep running (and using your quota) after Elena quits.
    const bgRunning = subagents.cancelAll();
    if (bgRunning.length)
      ui.notify(
        `Cancelled background task${bgRunning.length > 1 ? "s" : ""} ${bgRunning.map((t) => `#${t.id}`).join(", ")}.`,
      );
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

  /**
   * Have the chat model read the system prompt and tools in the background, so the first
   * reply takes well under a second instead of ~14s. Re-run when the system prompt changes.
   */
  function warmUp(reason: string) {
    if (!ollamaUp) return;
    let model: string;
    try {
      model = router.pick("chat").model;
    } catch {
      return;
    }
    const canThink = router.info(model)?.thinking ?? false;
    const started = Date.now();
    ui.notify(
      `⏳ ${reason}: ${model} is reading Elena's instructions in the background…`,
      "step",
    );
    agent
      .warmUp(model, canThink ? config.think : undefined)
      .then(() =>
        ui.notify(
          `✓ Ready (${((Date.now() - started) / 1000).toFixed(1)}s).`,
          "ok",
        ),
      )
      .catch(() => {}); // not fatal; the first reply is just slower
  }

  let lastModel: string | undefined;
  let lastAnswer = "";
  let lastTask: Task | undefined;
  const hinted = new Set<string>();

  /** Choose the model for a task, telling the user when it switches or when a better one could be pulled. */
  function chooseModel(task: Task): string | null {
    let pick;
    try {
      pick = router.pick(task);
    } catch (err) {
      ui.notify(err instanceof Error ? err.message : String(err), "error");
      return null;
    }
    if (lastModel && pick.model !== lastModel) {
      ui.notify(
        `⇄ Using ${pick.model} for ${task} (switching models takes a few seconds to load).`,
        "step",
      );
    }
    if (pick.suggest && !hinted.has(pick.suggest.name)) {
      hinted.add(pick.suggest.name);
      const size = pick.suggest.sizeGB ? `, ~${pick.suggest.sizeGB} GB` : "";
      ui.notify(
        `💡 ${pick.suggest.name} would suit ${task} better. Using ${pick.model} for now. /pull ${pick.suggest.name} to get it${size}.`,
        "info",
      );
    }
    lastModel = pick.model;
    return pick.model;
  }

  async function turn(input: string, task: Task): Promise<string | undefined> {
    const model = chooseModel(task);
    if (!model) return undefined;
    lastTask = task;
    // Only send `think` to models that support it; Ollama rejects it otherwise.
    const canThink = router.info(model)?.thinking ?? false;
    const wantThink = task === "review" ? config.reviewThink : config.think;
    const started = Date.now();
    try {
      ui.status(
        task === "review" ? "Reading the changes" : "Reading your message",
      );
      const answer = await agent.send(input, {
        model,
        think: canThink ? wantThink : undefined,
      });
      const seconds = (Date.now() - started) / 1000;
      ui.finishTurn(answer, seconds, model);
      lastAnswer = answer;
      if (compactAfterTurn) {
        compactAfterTurn = false;
        await compact(model, "Compacted (Elena asked to)");
      } else await autoCompact(model);
      if (seconds > config.notifyAfterSeconds)
        void alert(
          task === "review" ? "Elena: review ready" : "Elena answered",
          answer.replace(/\s+/g, " ").trim(),
        );
    } catch (err) {
      ui.stopStatus();
      ui.endLine();
      const msg = err instanceof Error ? err.message : String(err);
      if (/ECONNREFUSED|fetch failed/.test(msg))
        ui.notify(
          `Can't reach Ollama at ${config.host}. Is it running? (brew services start ollama)`,
          "error",
        );
      else if (/not found/i.test(msg))
        ui.notify(
          `Model ${model} isn't installed. /pull ${model} to download it.`,
          "error",
        );
      else ui.notify(`Error: ${msg}`, "error");
    }
  }

  async function review(expert?: ExpertName) {
    ui.notify("🔎 Preparing a review of your uncommitted changes…");
    const input = await buildReview(root, (step) =>
      ui.notify(`· ${step}`, "step"),
    );
    if (typeof input === "string") return ui.notify(input);
    const tokensK = (input.chars / 3.5 / 1000).toFixed(1);
    const skipped = input.skipped.length
      ? ` Left out for size: ${input.skipped.join(", ")}.`
      : "";
    if (expert) {
      // The cloud agent gets the same diff; it can read the rest of the project for context.
      const res = await escalation.ask(input.prompt, {
        expert,
        mode: "read",
        background: true,
        userInitiated: !elenaInvoking,
      });
      if (res.task)
        ui.notify(
          `🔎 ${EXPERT_LABELS[expert]} is reviewing ${input.files.length} file(s) as background task #${res.task.id}. Keep chatting.`,
        );
      else ui.notify(res.message, "error");
      return;
    }
    ui.notify(
      `Reviewing ${input.files.length} file${input.files.length === 1 ? "" : "s"} (~${tokensK}k tokens; about ${estimateReadSeconds(input.chars)}s to read${config.reviewThink ? ", then it thinks it through, usually under a minute" : ""}).${skipped}`,
    );
    await turn(input.prompt, "review");
  }

  /** `/claude [edit] <task>` and `/codex [edit] <task>`. */
  /**
   * /claude [edit] <task>            start a new session
   * /claude [edit] reply [#n] <msg>  follow up in the latest session (or background task #n's session)
   * A follow-up keeps its session's mode unless you add "edit".
   */
  async function expertCommand(expert: ExpertName, args: string[]) {
    const words = [...args];
    let edit = false;
    let reply = false;
    while (words[0] === "edit" || words[0] === "reply") {
      if (words.shift() === "edit") edit = true;
      else reply = true;
    }
    let resume: string | undefined;
    let mode: "read" | "edit" = edit ? "edit" : "read";
    if (reply) {
      const target = words[0]?.match(/^#(\d+)$/);
      if (target) {
        words.shift();
        const t = subagents.get(Number(target[1]));
        if (!t?.sessionId || t.kind !== expert)
          return ui.notify(
            `Task #${target[1]} isn't a ${EXPERT_LABELS[expert]} session. /tasks to see them.`,
            "error",
          );
        resume = t.sessionId;
        if (!edit) mode = t.mode ?? "read";
      } else {
        const last = memory.listExpertSessions(root, expert, 1)[0];
        if (!last)
          return ui.notify(
            `No earlier ${EXPERT_LABELS[expert]} session in this project. /${expert} <task> starts one.`,
            "error",
          );
        resume = last.session_id;
        if (!edit) mode = last.mode;
      }
    }
    const task = words.join(" ").trim();
    if (!task) {
      return ui.notify(
        reply
          ? `Usage: /${expert} reply <message>, or /${expert} reply #<task> <message>`
          : `Usage: /${expert} <task>, /${expert} edit <task>, or /${expert} reply <message>`,
        "error",
      );
    }
    await expertsReady;
    const res = await escalation.ask(task, {
      expert,
      mode,
      background: true,
      userInitiated: !elenaInvoking,
      resume,
    });
    if (res.task)
      ui.notify(
        `☁ ${EXPERT_LABELS[expert]} is on it as background task #${res.task.id}${resume ? " (follow-up in the same session)" : ""}${mode === "edit" ? " (may edit files)" : " (read-only)"}. Keep chatting; I'll tell you when it's done.`,
      );
    else
      ui.notify(
        res.message,
        res.message.startsWith("User declined") ? "info" : "error",
      );
  }

  async function showExperts() {
    const a = await escalation.refresh();
    for (const e of EXPERTS) {
      const s = a[e];
      const state =
        s.installed && s.loggedIn
          ? chalk.green("ready")
          : chalk.yellow(s.installed ? "not signed in" : "not installed");
      console.log(
        `  ${EXPERT_LABELS[e].padEnd(12)} ${state}${s.version ? chalk.dim(`  v${s.version}`) : ""}${s.fix ? chalk.dim(`  → run: ${s.fix}`) : ""}`,
      );
    }
    console.log(
      chalk.dim(
        "  Read-only by default. Elena asks before sending anything herself; edit mode always asks.",
      ),
    );
    const sessions = memory.listExpertSessions(root);
    if (sessions.length) {
      console.log(chalk.bold("\n  Recent sessions in this project"));
      for (const s of sessions) {
        const task = s.task.replace(/\s+/g, " ");
        console.log(
          `    ${chalk.cyan(s.session_id.slice(0, 8))}  ${EXPERT_LABELS[s.expert as ExpertName] ?? s.expert}  ${chalk.dim(`${s.turns} turn${s.turns === 1 ? "" : "s"} · ${ago(s.updated_at)}`)}  ${task.length > 50 ? task.slice(0, 49) + "…" : task}`,
        );
      }
      console.log(
        chalk.dim(
          `  /claude reply <message> continues the latest; claude --resume <id> opens one in Claude Code.`,
        ),
      );
    }
  }

  const pulling = new Set<string>();
  /** Download a model in the background, reporting progress every 10%. */
  async function pull(name: string) {
    const model = normalize(name);
    if (elenaInvoking && !(await confirm(`Elena wants to download ${model}. Allow?`))) return ui.notify("Download cancelled.");
    if (pulling.has(model)) return ui.notify(`Already downloading ${model}.`);
    if (router.info(model)) return ui.notify(`${model} is already installed.`);
    pulling.add(model);
    ui.notify(
      `⬇ Downloading ${model} in the background. Keep chatting; I'll tell you when it's ready.`,
    );
    (async () => {
      const lastPct = new Map<string, number>();
      for await (const p of await ollama.pull({ model, stream: true })) {
        // Progress is per layer; only report the big ones (the weights).
        if (!p.digest || !p.total || p.total < 100e6 || !p.completed) continue;
        const pct = Math.floor((p.completed / p.total) * 100);
        if (pct < (lastPct.get(p.digest) ?? -10) + 10) continue;
        lastPct.set(p.digest, pct - (pct % 10));
        const gb = (n: number) => (n / 1e9).toFixed(1);
        ui.notify(
          `· ${model} ${pct}% (${gb(p.completed)}/${gb(p.total)} GB)`,
          "step",
        );
      }
      await router.refresh();
      const info = router.info(model);
      if (info && !info.tools)
        ui.notify(
          `✓ ${model} downloaded, but it doesn't support tool calling, so Elena can't use it.`,
          "warn",
        );
      else {
        ui.notify(
          `✓ ${model} is ready. Elena will use it where it fits best; /model to see.`,
          "ok",
        );
        void alert("Elena", `${model} finished downloading.`);
      }
    })()
      .catch((err) =>
        ui.notify(
          /file does not exist|not found/i.test(String(err))
            ? `There's no model called ${model} in the Ollama library. Check the name at ollama.com/library.`
            : `Downloading ${model} failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        ),
      )
      .finally(() => pulling.delete(model));
  }

  function showModels() {
    const gb = (n: number) => n.toFixed(1).padStart(5);
    const lines = [chalk.bold("  Installed")];
    for (const m of router.list()) {
      const caps = m.tools
        ? chalk.dim(
            ["tools", m.thinking && "thinking"].filter(Boolean).join(" · "),
          )
        : chalk.yellow("no tool support, Elena can't use it");
      lines.push(`    ${m.name.padEnd(22)}${gb(m.sizeGB)} GB  ${caps}`);
    }
    if (!router.list().length) lines.push(chalk.dim("    none"));
    lines.push(chalk.bold("  Per task"));
    for (const t of TASKS) {
      try {
        const p = router.pick(t);
        const how =
          p.why === "pinned" ? chalk.cyan("pinned") : chalk.dim("auto  ");
        lines.push(
          `    ${t.padEnd(8)}${p.model.padEnd(22)}${how}  ${chalk.dim(TASK_LABELS[t])}`,
        );
        if (p.suggest)
          lines.push(
            chalk.dim(
              `            💡 better: ${p.suggest.name} (/pull ${p.suggest.name}${p.suggest.sizeGB ? `, ~${p.suggest.sizeGB} GB` : ""})`,
            ),
          );
      } catch (err) {
        lines.push(
          `    ${t.padEnd(8)}${chalk.red(err instanceof Error ? err.message : String(err))}`,
        );
      }
    }
    if (router.envPinned)
      lines.push(
        chalk.yellow(
          `  ELENA_MODEL is set, so every task uses ${config.model}.`,
        ),
      );
    lines.push(
      chalk.dim(
        "  /model <name> · /model <task> <name> · /model auto · /pull <name>",
      ),
    );
    console.log(lines.join("\n"));
  }

  /** Handles `/model [task] [name|auto]`. */
  async function modelCommand(args: string[]) {
    if (ollamaUp) await router.refresh().catch(() => {});
    if (!args.length) return showModels();

    const task = (TASKS as string[]).includes(args[0])
      ? (args.shift() as Task)
      : "all";
    const name = args[0];
    const target = task === "all" ? "every task" : task;
    if (!name)
      return ui.notify(
        `Usage: /model ${task === "all" ? "<name>" : `${task} <name|auto>`}`,
        "error",
      );

    if (name === "auto") {
      router.pin(task, null);
      ui.notify(
        `Elena picks the model for ${target} automatically again.`,
        "ok",
      );
    } else {
      const info = router.info(name);
      if (!info)
        return ui.notify(
          `${normalize(name)} isn't installed. /pull ${normalize(name)} to download it.`,
          "error",
        );
      if (!info.tools)
        return ui.notify(
          `${info.name} doesn't support tool calling, which Elena needs.`,
          "error",
        );
      router.pin(task, info.name);
      ui.notify(`Using ${info.name} for ${target}. /model auto to undo.`, "ok");
    }
    if (router.envPinned)
      ui.notify(
        `Note: ELENA_MODEL is set, so it overrides this until you unset it.`,
        "warn",
      );
  }

  /** `/resume` lists conversations; `/resume <n>` or `/resume last` loads one. */
  /** "context ▰▰▰▱▱▱▱▱▱▱ 31% of 16k", green → yellow → red as it fills. */
  function contextMeter(): string {
    const { used, limit } = agent.contextUsage();
    const pct = Math.min(100, Math.round((used / limit) * 100));
    const filled = Math.min(10, Math.round(pct / 10));
    const color =
      pct >= 80 ? chalk.red : pct >= 60 ? chalk.yellow : chalk.green;
    return (
      chalk.dim("context ") +
      color("▰".repeat(filled)) +
      chalk.dim("▱".repeat(10 - filled)) +
      chalk.dim(` ${pct}% of ${Math.round(limit / 1000)}k`)
    );
  }

  const fmtK = (n: number) =>
    n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

  /** The short version, always shown in the prompt: "▰▰▱▱▱▱▱▱▱▱ 20%". */
  function contextBar(): string {
    const { used, limit } = agent.contextUsage();
    const pct = Math.min(100, Math.round((used / limit) * 100));
    const filled = Math.min(10, Math.round(pct / 10));
    const color =
      pct >= 80 ? chalk.red : pct >= 60 ? chalk.yellow : chalk.green;
    return (
      color("▰".repeat(filled)) +
      chalk.dim("▱".repeat(10 - filled) + ` ${pct}%`)
    );
  }

  function showContext() {
    const { used, limit, exact } = agent.contextUsage();
    console.log(
      `  ${contextMeter()}  ${chalk.dim(`(${fmtK(used)} tokens${exact ? "" : ", estimated"})`)}`,
    );
    for (const part of agent.contextBreakdown()) {
      const pct = Math.round((part.tokens / limit) * 100);
      console.log(
        `    ${fmtK(part.tokens).padStart(6)}  ${chalk.dim(`${String(pct).padStart(2)}%`)}  ${part.label}`,
      );
    }
    console.log(
      chalk.dim(
        `  Elena compacts automatically at ${Math.round(config.compactAt * 100)}%. /compact to do it now, /new to start fresh.`,
      ),
    );
  }

  /** Trim old tool output, then summarise older messages if that wasn't enough. */
  async function compact(model: string, reason: string, quiet = false) {
    const before = agent.contextUsage().used;
    ui.status("Compacting the conversation");
    const trimmed = agent.pruneToolResults();
    let summarized = false;
    if (agent.contextUsage().used / config.numCtx > config.compactTarget) {
      try {
        summarized = await agent.summarizeHistory(model);
      } catch (err) {
        ui.stopStatus();
        ui.notify(
          `Couldn't summarise: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    }
    ui.stopStatus();
    const after = agent.contextUsage().used;
    if (!trimmed && !summarized)
      return quiet
        ? undefined
        : ui.notify(
            "Nothing to compact yet: the conversation is all recent or already short.",
          );
    const what = [
      trimmed &&
        `trimmed ${trimmed} old tool result${trimmed === 1 ? "" : "s"}`,
      summarized && "summarised older messages",
    ]
      .filter(Boolean)
      .join(" and ");
    ui.notify(
      `🗜 ${reason}: ${what}. Context ${fmtK(before)} → ${fmtK(after)} tokens (${Math.round((after / config.numCtx) * 100)}%).`,
      "ok",
    );
  }

  /**
   * Restart with the code on disk, keeping this conversation. The process is replaced in place
   * (process.execve), so reloads don't stack up; older Node falls back to a child process.
   */
  async function reload() {
    const running = processes.running().map((p) => p.name);
    const tasks = subagents
      .list()
      .filter((t) => t.status === "running")
      .map((t) => `task #${t.id}`);
    if (running.length || tasks.length) {
      const ok = await confirm(
        `Reloading stops ${[...running, ...tasks].join(", ")}. Continue?`,
      );
      ui.stopStatus();
      if (!ok) return;
    }
    ui.notify("↻ Reloading Elena with her latest code…");
    subagents.cancelAll();
    await processes.stopAll();
    const env = {
      ...process.env,
      ELENA_RESUME: conversationId ? String(conversationId) : "0",
    };
    const argv = [process.execPath, process.argv[1], ...process.argv.slice(2)];
    rl.close();
    memory.close();
    const execve = (
      process as unknown as {
        execve?: (
          file: string,
          args: string[],
          env: NodeJS.ProcessEnv,
        ) => never;
      }
    ).execve;
    if (execve) execve(process.execPath, argv, env);
    // Node < 22.15: run the new version as a child that takes over the terminal, and exit with it.
    process.removeAllListeners("SIGINT");
    process.on("SIGINT", () => {}); // Ctrl+C belongs to the new Elena now
    spawn(process.execPath, argv.slice(1), { stdio: "inherit", env }).on(
      "exit",
      (code) => process.exit(code ?? 0),
    );
    await new Promise(() => {}); // wait here until the child exits
  }

  async function autoCompact(model: string) {
    if (agent.contextUsage().used / config.numCtx >= config.compactAt)
      await compact(model, "Context was getting full", true);
  }

  function resumeCommand(arg?: string) {
    const past = memory.listConversations(root, 10);
    if (!arg) {
      if (!past.length)
        return ui.notify("No saved conversations in this project yet.");
      console.log(
        past
          .map((c, i) => {
            const current =
              c.id === conversationId ? chalk.cyan("  (current)") : "";
            return `  ${String(i + 1).padStart(2)}. ${chalk.dim(ago(c.updated_at).padEnd(11))} ${c.title}  ${chalk.dim(`${c.turns} turn${c.turns === 1 ? "" : "s"}`)}${current}`;
          })
          .join("\n") + chalk.dim("\n  /resume <n> to continue one"),
      );
      return;
    }
    const others = past.filter((c) => c.id !== conversationId);
    const pick = arg === "last" ? others[0] : past[Number(arg) - 1];
    if (!pick)
      return ui.notify(
        arg === "last"
          ? "No earlier conversation to resume."
          : `No conversation #${arg}. /resume to list them.`,
        "error",
      );
    if (pick.id === conversationId)
      return ui.notify("That's the conversation you're in.");
    loadConversation(pick, false);
  }

  function loadConversation(
    pick: { id: number; title: string; turns: number; updated_at: string },
    afterReload: boolean,
  ) {
    const { kept, dropped } = fitHistory(memory.getMessages(pick.id));
    agent.loadHistory(kept);
    conversationId = pick.id;
    lastTask = undefined;
    ui.notify(
      afterReload
        ? `↺ Reloaded with the latest code. Still in "${pick.title}".`
        : `↺ Resumed "${pick.title}" (${pick.turns} turn${pick.turns === 1 ? "" : "s"}, last active ${ago(pick.updated_at)}).`,
      "ok",
    );
    if (dropped)
      ui.notify(
        `Loaded the latest ${kept.length} messages; the ${dropped} before them are too long to fit in the model's context.`,
        "step",
      );

    // Remind the user where they left off.
    const lastUser = [...kept].reverse().find((m) => m.role === "user");
    const lastAnswer = [...kept]
      .reverse()
      .find((m) => m.role === "assistant" && m.content.trim());
    const clip = (t: string, n: number) => {
      const one = t.replace(/\s+/g, " ").trim();
      return one.length > n ? one.slice(0, n) + "…" : one;
    };
    if (lastUser)
      console.log(chalk.dim(`  lesliePaul › ${clip(lastUser.content, 120)}`));
    if (lastAnswer)
      console.log(chalk.dim(`  elena › ${clip(lastAnswer.content, 300)}`));
    warmUp("Resumed conversation");
  }

  /** True while Elena herself is running a slash command, so approvals still apply. */
  let elenaInvoking = false;
  /** escalation.declines at the start of this turn: after a "no", Elena can't ask again in the same turn. */
  let turnDeclines = 0;
  let compactAfterTurn = false;
  /**
   * Commands Elena may run herself. Not /reload, /new, /resume or /forget, and not a local /review
   * (it would start a second reply inside her current one); /compact waits until her reply is done.
   */
  const ELENA_COMMANDS = new Set([
    "/claude", "/codex", "/experts", "/bg", "/tasks", "/result", "/cancel", "/scan", "/project",
    "/context", "/compact", "/ps", "/logs", "/stop", "/pull", "/model", "/mac", "/memories", "/review",
  ]);

  /** Run a slash command for Elena and return what it printed, as plain text for her to read. */
  async function runAsElena(line: string): Promise<string> {
    const cmd = line.trim().split(/\s+/)[0];
    if (!cmd.startsWith("/")) return `Not a slash command: ${line}`;
    if (!ELENA_COMMANDS.has(cmd)) return `${cmd} is only for the user to run. Suggest it to them instead.`;
    if ((cmd === "/claude" || cmd === "/codex") && escalation.declines > turnDeclines) {
      return "The user already said no to handing this off. Don't ask again; answer them directly.";
    }
    if (cmd === "/review" && !/^\/review\s+(claude|codex)\b/.test(line.trim())) {
      return "Run /review claude (or codex) for a cloud review. For a local review, read the diff yourself with git_diff.";
    }
    if (cmd === "/compact") {
      compactAfterTurn = true;
      return "Will compact the conversation as soon as this reply is finished.";
    }
    const lines: string[] = [];
    const log = console.log;
    const notify = ui.notify.bind(ui);
    console.log = (...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
      log(...a);
    };
    ui.notify = (m: string, level?: Parameters<UI["notify"]>[1]) => {
      lines.push(m);
      notify(m, level);
    };
    elenaInvoking = true;
    try {
      await command(line.trim());
    } finally {
      elenaInvoking = false;
      console.log = log;
      ui.notify = notify;
    }
    return stripVTControlCharacters(lines.join("\n")).trim() || "(done)";
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
        console.log(
          s
            ? chalk.dim(`  Scanned ${ago(s.scanned_at)}\n`) +
                s.summary.replace(/^/gm, "  ")
            : chalk.dim("  No scan yet. /scan"),
        );
        return true;
      }
      case "/review":
        await review(
          rest[0] === "claude" || rest[0] === "codex" ? rest[0] : undefined,
        );
        return true;
      case "/claude":
      case "/codex":
        await expertCommand(cmd.slice(1) as ExpertName, rest);
        return true;
      case "/experts":
        await showExperts();
        return true;
      case "/cancel": {
        const t = subagents.get(Number(rest[0]));
        if (!t || t.status !== "running")
          ui.notify(
            `No running task #${rest[0] ?? ""}. /tasks to list them.`,
            "error",
          );
        else if (!subagents.cancel(t.id))
          ui.notify(`#${t.id} can't be cancelled; it will finish on its own.`);
        return true;
      }
      case "/model":
        await modelCommand(rest);
        return true;
      case "/pull":
        if (!rest[0])
          ui.notify("Usage: /pull <model>, e.g. /pull qwen3:8b", "error");
        else await pull(rest[0]);
        return true;
      case "/ps": {
        const all = processes.list();
        console.log(
          all.length
            ? all.map((p) => "  " + describeProcess(p)).join("\n")
            : chalk.dim("  No background processes."),
        );
        return true;
      }
      case "/logs": {
        try {
          console.log(
            chalk.dim(
              processes
                .logs(rest[0] ?? "", Number(rest[1]) || 40)
                .replace(/^/gm, "  "),
            ),
          );
        } catch (err) {
          ui.notify(err instanceof Error ? err.message : String(err), "error");
        }
        return true;
      }
      case "/stop":
        ui.notify(
          (await processes.stop(rest[0] ?? ""))
            ? `■ Stopped ${rest[0]}.`
            : `No running process named "${rest[0] ?? ""}".`,
        );
        return true;
      case "/bg": {
        const task = rest.join(" ").trim();
        if (!task) {
          ui.notify(
            "Usage: /bg <task>, e.g. /bg find where currentLegIndex is changed",
            "error",
          );
          return true;
        }
        const started = subagents.startBackground(task);
        if (typeof started === "string") ui.notify(started, "error");
        else
          ui.notify(
            `🔎 Background task #${started.id} started with ${started.model}. Keep chatting; I'll tell you when it's done.`,
          );
        return true;
      }
      case "/tasks": {
        const all = subagents.list();
        if (!all.length) {
          ui.notify("No background tasks yet. /bg <task> to start one.");
          return true;
        }
        console.log(
          all
            .map((t) => {
              const state =
                t.status === "running"
                  ? chalk.cyan(`running ${secs(t.startedAt)}s`)
                  : t.status === "done"
                    ? chalk.green(`done in ${secs(t.startedAt, t.finishedAt)}s`)
                    : t.status === "cancelled"
                      ? chalk.dim("cancelled")
                      : chalk.red("failed");
              const who =
                t.kind === "subagent" ? `subagent (${t.model})` : t.model;
              const task =
                t.task.length > 70 ? t.task.slice(0, 69) + "…" : t.task;
              return `  #${t.id}  ${state}  ${chalk.dim(`${who} · ${t.steps} steps`)}  ${task}`;
            })
            .join("\n"),
        );
        return true;
      }
      case "/result": {
        const t = subagents.get(Number(rest[0]));
        if (!t)
          ui.notify(
            `No background task #${rest[0] ?? ""}. /tasks to list them.`,
            "error",
          );
        else if (t.status === "running")
          ui.notify(`#${t.id} is still running (${t.steps} steps so far).`);
        else
          console.log(
            `  ${chalk.bold(`#${t.id}`)} ${chalk.dim(t.task)}\n\n${t.report}\n`,
          );
        return true;
      }
      case "/resume":
        resumeCommand(rest[0]);
        return true;
      case "/context":
        showContext();
        return true;
      case "/compact": {
        let model: string;
        try {
          model = router.pick("chat").model;
        } catch (err) {
          ui.notify(err instanceof Error ? err.message : String(err), "error");
          return true;
        }
        await compact(model, "Compacted");
        return true;
      }
      case "/reload":
        await reload();
        return true;
      case "/new":
        agent.reset();
        conversationId = undefined;
        lastTask = undefined;
        ui.notify(
          "Started a fresh conversation. /resume to go back to earlier ones.",
          "ok",
        );
        return true;
      case "/mac":
        if (!isMac) ui.notify("Only on macOS.");
        else console.log(formatStatus(await macStatus()).replace(/^/gm, "  "));
        return true;
      case "/memories": {
        const all = memory.list(root);
        console.log(
          all.length
            ? all.map((m) => "  " + formatMemory(m, root)).join("\n")
            : chalk.dim("  No memories yet."),
        );
        return true;
      }
      case "/forget": {
        const id = Number(rest[0]);
        ui.notify(
          Number.isInteger(id) && memory.remove(id)
            ? `Forgot #${id}.`
            : `No memory #${rest[0] ?? ""}.`,
        );
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
    await scan(false).then(
      (s) => console.log("\n" + s),
      () => {},
    );
    return shutdown(0);
  }
  if (mode === "review") {
    await review();
    return shutdown(0);
  }

  const mac = isMac ? statusLine(await macStatus()) : undefined;
  console.log(
    banner([
      tagline,
      // Short enough for an 80-column terminal; /model has the details.
      chalk.dim(
        `${greeting()}. ${path.basename(root)} · ${modelSummary()
          .replace(/^Models?: /, "")
          .replace(/ · better ones available, \/model$/, "")}`,
      ),
      mac
        ? (mac.warn ? chalk.yellow : chalk.dim)(
            `Mac: ${mac.text
              .replace(" free", "")
              .replace("memory ", "mem ")
              .replace(/ free/, "")
              .replace(/\/\d+ cores/, "")}`,
          )
        : "",
    ]) + "\n",
  );
  if (!ollamaUp)
    ui.notify(
      `Can't reach Ollama at ${config.host}. Start it with: brew services start ollama`,
      "error",
    );
  function modelSummary() {
    return ollamaUp ? summarizeModels(router) : "Model: Ollama not running";
  }
  const saved = memory.getScan(root);
  if (saved) {
    const head = (await run("git", ["rev-parse", "HEAD"], root)).stdout.trim();
    const moved =
      saved.git_head && head && head !== saved.git_head
        ? ", new commits since"
        : "";
    console.log(
      chalk.dim(
        `Project scan from ${ago(saved.scanned_at)}${moved} (/scan to refresh).`,
      ),
    );
  } else {
    console.log(
      chalk.dim(`No project scan yet. Type /scan or say "scan the project".`),
    );
  }
  const lastChat =
    process.env.ELENA_RESUME === undefined
      ? memory.listConversations(root, 1)[0]
      : undefined;
  if (lastChat)
    console.log(
      chalk.dim(
        `Last conversation ${ago(lastChat.updated_at)}: "${lastChat.title}" (/resume last).`,
      ),
    );
  const remembered = memory.list(root).length;
  if (remembered)
    console.log(
      chalk.dim(
        `Remembering ${remembered} thing${remembered === 1 ? "" : "s"} (/memories to see).`,
      ),
    );
  const processNames = () => processes.list().map((p) => p.name);
  const expertArgs = (expert: ExpertName, w: string[]) => {
    if (!w.length) return ["reply", "edit"];
    if (w.length === 1 && w[0] === "edit") return ["reply"];
    if (w[w.length - 1] === "reply")
      return subagents
        .list()
        .filter((t) => t.kind === expert && t.sessionId)
        .map((t) => `#${t.id}`);
    return [];
  };
  const taskIds = () => subagents.list().map((t) => String(t.id));
  commandSpecs = [
    { name: "/context", about: "what's filling the context window" },
    { name: "/compact", about: "free up context" },
    { name: "/scan", about: "scan the project in the background" },
    {
      name: "/review",
      about: "review uncommitted changes",
      args: (w) => (w.length ? [] : ["claude", "codex"]),
    },
    {
      name: "/resume",
      about: "pick up a past conversation",
      args: (w) =>
        w.length
          ? []
          : [
              "last",
              ...memory
                .listConversations(root, 10)
                .map((_, i) => String(i + 1)),
            ],
    },
    {
      name: "/model",
      about: "which model each task uses",
      args: (w) => {
        const models = router
          .list()
          .filter((m) => m.tools)
          .map((m) => m.name);
        if (!w.length) return ["auto", ...TASKS, ...models];
        return (TASKS as string[]).includes(w[0]) && w.length === 1
          ? ["auto", ...models]
          : [];
      },
    },
    { name: "/ps", about: "background processes" },
    {
      name: "/logs",
      about: "a process's output",
      args: (w) => (w.length ? [] : processNames()),
    },
    {
      name: "/stop",
      about: "stop a process",
      args: (w) => (w.length ? [] : processNames()),
    },
    {
      name: "/claude",
      about: "hand a task to Claude Code, or reply to it",
      args: (w) => expertArgs("claude", w),
    },
    {
      name: "/codex",
      about: "hand a task to Codex, or reply to it",
      args: (w) => expertArgs("codex", w),
    },
    { name: "/bg", about: "investigate in the background" },
    { name: "/tasks", about: "background tasks" },
    {
      name: "/result",
      about: "a background task's report",
      args: (w) => (w.length ? [] : taskIds()),
    },
    {
      name: "/cancel",
      about: "stop a background task",
      args: (w) => (w.length ? [] : taskIds()),
    },
    { name: "/project", about: "the saved project summary" },
    { name: "/new", about: "start a fresh conversation" },
    { name: "/reload", about: "restart with the latest code" },
    { name: "/memories", about: "what Elena remembers" },
    {
      name: "/forget",
      about: "delete a memory",
      args: (w) => (w.length ? [] : memory.list(root).map((m) => String(m.id))),
    },
    { name: "/mac", about: "Mac health" },
    { name: "/experts", about: "which cloud agents are ready" },
    {
      name: "/pull",
      about: "download a model",
      args: (w) => (w.length ? [] : KNOWN_MODELS),
    },
    { name: "/help", about: "all commands" },
  ];
  new Autosuggest(
    rl,
    () => commandSpecs,
    () => ui.isWaitingForInput,
  ).attach();
  ui.statusSuffix = contextBar;

  // After /reload: pick the same conversation back up, and skip the cheat sheet (you've seen it).
  const resumeId = Number(process.env.ELENA_RESUME ?? "");
  const reloaded = process.env.ELENA_RESUME !== undefined;
  delete process.env.ELENA_RESUME;
  const resumed = resumeId
    ? memory.listConversations(root, 200).find((c) => c.id === resumeId)
    : undefined;
  if (resumed) loadConversation(resumed, true);
  else if (reloaded) ui.notify("↺ Reloaded with the latest code.", "ok");
  else console.log("\n" + cheatSheet());
  if (!resumed) warmUp("Starting up");

  // Tell the user when Elena's own code changes on disk (an update or a rebuild), so they can /reload.
  let codeChangeNoticed = false;
  let codeChangeTimer: NodeJS.Timeout | undefined;
  try {
    watch(
      path.dirname(fileURLToPath(import.meta.url)),
      { recursive: true },
      (_event, file) => {
        if (codeChangeNoticed || !String(file ?? "").endsWith(".js")) return;
        clearTimeout(codeChangeTimer);
        codeChangeTimer = setTimeout(() => {
          codeChangeNoticed = true;
          ui.notify(
            "Elena's code was updated. /reload to use it; this conversation carries over.",
          );
        }, 1500);
      },
    ).unref();
  } catch {
    // watching isn't available here; /reload still works
  }
  // Build Elena.app (once) so notifications show her icon. Quiet unless it actually builds.
  if (isMac && config.notify)
    ensureNotifier()
      .then(
        (s) =>
          s === "built" &&
          ui.notify(
            "Built ~/.elena/Elena.app, so notifications now show Elena's icon.",
            "step",
          ),
      )
      .catch(() => {});
  console.log(chalk.dim(`\ntype 'exit' to quit.\n`));

  while (true) {
    let input: string;
    try {
      input = (await ui.ask(`${contextBar()} ${chalk.cyan("you ›")} `)).trim();
    } catch {
      break; // Ctrl+D / closed stdin
    }
    if (!input) continue;
    if (input === "exit" || input === "quit") break;

    const shortcut = SHORTCUTS.find(([re]) => re.test(input))?.[1];
    if (await command(shortcut ?? input)) continue;
    // Hand Elena any background reports that finished since her last turn.
    const reports = subagents.takeUndelivered();
    if (reports.length)
      ui.notify(
        `↪ Giving Elena the report${reports.length > 1 ? "s" : ""} from ${reports.map((t) => `#${t.id}`).join(", ")}.`,
        "step",
      );
    const withReports = reports.length
      ? reports
          .map((t) => {
            const report = t.report ?? "";
            const body =
              report.length > 4000
                ? report.slice(0, 4000) +
                  `\n… (truncated; the user can see all of it with /result ${t.id})`
                : report;
            const task =
              t.task.length > 200 ? t.task.slice(0, 200) + "…" : t.task;
            return `[Background task #${t.id} by ${t.model} (${task}) ${t.status === "done" ? "finished" : "failed"}. Report:]\n${body}`;
          })
          .join("\n\n") + `\n\n[My message:]\n${input}`
      : input;
    // Big jobs: remind the local model it can hand this to Claude (it rarely decides to on its own).
    const claudeReady = (await escalation.available()).includes("claude");
    const nudge = claudeReady && looksHeavy(input)
      ? `\n\n[Note from Elena's app, not the user: this looks like a big job. If it needs changes across several files or you're not sure you can do it well, hand it to Claude with slash_command "/claude edit <task>" (the user approves first). Small, clear edits you can do yourself.]`
      : "";
    const claudeTasksBefore = subagents.list().filter((t) => t.kind === "claude").length;
    const declinesBefore = escalation.declines;
    turnDeclines = escalation.declines;
    lastAnswer = "";
    await turn(withReports + nudge, classify(input, lastTask));

    // The local model often says "I'll hand this to Claude" and doesn't. For a big job that ended
    // without a Claude task, offer the handoff directly (the usual approval prompt), with her notes.
    const handedOff = subagents.list().filter((t) => t.kind === "claude").length > claudeTasksBefore;
    const saidNo = escalation.declines > declinesBefore;
    if (nudge && !handedOff && !saidNo) {
      ui.notify("Elena can't change files herself, so this is a job for Claude Code.");
      const notes = lastAnswer.trim() ? `\n\nElena's notes so far:\n${lastAnswer.trim().slice(0, 1500)}` : "";
      const res = await escalation.ask(input + notes, { expert: "claude", mode: "edit", background: true, userInitiated: false });
      if (res.task) ui.notify(`☁ Claude Code is on it as background task #${res.task.id} (may edit files). Keep chatting; I'll tell you when it's done.`);
      else ui.notify(res.message.startsWith("User declined") ? "OK, not handed off." : res.message, res.message.startsWith("User declined") ? "info" : "error");
    }
  }
  await shutdown(0);
}

main();
