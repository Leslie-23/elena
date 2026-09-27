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
