import { defineTool, str } from "./types.js";
import { run } from "./exec.js";

export const portOwnerTool = defineTool(
  "port_owner",
  "Show which process is listening on a TCP port on this Mac.",
  { port: { type: "number", description: "TCP port number, e.g. 6969", required: true } },
  async (args) => {
    const port = Number(str(args, "port"));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return `Invalid port: ${args.port}`;
    const res = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], process.cwd());
    if (!res.stdout.trim()) return `Nothing is listening on port ${port}.`;
    return res.stdout;
  },
);
