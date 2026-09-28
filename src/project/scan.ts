import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { hasRipgrep, run } from "../tools/exec.js";

export interface ScanResult {
  summary: string;
  /** One line for the "scan finished" message. */
  headline: string;
  gitHead: string | null;
  ms: number;
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".expo", "coverage", "Pods",
  "vendor", "venv", ".venv", "__pycache__", "target", ".gradle", ".idea", ".vscode", "DerivedData",
]);

const MANIFESTS: Record<string, string> = {
  "package.json": "Node.js",
  "pyproject.toml": "Python",
  "requirements.txt": "Python",
  "go.mod": "Go",
  "Cargo.toml": "Rust",
  Gemfile: "Ruby",
  "pubspec.yaml": "Flutter/Dart",
  Podfile: "iOS (CocoaPods)",
  "build.gradle": "Android/Gradle",
  Dockerfile: "Docker",
  "docker-compose.yml": "Docker Compose",
  "docker-compose.yaml": "Docker Compose",
  "compose.yml": "Docker Compose",
};

// npm dependency → how it shows up in the stack line.
const DEP_LABELS: Record<string, string> = {
  "react-native": "React Native", expo: "Expo", next: "Next.js", react: "React", vue: "Vue",
  svelte: "Svelte", "@angular/core": "Angular", electron: "Electron",
  express: "Express", fastify: "Fastify", "@nestjs/core": "NestJS", koa: "Koa", hono: "Hono",
  mongoose: "MongoDB (Mongoose)", mongodb: "MongoDB", pg: "PostgreSQL", mysql2: "MySQL",
  prisma: "Prisma", "@prisma/client": "Prisma", sequelize: "Sequelize", typeorm: "TypeORM",
  redis: "Redis", ioredis: "Redis", "socket.io": "Socket.IO", graphql: "GraphQL",
  firebase: "Firebase", "@supabase/supabase-js": "Supabase", stripe: "Stripe",
  typescript: "TypeScript", tailwindcss: "Tailwind", jest: "Jest", vitest: "Vitest",
};

interface Pkg {
  file: string;
  name?: string;
  scripts: Record<string, string>;
  deps: string[];
}

/** Walk the tree (depth-limited, skipping build/dependency folders) and collect manifest files. */
async function findManifests(root: string, maxDepth = 3, maxDirs = 3000): Promise<string[]> {
  const found: string[] = [];
  let visited = 0;
  async function walk(dir: string, depth: number) {
    if (depth > maxDepth || ++visited > maxDirs) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) await walk(path.join(dir, e.name), depth + 1);
      else if (e.isFile() && e.name in MANIFESTS) found.push(path.relative(root, path.join(dir, e.name)));
    }
  }
  await walk(root, 0);
  return found.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b));
}

async function readPkg(root: string, file: string): Promise<Pkg | null> {
  try {
    const json = JSON.parse(await readFile(path.join(root, file), "utf8"));
    return {
      file,
      name: json.name,
      scripts: json.scripts ?? {},
      deps: [...Object.keys(json.dependencies ?? {}), ...Object.keys(json.devDependencies ?? {})],
    };
  } catch {
    return null;
  }
}

/** Ports from .env.example files, npm scripts and `listen(…)`/`PORT = …` in source. */
async function findPorts(root: string, pkgs: Pkg[]): Promise<Map<number, string>> {
  const ports = new Map<number, string>();
  const add = (port: number, where: string) => {
    if (port >= 1024 && port <= 65535 && !ports.has(port)) ports.set(port, where);
  };

  for (const pkg of pkgs) {
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      for (const m of cmd.matchAll(/(?:--port[= ]|PORT=|-p )(\d{4,5})/g)) add(Number(m[1]), `${pkg.file} script "${name}"`);
    }
    const dir = path.dirname(pkg.file);
    for (const env of [".env.example", ".env.sample", ".env.template"]) {
      const text = await readFile(path.join(root, dir, env), "utf8").catch(() => "");
      for (const m of text.matchAll(/^\s*\w*PORT\w*\s*=\s*(\d{4,5})/gm)) add(Number(m[1]), path.join(dir, env));
    }
  }

  const pattern = String.raw`(listen\(\s*\d{4,5}|PORT\s*(\|\||\?\?|=|:)\s*['"]?\d{4,5})`;
  const res = (await hasRipgrep())
    ? await run("rg", ["-n", "--max-count", "3", "-g", "*.{js,ts,mjs,cjs,py,go}", "-g", "!**/node_modules/**", "--", pattern, "."], root)
    : await run("grep", ["-rnE", "--include=*.js", "--include=*.ts", ...[...SKIP_DIRS].map((d) => `--exclude-dir=${d}`), "--", pattern, "."], root);
  for (const line of res.stdout.split("\n").slice(0, 50)) {
    const m = line.match(/^\.\/(.+?):(\d+):.*?(\d{4,5})/) ?? line.match(/^(.+?):(\d+):.*?(\d{4,5})/);
    if (m) add(Number(m[3]), `${m[1].replace(/^\.\//, "")}:${m[2]}`);
  }
  return ports;
}

async function gitInfo(root: string) {
  const g = async (...args: string[]) => {
    const r = await run("git", args, root);
    return r.ok ? r.stdout.trim() : null;
  };
  const branch = await g("rev-parse", "--abbrev-ref", "HEAD");
  if (branch === null) return null;
  const status = (await g("status", "--porcelain")) ?? "";
  return {
    branch,
    head: await g("rev-parse", "HEAD"),
    changed: status ? status.split("\n").length : 0,
    last: await g("log", "-1", "--format=%h %s (%cr)"),
    remote: await g("remote", "get-url", "origin"),
  };
}

async function readmeIntro(root: string): Promise<string | null> {
  for (const name of ["README.md", "readme.md", "README"]) {
    const text = await readFile(path.join(root, name), "utf8").catch(() => null);
    if (!text) continue;
    const para = text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p && !p.startsWith("#") && !p.startsWith("[") && !p.startsWith("!") && !p.startsWith("<"));
    return para ? para.replace(/\s+/g, " ").slice(0, 300) : null;
  }
  return null;
}

/** Scan a project without any model calls. `onStep` reports progress for the UI. */
export async function scanProject(root: string, onStep: (msg: string) => void = () => {}): Promise<ScanResult> {
  const started = Date.now();

  onStep("looking for manifests");
  const manifests = await findManifests(root);
  const pkgs = (await Promise.all(manifests.filter((f) => path.basename(f) === "package.json").map((f) => readPkg(root, f)))).filter(
    (p): p is Pkg => p !== null,
  );
  onStep(`found ${manifests.length} manifest${manifests.length === 1 ? "" : "s"} (${pkgs.length} package.json)`);

  const stack = new Set<string>(manifests.map((f) => MANIFESTS[path.basename(f)]));
  const allDeps = new Set(pkgs.flatMap((p) => p.deps));
  for (const [dep, label] of Object.entries(DEP_LABELS)) if (allDeps.has(dep)) stack.add(label);
  if (stack.has("React Native")) stack.delete("React");
  if (stack.has("MongoDB (Mongoose)")) stack.delete("MongoDB");

  onStep("finding ports");
  const ports = await findPorts(root, pkgs);
  if (stack.has("React Native") && !ports.has(8081)) ports.set(8081, "Metro bundler default");

  onStep("reading git");
  const git = await gitInfo(root);
  const readme = await readmeIntro(root);
  const top = (await readdir(root, { withFileTypes: true }))
    .filter((e) => !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .slice(0, 30);

  const name = path.basename(root);
  const lines = [`PROJECT  ${name}`, `STACK    ${[...stack].join(", ") || "unknown"}`];
  if (readme) lines.push(`README   ${readme}`);
  if (pkgs.length) {
    lines.push("PACKAGES");
    for (const p of pkgs.slice(0, 8)) {
      lines.push(`  ${p.file}${p.name ? `  (${p.name})` : ""}`);
      const scripts = Object.entries(p.scripts).slice(0, 8);
      for (const [k, v] of scripts) lines.push(`    ${k}: ${v.length > 80 ? v.slice(0, 80) + "…" : v}`);
    }
  }
  const otherManifests = manifests.filter((f) => path.basename(f) !== "package.json");
  if (otherManifests.length) lines.push(`OTHER    ${otherManifests.slice(0, 10).join(", ")}`);
  if (ports.size) lines.push(`PORTS    ${[...ports].slice(0, 8).map(([p, w]) => `${p} (${w})`).join(", ")}`);
  if (git) {
    lines.push(`GIT      branch ${git.branch} · ${git.changed} changed file${git.changed === 1 ? "" : "s"}${git.last ? ` · last: ${git.last}` : ""}`);
    if (git.remote) lines.push(`REMOTE   ${git.remote}`);
  } else {
    lines.push("GIT      not a git repository");
  }
  lines.push(`LAYOUT   ${top.join("  ")}`);

  const headline = [
    [...stack].slice(0, 4).join(", ") || "stack unknown",
    ports.size ? `ports ${[...ports.keys()].slice(0, 4).join(", ")}` : null,
    git ? `on ${git.branch}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return { summary: lines.join("\n"), headline, gitHead: git?.head ?? null, ms: Date.now() - started };
}

/**
 * A compact list of the project's files, grouped by folder, for the system prompt, so the model knows
 * what exists before it searches. Uses git's view of the tree when available (respects .gitignore).
 * Big projects are cut to the first `maxFiles` files, with a note.
 */
export function fileListing(root: string, maxFiles = 150): string {
  let files: string[] = [];
  try {
    files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 20 * 1024 * 1024,
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    // Not a git repo: walk the tree, skipping dependency and build folders.
    const walk = (dir: string, depth: number) => {
      if (depth > 4 || files.length > maxFiles * 4) return;
      for (const e of readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(rel, depth + 1);
        } else files.push(rel);
      }
    };
    try {
      walk("", 0);
    } catch {
      return "";
    }
  }
  if (!files.length) return "";

  const total = files.length;
  const byDir = new Map<string, string[]>();
  for (const f of files.slice(0, maxFiles)) {
    const dir = path.posix.dirname(f);
    byDir.set(dir, [...(byDir.get(dir) ?? []), path.posix.basename(f)]);
  }
  const lines = [...byDir].map(([dir, names]) => `${dir === "." ? "./" : dir + "/"}: ${names.join("  ")}`);
  if (total > maxFiles) lines.push(`(…and ${total - maxFiles} more files; use list_directory or search)`);
  return lines.join("\n");
}
