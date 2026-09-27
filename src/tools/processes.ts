import path from "node:path";
import { describeProcess, portInUse } from "../processes.js";
import { defineTool, str } from "./types.js";
import { resolveInRoot } from "./exec.js";

const EARLY_OUTPUT_MS = 3000;

export const startProcessTool = defineTool(
  "start_process",
  "Start a long-running process in the background (dev server, watcher, bundler) and keep it running. " +
    "The user must approve. Give it a short name; pass port if it serves one, so you are told when it's up. " +
    "Use run_command for commands that finish on their own.",
  {
    name: { type: "string", description: "Short name, e.g. 'api' or 'metro'", required: true },
    command: { type: "string", description: "Command line, e.g. 'npm run dev'", required: true },
    cwd: { type: "string", description: "Working directory relative to the project root (default '.')" },
    port: { type: "number", description: "Port the process should listen on (optional)" },
  },
  async (args, ctx) => {
    const name = str(args, "name");
    const cwd = await resolveInRoot(ctx.root, str(args, "cwd", "."));
    const port = args.port === undefined ? undefined : Number(args.port);
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return `Invalid port: ${args.port}`;
    if (port && (await portInUse(port))) {
      return `Port ${port} is already in use, so ${name} would fail to bind. Check it with port_owner before starting.`;
    }

    const proc = ctx.processes.start(name, str(args, "command"), cwd, port);
    ctx.notify?.(`▶ Started ${name} (pid ${proc.pid}) in the background. /logs ${name} to watch.`);

    // Give it a moment so an instant crash (missing script, bad cwd) is reported now, not later.
    const deadline = Date.now() + EARLY_OUTPUT_MS;
    while (Date.now() < deadline && proc.status !== "exited") await new Promise((r) => setTimeout(r, 200));

    const early = proc.lines.slice(-20).join("\n") || "(no output yet)";
    if (proc.status === "exited") return `${name} exited immediately with code ${proc.exitCode}. Output:\n${early}`;
    return `Started ${name} (pid ${proc.pid})${port ? `, waiting for :${port}` : ""}. First output:\n${early}`;
  },
  {
    requiresConfirmation: true,
    confirmMessage: (args) => {
      const cwd = typeof args.cwd === "string" && args.cwd !== "." ? ` in ${path.normalize(args.cwd)}` : "";
      const port = args.port ? ` on :${args.port}` : "";
      return `Elena wants to start "${String(args.name)}"${port}${cwd}:\n\n    ${String(args.command)}\n\n  It keeps running in the background until stopped. Allow?`;
    },
  },
);

export const listProcessesTool = defineTool(
  "list_processes",
  "List background processes Elena has started, with status, pid and port.",
  {},
  async (_args, ctx) => ctx.processes.list().map(describeProcess).join("\n") || "No background processes.",
);

export const processLogsTool = defineTool(
  "process_logs",
  "Read recent output from a background process Elena started.",
  {
    name: { type: "string", description: "Process name", required: true },
    lines: { type: "number", description: "How many recent lines (default 50, max 300)" },
    filter: { type: "string", description: "Only lines containing this text, case-insensitive (optional)" },
  },
  async (args, ctx) => {
    const count = Math.min(300, Math.max(1, Number(args.lines) || 50));
    return ctx.processes.logs(str(args, "name"), count, typeof args.filter === "string" ? args.filter : undefined);
  },
);

export const stopProcessTool = defineTool(
  "stop_process",
  "Stop a background process Elena started (and everything it spawned).",
  { name: { type: "string", description: "Process name", required: true } },
  async (args, ctx) => {
    const name = str(args, "name");
    if (!(await ctx.processes.stop(name))) return `No running process named "${name}".`;
    ctx.notify?.(`■ Stopped ${name}.`);
    return `Stopped ${name}.`;
  },
);

export const scanProjectTool = defineTool(
  "scan_project",
  "Scan the project: stack, packages and scripts, ports, git branch and layout. Refreshes your project summary. " +
    "Use when the user asks to scan, analyse or get an overview of the project, or your summary is missing or out of date.",
  {},
  async (_args, ctx) => (ctx.scan ? ctx.scan() : "Scanning isn't available here."),
);
