import type { ToolSchema } from "../llm.js";
import type { MemoryStore } from "../memory/store.js";
import type { ProcessManager } from "../processes.js";

export interface ToolContext {
  /** Directory Elena is allowed to read. Paths outside it are rejected. */
  root: string;
  memory: MemoryStore;
  processes: ProcessManager;
  /** Scan the project, save the result and refresh Elena's context. Returns the summary. */
  scan?(): Promise<string>;
  /** Ask the user before doing something risky. Resolves true if approved. */
  confirm(question: string): Promise<boolean>;
  /** Show the user a status line (e.g. "saved memory"). */
  notify?(message: string): void;
  /** Hand a task to a subagent. Absent inside subagents, so they can't spawn more. */
  subagents?: SubagentRunner;
  /** Hand a heavy task to Claude Code or Codex. Absent inside subagents. */
  escalation?: import("../escalate.js").Escalation;
}

export interface SubagentRunner {
  /** Foreground: resolves with the report. Background: resolves at once with a note about the started task. */
  run(task: string, opts: { background: boolean }): Promise<string>;
}

export interface Tool {
  schema: ToolSchema;
  /** If true, the agent asks the user before running it. Enforced in code, not in the prompt. */
  requiresConfirmation?: boolean;
  /** What to show the user when asking for confirmation. Defaults to the tool name and raw args. */
  confirmMessage?(args: Record<string, unknown>): string;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export function defineTool(
  name: string,
  description: string,
  params: Record<string, { type: string; description: string; required?: boolean }>,
  run: Tool["run"],
  opts: Pick<Tool, "requiresConfirmation" | "confirmMessage"> = {},
): Tool {
  const properties: Record<string, { type: string; description: string }> = {};
  const required: string[] = [];
  for (const [key, { type, description, required: req }] of Object.entries(params)) {
    properties[key] = { type, description };
    if (req) required.push(key);
  }
  return {
    schema: {
      type: "function",
      function: { name, description, parameters: { type: "object", properties, required } },
    },
    run,
    ...opts,
  };
}

export function str(args: Record<string, unknown>, key: string, fallback?: string): string {
  const v = args[key];
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number") return String(v);
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required argument: ${key}`);
}
