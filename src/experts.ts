import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "./tools/exec.js";

/**
 * Cloud coding agents Elena can hand heavy work to: Claude Code (`claude -p`) and Codex (`codex exec`).
 * They run in the project folder, read-only unless the user approves edit mode, and never run shell commands
 * in edit mode for Claude (Codex's sandbox allows commands but confines writes to the project).
 */
export type ExpertName = "claude" | "codex";
export const EXPERTS: ExpertName[] = ["claude", "codex"];
export type ExpertMode = "read" | "edit";

export const EXPERT_LABELS: Record<ExpertName, string> = { claude: "Claude Code", codex: "Codex" };

export interface Availability {
  installed: boolean;
  loggedIn: boolean;
  version?: string;
  /** What to run to fix it, if not usable. */
  fix?: string;
}

const TIMEOUT_MS = 15 * 60_000;

/** Check whether each CLI is installed and signed in. Takes ~1s (it asks the CLIs). */
export async function checkExperts(): Promise<Record<ExpertName, Availability>> {
  const [claudeV, codexV] = await Promise.all([run("claude", ["--version"], "/"), run("codex", ["--version"], "/")]);
  const claude: Availability = { installed: claudeV.ok, loggedIn: false, version: claudeV.stdout.trim().split(" ")[0] };
  const codex: Availability = { installed: codexV.ok, loggedIn: false, version: codexV.stdout.trim().split(" ").pop() };

  await Promise.all([
    claude.installed &&
      run("claude", ["auth", "status"], "/").then((r) => {
        try {
          claude.loggedIn = JSON.parse(r.stdout).loggedIn === true;
        } catch {
          claude.loggedIn = r.ok;
        }
      }),
    codex.installed &&
      run("codex", ["login", "status"], "/").then((r) => {
        codex.loggedIn = r.ok && !/not logged in/i.test(r.stdout + r.stderr);
      }),
  ]);

  if (!claude.installed) claude.fix = "curl -fsSL https://claude.ai/install.sh | bash";
  else if (!claude.loggedIn) claude.fix = "claude auth login";
  if (!codex.installed) codex.fix = "npm install -g @openai/codex";
  else if (!codex.loggedIn) codex.fix = "codex login";
  return { claude, codex };
}

export interface ExpertRun {
  child: ChildProcess;
  /** Resolves with the expert's final answer. */
  result: Promise<string>;
}

export interface ExpertRunOptions {
  task: string;
  mode: ExpertMode;
  root: string;
  /** Called for each thing the expert does (a file read, a search, an edit, a command). */
  onStep(step: string): void;
  /** Continue this earlier session instead of starting a new one. `task` is then the follow-up message. */
  resume?: string;
  /** Called with the session id as soon as it's known, so the session can be followed up later. */
  onSession?(id: string): void;
}

function briefing(task: string, mode: ExpertMode, root: string): string {
  return `You are being consulted by Elena, a local developer assistant, on behalf of the user. Work in ${root}.
${mode === "read" ? "Read-only: do not modify any files." : "You may edit files in this project to complete the task. Keep changes focused on the task."}
When you're done, reply with a concise report for Elena: the answer or what you changed first, then the key evidence as path:line.

Task: ${task}`;
}

/** A follow-up in an existing session: the briefing is already in its history, so just restate the mode. */
function followUp(message: string, mode: ExpertMode): string {
  return `Follow-up from the user, via Elena (${mode === "read" ? "still read-only: don't modify files" : "you may edit files in this project"}):

${message}`;
}

const short = (v: unknown) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 100 ? s.slice(0, 97) + "…" : s;
};

/** Parse one line of JSONL, or null. */
function json(line: string): Record<string, any> | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function spawnExpert(cmd: string, args: string[], root: string, stdin?: string): ChildProcess {
  const env = { ...process.env };
  delete env.CLAUDECODE; // let `claude` start even if Elena itself was launched from a Claude Code session
  const child = spawn(cmd, args, { cwd: root, detached: true, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"], env });
  if (stdin !== undefined) child.stdin!.end(stdin);
  return child;
}

/** Collect stdout lines, stderr text and the exit, with a hard timeout that kills the whole process group. */
function watch(child: ChildProcess, onLine: (line: string) => void): Promise<{ code: number | null; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let partial = "";
    let stderr = "";
    let timedOut = false;
    child.stdout!.on("data", (d: Buffer) => {
      const parts = (partial + d.toString()).split("\n");
      partial = parts.pop() ?? "";
      for (const l of parts) if (l.trim()) onLine(l);
    });
    child.stderr!.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
    const timer = setTimeout(() => {
      timedOut = true;
      killExpert(child);
    }, TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (partial.trim()) onLine(partial);
      resolve({ code, stderr, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stderr: err.message, timedOut });
    });
  });
}

export function killExpert(child: ChildProcess) {
  try {
    process.kill(-child.pid!, "SIGTERM");
  } catch {
    // already gone
  }
}

export function runClaude({ task, mode, root, onStep, resume, onSession }: ExpertRunOptions): ExpertRun {
  // Read mode gets search/read tools only; edit mode adds Edit and Write. Neither gets Bash, so nothing is executed.
  // Tools and permissions aren't stored with a session, so they're passed again on every follow-up.
  const tools = mode === "read" ? "Read,Grep,Glob" : "Read,Grep,Glob,Edit,Write";
  // New sessions get an id we choose, so we know it before Claude starts; follow-ups resume it.
  const sessionId = resume ?? randomUUID();
  onSession?.(sessionId);
  const child = spawnExpert(
    "claude",
    [
      "-p", resume ? followUp(task, mode) : briefing(task, mode, root),
      ...(resume ? ["--resume", resume] : ["--session-id", sessionId]),
      "--output-format", "stream-json", "--verbose",
      "--tools", tools,
      "--permission-mode", mode === "read" ? "dontAsk" : "acceptEdits",
      // Skip MCP servers and claude.ai connectors: they add a lot of context (cost) and aren't needed here.
      "--strict-mcp-config",
    ],
    root,
  );

  let final = "";
  let lastText = "";
  const result = watch(child, (line) => {
    const e = json(line);
    if (!e) return;
    if (e.type === "assistant") {
      for (const c of e.message?.content ?? []) {
        if (c.type === "tool_use") {
          const target = c.input?.file_path ?? c.input?.pattern ?? c.input?.path ?? c.input;
          const rel = typeof target === "string" && path.isAbsolute(target) ? path.relative(root, target) || "." : target;
          onStep(`${c.name} ${short(rel)}`);
        }
        if (c.type === "text" && c.text.trim()) lastText = c.text;
      }
    }
    if (e.type === "result") {
      if (typeof e.session_id === "string" && e.session_id !== sessionId) onSession?.(e.session_id);
      final = typeof e.result === "string" ? e.result : lastText;
      if (e.is_error) final = `Claude reported an error: ${final}`;
      // On a Claude plan this is the API-equivalent cost, not a charge.
      const cost = typeof e.total_cost_usd === "number" ? ` · ~$${e.total_cost_usd.toFixed(2)} API-equivalent` : "";
      onStep(`done in ${e.num_turns ?? "?"} turns${cost}`);
    }
  }).then(({ code, stderr, timedOut }) => {
    if (timedOut) throw new Error(`Claude took longer than ${TIMEOUT_MS / 60_000} minutes and was stopped.`);
    if (!final && code !== 0) throw new Error(stderr.trim() || `claude exited with code ${code}`);
    return final || lastText || "(Claude returned no text.)";
  });
  return { child, result };
}

export function runCodex({ task, mode, root, onStep, resume, onSession }: ExpertRunOptions): ExpertRun {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "elena-codex-"));
  const outFile = path.join(outDir, "last-message.txt");
  // Sessions are kept (no --ephemeral) so they can be followed up with `codex exec resume <id>`.
  const child = spawnExpert(
    "codex",
    [
      "exec", "--json",
      "--sandbox", mode === "read" ? "read-only" : "workspace-write",
      "--cd", root, "--skip-git-repo-check",
      "--output-last-message", outFile,
      ...(resume ? ["resume", resume] : []),
      "-", // prompt on stdin
    ],
    root,
    resume ? followUp(task, mode) : briefing(task, mode, root),
  );
  if (resume) onSession?.(resume);

  let lastText = "";
  const result = watch(child, (line) => {
    const e = json(line);
    if (e?.type === "thread.started" && typeof e.thread_id === "string") onSession?.(e.thread_id);
    const item = e?.item;
    if (!item || !String(e?.type).startsWith("item.")) return;
    if (e!.type === "item.started" && item.type === "command_execution") onStep(`$ ${short(item.command)}`);
    if (e!.type === "item.completed" && item.type === "file_change")
      onStep(`edit ${short((item.changes ?? []).map((c: { path?: string }) => c.path).join(", "))}`);
    if (e!.type === "item.completed" && item.type === "agent_message" && item.text) lastText = item.text;
  })
    .then(({ code, stderr, timedOut }) => {
      let final = "";
      try {
        final = readFileSync(outFile, "utf8").trim();
      } catch {
        // no final message file
      }
      if (timedOut) throw new Error(`Codex took longer than ${TIMEOUT_MS / 60_000} minutes and was stopped.`);
      if (!final && !lastText && code !== 0) throw new Error(stderr.trim().split("\n").slice(-3).join(" ") || `codex exited with code ${code}`);
      return final || lastText || "(Codex returned no text.)";
    })
    .finally(() => rmSync(outDir, { recursive: true, force: true }));
  return { child, result };
}

export function runExpert(name: ExpertName, opts: ExpertRunOptions): ExpertRun {
  return name === "claude" ? runClaude(opts) : runCodex(opts);
}
