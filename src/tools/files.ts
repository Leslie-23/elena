import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { defineTool, str } from "./types.js";
import { hasRipgrep, resolveInRoot, run } from "./exec.js";

const SECRET_PATTERNS = [/\.env$/, /\.env\./, /id_rsa/, /id_ed25519/, /\.pem$/, /\.key$/];
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "Pods", "ios/build"]);

export const readFileTool = defineTool(
  "read_file",
  "Read a text file inside the project. Optionally a line range.",
  {
    path: { type: "string", description: "File path relative to the project root", required: true },
    start_line: { type: "number", description: "First line to read (1-based, optional)" },
    end_line: { type: "number", description: "Last line to read (inclusive, optional)" },
  },
  async (args, ctx) => {
    const file = await resolveInRoot(ctx.root, str(args, "path"));
    const rel = path.relative(ctx.root, file);
    if (SECRET_PATTERNS.some((re) => re.test(rel))) {
      const ok = await ctx.confirm(`Elena wants to read ${rel}, which may contain secrets. Allow?`);
      if (!ok) return "User declined to share this file.";
    }
    const info = await stat(file);
    if (info.isDirectory()) return `${rel} is a directory. Use list_directory.`;
    if (info.size > 1_000_000) return `${rel} is ${info.size} bytes; too large. Use a line range or search.`;

    const lines = (await readFile(file, "utf8")).split("\n");
    const start = Math.max(1, Number(args.start_line ?? 1));
    const end = Math.min(lines.length, Number(args.end_line ?? lines.length));
    return lines
      .slice(start - 1, end)
      .map((l, i) => `${start + i}\t${l}`)
      .join("\n");
  },
);

export const listDirectoryTool = defineTool(
  "list_directory",
  "List files and folders in a directory inside the project (skips node_modules, .git, build output).",
  { path: { type: "string", description: "Directory relative to the project root (default '.')" } },
  async (args, ctx) => {
    const dir = await resolveInRoot(ctx.root, str(args, "path", "."));
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => !IGNORED_DIRS.has(e.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .join("\n") || "(empty)";
  },
);

export const searchTool = defineTool(
  "search",
  "Search file contents in the project for a regex pattern (case-insensitive unless it has capitals). Returns file:line:match.",
  {
    pattern: { type: "string", description: "Regex or plain text to search for", required: true },
    path: { type: "string", description: "Subdirectory to limit the search to (default '.')" },
    glob: { type: "string", description: "Only search files matching this glob, e.g. '*.ts' or '*.ts,*.js' (optional)" },
  },
  async (args, ctx) => {
    const dir = await resolveInRoot(ctx.root, str(args, "path", "."));
    const pattern = str(args, "pattern");
    // Models often write "*.ts,*.js" or "*.ts *.js"; rg and grep need one pattern per flag.
    const globs = typeof args.glob === "string" ? args.glob.split(/[,\s]+/).filter(Boolean) : [];

    // `--` ends option parsing so a pattern like "--pre=sh" can't become a flag.
    const res = (await hasRipgrep())
      ? await run("rg", ["-n", "--smart-case", "--max-count", "20", "--max-columns", "300", ...globs.flatMap((g) => ["-g", g]), "--", pattern, "."], dir)
      : await run(
          "grep",
          // Same as rg --smart-case: ignore case unless the pattern has capitals.
          [pattern === pattern.toLowerCase() ? "-rniE" : "-rnE", ...[...IGNORED_DIRS].map((d) => `--exclude-dir=${d}`), ...globs.map((g) => `--include=${g}`), "--", pattern, "."],
          dir,
        );

    if (res.code === 1) {
      return `No matches for "${pattern}"${globs.length ? ` in ${globs.join(", ")}` : ""}. Try a shorter pattern (just the key word or identifier), ` +
        "other words, or read the likely file from the file list, before concluding it isn't there.";
    }
    if (!res.ok) return `Search failed: ${res.stderr}`;
    return res.stdout;
  },
);
