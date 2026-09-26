import path from "node:path";
import { defineTool, str } from "./types.js";
import { resolveInRoot, runShell } from "./exec.js";

const DEFAULT_TIMEOUT_S = 30;
const MAX_TIMEOUT_S = 300;

export const runCommandTool = defineTool(
  "run_command",
  "Run a shell command (zsh) on the user's Mac. The user must approve every command. " +
    "Prefer the dedicated tools (read_file, search, git_*, port_owner) when they fit. " +
    "Do not run long-lived servers or watch commands; they are killed at the timeout.",
  {
    command: { type: "string", description: "The command line to run, e.g. 'curl -s localhost:6969/health'", required: true },
    cwd: { type: "string", description: "Working directory relative to the project root (default '.')" },
    timeout_seconds: { type: "number", description: `Kill after this many seconds (default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S})` },
  },
  async (args, ctx) => {
    const command = str(args, "command");
    const cwd = await resolveInRoot(ctx.root, str(args, "cwd", "."));
    const timeoutS = Math.min(MAX_TIMEOUT_S, Math.max(1, Number(args.timeout_seconds) || DEFAULT_TIMEOUT_S));

    const res = await runShell(command, cwd, timeoutS * 1000);
    const parts = [res.timedOut ? `Timed out after ${timeoutS}s (process killed).` : `Exit code: ${res.code}`];
    if (res.stdout.trim()) parts.push(`stdout:\n${res.stdout.trimEnd()}`);
    if (res.stderr.trim()) parts.push(`stderr:\n${res.stderr.trimEnd()}`);
    if (!res.stdout.trim() && !res.stderr.trim()) parts.push("(no output)");
    return parts.join("\n\n");
  },
  {
    requiresConfirmation: true,
    confirmMessage: (args) => {
      const cwd = typeof args.cwd === "string" && args.cwd !== "." ? ` (in ${path.normalize(args.cwd)})` : "";
      return `Elena wants to run${cwd}:\n\n    ${String(args.command)}\n\n  Allow?`;
    },
  },
);
