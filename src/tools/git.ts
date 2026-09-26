import { defineTool, str } from "./types.js";
import { resolveInRoot, run } from "./exec.js";

async function git(root: string, args: string[]): Promise<string> {
  const res = await run("git", args, await resolveInRoot(root));
  if (!res.ok) return `git ${args[0]} failed: ${res.stderr.trim()}`;
  return res.stdout.trim() || "(no output)";
}

export const gitStatusTool = defineTool(
  "git_status",
  "Show the current branch and changed files in the project's git repository.",
  {},
  (_args, ctx) => git(ctx.root, ["status", "--short", "--branch"]),
);

export const gitDiffTool = defineTool(
  "git_diff",
  "Show uncommitted changes. Optionally for one file, or staged changes only.",
  {
    path: { type: "string", description: "Limit the diff to this file (optional)" },
    staged: { type: "boolean", description: "Show staged changes instead of unstaged (optional)" },
  },
  (args, ctx) => {
    const argv = ["diff", "--no-color"];
    if (args.staged === true) argv.push("--staged");
    if (typeof args.path === "string") argv.push("--", args.path);
    return git(ctx.root, argv);
  },
);

export const gitLogTool = defineTool(
  "git_log",
  "Show recent commits (one line each).",
  { count: { type: "number", description: "How many commits (default 15, max 50)" } },
  (args, ctx) => {
    const n = Math.min(50, Math.max(1, Number(str(args, "count", "15")) || 15));
    return git(ctx.root, ["log", "--oneline", "--decorate", `-n${n}`]);
  },
);
