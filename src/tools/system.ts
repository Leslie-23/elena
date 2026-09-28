import { defineTool, str } from "./types.js";
import os from "node:os";
import { run } from "./exec.js";

export const portOwnerTool = defineTool(
  "port_owner",
  "Show which process is listening on one specific TCP port. To list all ports in use, use listening_ports.",
  { port: { type: "number", description: "TCP port number, e.g. 6969", required: true } },
  async (args) => {
    const port = Number(str(args, "port"));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return `Invalid port: ${args.port}`;
    const res = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], process.cwd());
    if (!res.stdout.trim()) return `Nothing is listening on port ${port}.`;
    return res.stdout;
  },
);

// Well-known ports and processes, so the list says what things are.
const PORT_HINTS: Record<number, string> = {
  3000: "dev server (React/Next/Express default)", 3306: "MySQL", 4200: "Angular dev server", 5173: "Vite dev server",
  5432: "PostgreSQL", 5037: "Android Debug Bridge", 6379: "Redis", 8080: "HTTP dev server", 8081: "Metro bundler (React Native)",
  9229: "Node debugger", 11434: "Ollama", 19000: "Expo", 27017: "MongoDB",
};
const PROCESS_HINTS: [RegExp, string][] = [
  [/^ControlCenter$/, "macOS AirPlay Receiver"],
  [/^rapportd$/, "macOS Continuity (Handoff/AirDrop)"],
  [/^qemu-system/, "Android emulator"],
  [/^netsimd$/, "Android emulator networking"],
  [/^llama-server$|^ollama/, "Ollama model runner"],
  [/^Code Helper/, "VS Code extension"],
];

/** A readable name from a full executable path: "Code Helper (Plugin) (Visual Studio Code)". */
function processLabel(exe: string): string {
  // Some servers (redis) rewrite their title to "redis-server 127.0.0.1:6379"; keep just the name.
  const name = (exe.split("/").pop() || exe).replace(/\s+(\*|\[|\d{1,3}(\.\d{1,3}){3})\S*:\d+.*$/, "");
  const app = exe.match(/\/([^/]+)\.app\//)?.[1];
  return app && app !== name ? `${name} (${app})` : name;
}

export const listeningPortsTool = defineTool(
  "listening_ports",
  "List every TCP port that something is listening on, with the process, pid and whether it's reachable from other machines. " +
    "Use this for 'what ports are in use' / 'what's running'; use port_owner for one specific port.",
  { filter: { type: "string", description: "Only show ports or processes containing this text, e.g. 'node' or '80' (optional)" } },
  async (args) => {
    const res = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], process.cwd());
    const rows = res.stdout.trim().split("\n").slice(1);
    if (!rows.length) return "Nothing is listening on any TCP port (or lsof isn't available).";

    // One entry per port, merging IPv4/IPv6 lines.
    const ports = new Map<number, { pid: string; short: string; external: boolean }>();
    for (const row of rows) {
      const cols = row.trim().split(/\s+/);
      const addr = cols.find((c) => /:\d+$/.test(c));
      if (!addr) continue;
      const port = Number(addr.slice(addr.lastIndexOf(":") + 1));
      const local = /^(127\.0\.0\.1|\[::1\]|localhost):/.test(addr);
      const prev = ports.get(port);
      ports.set(port, { pid: cols[1], short: cols[0].replace(/\\x20/g, " "), external: (prev?.external ?? false) || !local });
    }

    // Full process names from ps (lsof truncates them).
    const pids = [...new Set([...ports.values()].map((p) => p.pid))];
    const names = new Map<string, string>();
    const ps = await run("ps", ["-o", "pid=,comm=", "-p", pids.join(",")], process.cwd());
    for (const line of ps.stdout.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (m) names.set(m[1], processLabel(m[2]));
    }

    // For generic runtimes, "node" alone says nothing: show the folder it runs in (the project).
    const RUNTIMES = /^(node|python\d*(\.\d+)?|java|ruby|deno|bun|php|go|dotnet|uvicorn|gunicorn)$/;
    const runtimePids = pids.filter((pid) => RUNTIMES.test(names.get(pid) ?? ""));
    const cwds = new Map<string, string>();
    if (runtimePids.length) {
      const out = (await run("lsof", ["-a", "-p", runtimePids.join(","), "-d", "cwd", "-Fpn"], process.cwd())).stdout;
      let pid = "";
      for (const line of out.split("\n")) {
        if (line.startsWith("p")) pid = line.slice(1);
        else if (line.startsWith("n") && pid) cwds.set(pid, line.slice(1).replace(os.homedir(), "~"));
      }
    }

    const needle = typeof args.filter === "string" ? args.filter.toLowerCase() : "";
    const lines = [...ports.entries()]
      .sort(([a], [b]) => a - b)
      .map(([port, p]) => {
        const name = names.get(p.pid) ?? p.short;
        const hint = PORT_HINTS[port] ?? PROCESS_HINTS.find(([re]) => re.test(name))?.[1];
        const where = cwds.get(p.pid) ? ` in ${cwds.get(p.pid)}` : "";
        return `${String(port).padEnd(6)} ${name} (pid ${p.pid})${where}${p.external ? "" : ", localhost only"}${hint ? `  — ${hint}` : ""}`;
      })
      .filter((l) => !needle || l.toLowerCase().includes(needle));
    return lines.length ? lines.join("\n") : `No listening ports match "${args.filter}".`;
  },
);
