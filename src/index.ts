#!/usr/bin/env node
import "./quiet.js";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { Agent } from "./agent.js";
import { config } from "./config.js";
import { OllamaLLM, ollama } from "./llm.js";
import { MemoryStore, formatMemory } from "./memory/store.js";
import {
  ModelRouter,
  TASKS,
  TASK_LABELS,
  classify,
  normalize,
  type Task,
} from "./models.js";
import { ProcessManager, describeProcess } from "./processes.js";
import { scanProject } from "./project/scan.js";
import { buildReview, estimateReadSeconds } from "./review.js";
import { run } from "./tools/exec.js";
import { UI } from "./ui.js";
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
  /resume            recent conversations in this project
  /resume <n>|last   pick up a conversation where you left off
  /new               start a fresh conversation
  /mac               Mac health: battery, disk, memory, load, volume
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

function parseArgs(argv: string[]): {
  mode: "chat" | "review" | "scan";
  root: string;
} {
  const mode =
    argv[0] === "review" || argv[0] === "scan" ? argv.shift()! : "chat";
  return {
    mode: mode as "chat" | "review" | "scan",
    root: path.resolve(argv[0] ?? process.cwd()),
  };
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
    ["/resume", "past chats"],
    ["/new", "fresh chat"],
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
    label("Tools") + chalk.dim(tools.slice(0, 3).join(" · ")),
    " ".repeat(10) +
      chalk.dim(tools.slice(3, 6).join(" · ") + "  ") +
      chalk.yellow("*asks first"),
    " ".repeat(10) + chalk.dim(tools.slice(6).join(" · ")),
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
    const better = picks.some(([, p]) => p.suggest) ? " · better ones available, /model" : "";
    if (unique.size === 1) return `Model: ${[...unique][0]}${auto}${better}`;
    return `Models: ${picks.map(([t, p]) => `${t} ${p.model}`).join(", ")}${better}`;
  } catch {
    return "Model: none usable (/pull qwen3:14b)";
  }
}

async function main() {
  const { mode, root } = parseArgs(process.argv.slice(2));
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(chalk.red(`Not a directory: ${root}`));
    process.exit(1);
  }

  const ui = new UI();

  /** macOS notification, only when the terminal isn't the front app (so you're not pinged while watching). */
  async function alert(title: string, body: string, sound?: string) {
    if (!config.notify || !isMac) return;
    if ((await terminalIsFrontmost()) === true) return;
    await showNotification(title, body, sound).catch(() => {});
  }
  const rl = createInterface({ input: stdin, output: stdout });
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
      if (level === "warn") void alert("Elena: process stopped", msg.split("\n")[0], "Basso");
      else if (level === "ok") void alert("Elena", msg.split("\n")[0]);
    },
  );
  const confirm = async (q: string) => {
    void alert("Elena needs your OK", q.replace(/\s+/g, " ").trim(), "Glass");
    return /^y(es)?$/i.test((await ui.ask(chalk.yellow(`? ${q} [y/N] `))).trim());
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

  const agent = new Agent(
    new OllamaLLM(),
    {
      root,
      memory,
      processes,
      confirm,
      notify: (m) => ui.notify(m, "ok"),
      scan: () => scan(false),
    },
    {
      onToken: (t) => ui.token(t),
      onThinking: () => ui.notify("💭 thinking…", "step"),
      onMessage: (m) => {
        conversationId ??= memory.startConversation(root, titleFrom(m.content));
        memory.addMessage(conversationId, m);
      },
      onToolCall: (name, args) => ui.toolCall(name, args),
      onToolResult: (_name, result) =>
        config.debug && ui.notify(preview(result), "step"),
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
    ui.notify(`⏳ ${reason}: ${model} is reading Elena's instructions in the background…`, "step");
    agent
      .warmUp(model, canThink ? config.think : undefined)
      .then(() =>
        ui.notify(`✓ Ready (${((Date.now() - started) / 1000).toFixed(1)}s).`, "ok"),
      )
      .catch(() => {}); // not fatal; the first reply is just slower
  }

  let lastModel: string | undefined;
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

  async function turn(input: string, task: Task) {
    const model = chooseModel(task);
    if (!model) return;
    lastTask = task;
    // Only send `think` to models that support it; Ollama rejects it otherwise.
    const canThink = router.info(model)?.thinking ?? false;
    const wantThink = task === "review" ? config.reviewThink : config.think;
    const started = Date.now();
    try {
      const answer = await agent.send(input, {
        model,
        think: canThink ? wantThink : undefined,
      });
      const seconds = (Date.now() - started) / 1000;
      ui.finishTurn(answer, seconds, model);
      if (seconds > config.notifyAfterSeconds)
        void alert(task === "review" ? "Elena: review ready" : "Elena answered", answer.replace(/\s+/g, " ").trim());
    } catch (err) {
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

  async function review() {
    ui.notify("🔎 Preparing a review of your uncommitted changes…");
    const input = await buildReview(root, (step) =>
      ui.notify(`· ${step}`, "step"),
    );
    if (typeof input === "string") return ui.notify(input);
    const tokensK = (input.chars / 3.5 / 1000).toFixed(1);
    const skipped = input.skipped.length
      ? ` Left out for size: ${input.skipped.join(", ")}.`
      : "";
    ui.notify(
      `Reviewing ${input.files.length} file${input.files.length === 1 ? "" : "s"} (~${tokensK}k tokens; about ${estimateReadSeconds(input.chars)}s to read${config.reviewThink ? ", then it thinks it through, usually under a minute" : ""}).${skipped}`,
    );
    await turn(input.prompt, "review");
  }

  const pulling = new Set<string>();
  /** Download a model in the background, reporting progress every 10%. */
  function pull(name: string) {
    const model = normalize(name);
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
      else
      {
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
        ? chalk.dim(["tools", m.thinking && "thinking"].filter(Boolean).join(" · "))
        : chalk.yellow("no tool support, Elena can't use it");
      lines.push(`    ${m.name.padEnd(22)}${gb(m.sizeGB)} GB  ${caps}`);
    }
    if (!router.list().length) lines.push(chalk.dim("    none"));
    lines.push(chalk.bold("  Per task"));
    for (const t of TASKS) {
      try {
        const p = router.pick(t);
        const how = p.why === "pinned" ? chalk.cyan("pinned") : chalk.dim("auto  ");
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
        lines.push(`    ${t.padEnd(8)}${chalk.red(err instanceof Error ? err.message : String(err))}`);
      }
    }
    if (router.envPinned)
      lines.push(chalk.yellow(`  ELENA_MODEL is set, so every task uses ${config.model}.`));
    lines.push(
      chalk.dim("  /model <name> · /model <task> <name> · /model auto · /pull <name>"),
    );
    console.log(lines.join("\n"));
  }

  /** Handles `/model [task] [name|auto]`. */
  async function modelCommand(args: string[]) {
    if (ollamaUp) await router.refresh().catch(() => {});
    if (!args.length) return showModels();

    const task = (TASKS as string[]).includes(args[0]) ? (args.shift() as Task) : "all";
    const name = args[0];
    const target = task === "all" ? "every task" : task;
    if (!name) return ui.notify(`Usage: /model ${task === "all" ? "<name>" : `${task} <name|auto>`}`, "error");

    if (name === "auto") {
      router.pin(task, null);
      ui.notify(`Elena picks the model for ${target} automatically again.`, "ok");
    } else {
      const info = router.info(name);
      if (!info)
        return ui.notify(`${normalize(name)} isn't installed. /pull ${normalize(name)} to download it.`, "error");
      if (!info.tools)
        return ui.notify(`${info.name} doesn't support tool calling, which Elena needs.`, "error");
      router.pin(task, info.name);
      ui.notify(`Using ${info.name} for ${target}. /model auto to undo.`, "ok");
    }
    if (router.envPinned)
      ui.notify(`Note: ELENA_MODEL is set, so it overrides this until you unset it.`, "warn");
  }

  /** `/resume` lists conversations; `/resume <n>` or `/resume last` loads one. */
  function resumeCommand(arg?: string) {
    const past = memory.listConversations(root, 10);
    if (!arg) {
      if (!past.length) return ui.notify("No saved conversations in this project yet.");
      console.log(
        past
          .map((c, i) => {
            const current = c.id === conversationId ? chalk.cyan("  (current)") : "";
            return `  ${String(i + 1).padStart(2)}. ${chalk.dim(ago(c.updated_at).padEnd(11))} ${c.title}  ${chalk.dim(`${c.turns} turn${c.turns === 1 ? "" : "s"}`)}${current}`;
          })
          .join("\n") + chalk.dim("\n  /resume <n> to continue one"),
      );
      return;
    }
    const others = past.filter((c) => c.id !== conversationId);
    const pick = arg === "last" ? others[0] : past[Number(arg) - 1];
    if (!pick) return ui.notify(arg === "last" ? "No earlier conversation to resume." : `No conversation #${arg}. /resume to list them.`, "error");
    if (pick.id === conversationId) return ui.notify("That's the conversation you're in.");

    const { kept, dropped } = fitHistory(memory.getMessages(pick.id));
    agent.loadHistory(kept);
    conversationId = pick.id;
    lastTask = undefined;
    ui.notify(`↺ Resumed "${pick.title}" (${pick.turns} turn${pick.turns === 1 ? "" : "s"}, last active ${ago(pick.updated_at)}).`, "ok");
    if (dropped)
      ui.notify(`Loaded the latest ${kept.length} messages; the ${dropped} before them are too long to fit in the model's context.`, "step");

    // Remind the user where they left off.
    const lastUser = [...kept].reverse().find((m) => m.role === "user");
    const lastAnswer = [...kept].reverse().find((m) => m.role === "assistant" && m.content.trim());
    const clip = (t: string, n: number) => {
      const one = t.replace(/\s+/g, " ").trim();
      return one.length > n ? one.slice(0, n) + "…" : one;
    };
    if (lastUser) console.log(chalk.dim(`  you › ${clip(lastUser.content, 120)}`));
    if (lastAnswer) console.log(chalk.dim(`  elena › ${clip(lastAnswer.content, 300)}`));
    warmUp("Resumed conversation");
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
        await review();
        return true;
      case "/model":
        await modelCommand(rest);
        return true;
      case "/pull":
        if (!rest[0]) ui.notify("Usage: /pull <model>, e.g. /pull qwen3:8b", "error");
        else pull(rest[0]);
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
      case "/resume":
        resumeCommand(rest[0]);
        return true;
      case "/new":
        agent.reset();
        conversationId = undefined;
        lastTask = undefined;
        ui.notify("Started a fresh conversation. /resume to go back to earlier ones.", "ok");
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

  console.log(
    chalk.bold.magenta("Elena") + chalk.dim(" — local developer assistant"),
  );
  console.log(
    chalk.dim(`${greeting()}. Project: ${root}  ·  ${modelSummary()}`),
  );
  if (!ollamaUp)
    ui.notify(`Can't reach Ollama at ${config.host}. Start it with: brew services start ollama`, "error");
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
  if (isMac) {
    const mac = statusLine(await macStatus());
    console.log((mac.warn ? chalk.yellow : chalk.dim)(`Mac: ${mac.text}`));
  }
  const lastChat = memory.listConversations(root, 1)[0];
  if (lastChat)
    console.log(
      chalk.dim(`Last conversation ${ago(lastChat.updated_at)}: "${lastChat.title}" (/resume last).`),
    );
  const remembered = memory.list(root).length;
  if (remembered)
    console.log(
      chalk.dim(
        `Remembering ${remembered} thing${remembered === 1 ? "" : "s"} (/memories to see).`,
      ),
    );
  console.log("\n" + cheatSheet());
  warmUp("Starting up");
  console.log(chalk.dim(`\ntype 'exit' to quit.\n`));

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
    await turn(input, classify(input, lastTask));
  }
  await shutdown(0);
}

main();
