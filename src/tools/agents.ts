import { defineTool, str } from "./types.js";

export const delegateTool = defineTool(
  "delegate",
  "Hand an investigation to a subagent with its own separate context, e.g. 'find every place currentLegIndex is changed and why'. " +
    "It uses read-only tools (files, search, git, ports, logs) and returns a short report with file:line evidence. " +
    "Use it for questions that need many searches or file reads, so your own context stays small. " +
    "Set background to true for long investigations the user doesn't need to wait for; they keep chatting and you get the report later.",
  {
    task: { type: "string", description: "A self-contained task with everything the subagent needs to know", required: true },
    background: { type: "boolean", description: "Run in the background (default false)" },
  },
  async (args, ctx) => {
    if (!ctx.subagents) return "Subagents aren't available here.";
    return ctx.subagents.run(str(args, "task"), { background: args.background === true });
  },
);

export const askExpertTool = defineTool(
  "ask_expert",
  "Hand a heavy task to a cloud coding agent: Claude Code or Codex. Use only for work too big or hard for you: " +
    "large multi-file changes, hard debugging across many files, deep reviews, designing a feature. " +
    "The user is asked before anything is sent. mode 'read' (default) can only read the project; 'edit' may change files. " +
    "Runs in the background by default (these take minutes); you get the report later.",
  {
    task: { type: "string", description: "A complete, self-contained task description", required: true },
    expert: { type: "string", description: "'claude' or 'codex' (default: whichever is available, Claude first)" },
    mode: { type: "string", description: "'read' (default) or 'edit'" },
    background: { type: "boolean", description: "Run in the background (default true)" },
  },
  async (args, ctx) => {
    if (!ctx.escalation) return "Cloud agents aren't available here.";
    const expert = args.expert === "claude" || args.expert === "codex" ? args.expert : undefined;
    const res = await ctx.escalation.ask(str(args, "task"), {
      expert,
      mode: args.mode === "edit" ? "edit" : "read",
      background: args.background !== false,
      userInitiated: false,
    });
    return res.message;
  },
);
