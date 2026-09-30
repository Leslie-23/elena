import path from "node:path";
import {
  EXPERTS,
  EXPERT_LABELS,
  checkExperts,
  killExpert,
  runExpert,
  type Availability,
  type ExpertMode,
  type ExpertName,
} from "./experts.js";
import type { BackgroundTask, SubagentManager } from "./subagents.js";
import type { MemoryStore } from "./memory/store.js";

export interface EscalationDeps {
  root: string;
  tasks: SubagentManager;
  memory: MemoryStore;
  confirm(question: string): Promise<boolean>;
  /** A step from a running expert, e.g. "Read src/booking.js". */
  onStep(id: number, step: string): void;
}

export interface AskOptions {
  expert?: ExpertName;
  mode: ExpertMode;
  background: boolean;
  /** The user typed the command themselves, so read-only runs don't need another yes. */
  userInitiated: boolean;
  /** Continue this earlier session; `task` is then the follow-up message. */
  resume?: string;
}

/** Hands heavy tasks to Claude Code or Codex, after the user agrees to send the work off the Mac. */
export class Escalation {
  private availability?: Record<ExpertName, Availability>;
  /** How many handoffs the user has said no to; the CLI uses it so one "no" isn't followed by another ask. */
  declines = 0;

  constructor(private deps: EscalationDeps) {}

  async refresh(): Promise<Record<ExpertName, Availability>> {
    this.availability = await checkExperts();
    return this.availability;
  }

  async status(): Promise<Record<ExpertName, Availability>> {
    return this.availability ?? this.refresh();
  }

  /** Usable experts, Claude first. */
  async available(): Promise<ExpertName[]> {
    const a = await this.status();
    return EXPERTS.filter((e) => a[e].installed && a[e].loggedIn);
  }

  /**
   * Start (or run) an expert on `task`. Returns a message for whoever asked: the report in the
   * foreground, or a note that the task started in the background.
   */
  async ask(task: string, opts: AskOptions): Promise<{ message: string; task?: BackgroundTask }> {
    const usable = await this.available();
    const expert = opts.expert ?? usable[0];
    if (!expert) {
      const a = await this.status();
      const hints = EXPERTS.map((e) => `${EXPERT_LABELS[e]}: ${a[e].fix ?? "ready"}`).join("; ");
      return { message: `Neither Claude Code nor Codex is ready. ${hints}` };
    }
    if (!usable.includes(expert)) {
      return { message: `${EXPERT_LABELS[expert]} isn't ready. Run: ${(await this.status())[expert].fix}` };
    }

    // Sending code off the Mac is the user's call. Edits always need a yes, even from a typed command.
    const where = path.basename(this.deps.root);
    if (!opts.userInitiated || opts.mode === "edit") {
      const what =
        opts.mode === "edit"
          ? expert === "claude"
            ? `It can read and EDIT files in ${where} (no shell commands).`
            : `It can read and EDIT files in ${where}, and run commands in a sandbox limited to the project.`
          : `It can read files in ${where} but not change anything.`;
      const ok = await this.deps.confirm(
        `${opts.resume ? "Send this follow-up" : "Send this"} to ${EXPERT_LABELS[expert]} (uses your ${expert === "claude" ? "Claude" : "OpenAI"} account)?\n    ${task}\n  ${what}`,
      );
      if (!ok) {
        this.declines++;
        return {
          message:
            "User declined to send this to a cloud agent. Don't offer the handoff again for this request. " +
            "If they wanted code changed, say in one line that you can't edit files yourself, and give the change as a short snippet they can apply.",
        };
      }
    }

    const label = `${EXPERT_LABELS[expert]}${opts.resume ? " follow-up" : ""}${opts.mode === "edit" ? " (edit)" : ""}`;
    // Record the session as soon as its id is known, so it can be continued even if this run fails or is cancelled.
    const record = (sessionId: string) =>
      this.deps.memory.saveExpertSession({ sessionId, root: this.deps.root, expert, mode: opts.mode, task: task.slice(0, 500) });
    if (!opts.background) {
      let sessionId: string | undefined;
      const run = runExpert(expert, {
        task,
        mode: opts.mode,
        root: this.deps.root,
        resume: opts.resume,
        onStep: (s) => this.deps.onStep(0, s),
        onSession: (id) => record((sessionId = id)),
      });
      const report = await run.result;
      return { message: `${label} report (session ${sessionId?.slice(0, 8) ?? "?"}; follow up with ask_expert follow_up):\n${report}` };
    }

    const bg = this.deps.tasks.track(expert, task, label, (bg) => {
      bg.mode = opts.mode;
      const run = runExpert(expert, {
        task,
        mode: opts.mode,
        root: this.deps.root,
        resume: opts.resume,
        onSession: (id) => {
          bg.sessionId = id;
          record(id);
        },
        onStep: (s) => {
          if (bg.status !== "running") return; // late output after a cancel
          bg.steps++;
          this.deps.onStep(bg.id, s);
        },
      });
      bg.cancel = () => killExpert(run.child);
      return run.result;
    });
    return {
      message: `Started ${label} as background task #${bg.id}. Tell the user it's running; the report will be given to you when it finishes.`,
      task: bg,
    };
  }
}
