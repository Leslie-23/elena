import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { config } from "./config.js";
import { banner, tagline } from "./brand.js";
import { ollama } from "./llm.js";
import { hasRipgrep, run } from "./tools/exec.js";
import { APP, ensureNotifier } from "./notifier.js";

/**
 * `elena setup`: check this machine and connect Elena to Claude Code and Codex.
 * Safe to re-run; it only changes things you say yes to.
 */

const ok = (msg: string) => console.log(`  ${chalk.green("✓")} ${msg}`);
const bad = (msg: string, fix?: string) => console.log(`  ${chalk.yellow("✗")} ${msg}${fix ? chalk.dim(`\n      → ${fix}`) : ""}`);
const info = (msg: string) => console.log(chalk.dim(`    ${msg}`));

/** The command MCP clients should run. Absolute paths, because GUI apps and agents don't share your shell's PATH. */
function mcpCommand(): string[] {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  return [process.execPath, path.join(repo, "dist", "index.js"), "mcp"];
}

/** A tool-capable model that fits this machine's RAM. */
function recommendedModel(): { name: string; gb: number } {
  const ram = os.totalmem() / 1e9;
  if (ram >= 24) return { name: "qwen3:14b", gb: 9.3 };
  if (ram >= 12) return { name: "qwen3:8b", gb: 5.2 };
  return { name: "qwen3:4b", gb: 2.5 };
}

export async function runSetup() {
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (q: string) => /^y(es)?$/i.test((await rl.question(chalk.cyan(`    ${q} [y/N] `))).trim());
  const isMac = process.platform === "darwin";

  console.log("\n" + banner([tagline, chalk.dim("setup")]) + "\n");

  // 1. Node
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node}; Elena needs 22 or newer (for built-in SQLite)`, "https://nodejs.org or `nvm install 22`");

  // 2. Build
  const script = mcpCommand()[1];
  if (existsSync(script)) ok("Elena is built");
  else bad("dist/ is missing", "run `npm install` (or `npm run build`) in the elena folder");

  // 3. Ollama, running, and a model
  const ollamaV = await run("ollama", ["--version"], "/");
  let models: string[] = [];
  if (!ollamaV.ok) {
    bad("Ollama isn't installed", isMac ? "brew install ollama && brew services start ollama" : "curl -fsSL https://ollama.com/install.sh | sh");
  } else {
    ok(`Ollama ${ollamaV.stdout.match(/[\d.]+/)?.[0] ?? ""}`);
    try {
      models = (await ollama.list()).models.map((m) => m.name);
      ok(`Ollama is running at ${config.host}`);
    } catch {
      bad("Ollama isn't running", isMac ? "brew services start ollama" : "ollama serve (or: systemctl start ollama)");
    }
  }
  if (models.length) {
    ok(`Models: ${models.join(", ")}`);
  } else if (ollamaV.ok) {
    const rec = recommendedModel();
    bad("No models downloaded yet");
    if (await ask(`Download ${rec.name} (~${rec.gb} GB, fits ${Math.round(os.totalmem() / 1e9)} GB of RAM)?`)) {
      try {
        let last = -1;
        for await (const p of await ollama.pull({ model: rec.name, stream: true })) {
          if (!p.total || !p.completed || p.total < 100e6) continue;
          const pct = Math.floor((p.completed / p.total) * 100);
          if (pct !== last) stdout.write(`\r    ${rec.name} ${pct}%   `);
          last = pct;
        }
        stdout.write("\n");
        ok(`${rec.name} is ready`);
      } catch (err) {
        bad(`Download failed: ${err instanceof Error ? err.message : String(err)}`, `ollama pull ${rec.name}`);
      }
    }
  }

  // 4. ripgrep (optional)
  if (await hasRipgrep()) ok("ripgrep (fast search)");
  else bad("ripgrep isn't installed; search falls back to grep", isMac ? "brew install ripgrep" : "apt install ripgrep");

  // 4b. macOS notifications that carry Elena's icon
  if (isMac) {
    const state = await ensureNotifier();
    if (state === "unavailable") bad("Notifications will show Script Editor's icon (building Elena.app needs Swift)", "xcode-select --install, then run elena setup again");
    else ok(`Notifications come from ${APP.replace(os.homedir(), "~")} with Elena's icon${state === "built" ? " (just built)" : ""}`);
  }

  // 5. `elena` on PATH
  const which = await run("which", ["elena"], "/");
  if (which.ok) ok(`\`elena\` command: ${which.stdout.trim()}`);
  else bad("`elena` isn't on your PATH", "run `npm link` in the elena folder");

  // 6. Connect to Claude Code and Codex as an MCP server
  const cmd = mcpCommand();
  console.log(chalk.bold("\n  Let Claude Code and Codex use Elena"));
  info(`Server command: ${cmd.join(" ")}`);

  for (const client of ["claude", "codex"] as const) {
    const label = client === "claude" ? "Claude Code" : "Codex";
    const v = await run(client, ["--version"], "/");
    if (!v.ok) {
      bad(`${label} isn't installed`, client === "claude" ? "https://claude.com/claude-code" : "npm install -g @openai/codex");
      continue;
    }
    const existing = await run(client, ["mcp", "get", "elena"], "/");
    if (existing.ok) {
      ok(`${label} already has Elena (\`${client} mcp get elena\` to see it)`);
      continue;
    }
    if (!(await ask(`Add Elena to ${label} for all your projects?`))) {
      info(`Skipped. To do it later: ${client} mcp add ${client === "claude" ? "--scope user " : ""}elena -- ${cmd.join(" ")}`);
      continue;
    }
    const args = client === "claude" ? ["mcp", "add", "--scope", "user", "elena", "--", ...cmd] : ["mcp", "add", "elena", "--", ...cmd];
    const res = await run(client, args, "/");
    if (res.ok) ok(`Added Elena to ${label}. In a new ${label} session, ask it to use Elena (e.g. "ask Elena what's on port 6969").`);
    else bad(`Couldn't add Elena to ${label}: ${(res.stderr || res.stdout).trim()}`);
  }

  console.log(chalk.dim("\n  Run `elena` in a project folder to start chatting.\n"));
  rl.close();
}
