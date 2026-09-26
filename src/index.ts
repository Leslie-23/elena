#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { Agent } from "./agent.js";
import { config } from "./config.js";
import { OllamaLLM } from "./llm.js";

function preview(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

async function main() {
  const root = path.resolve(process.argv[2] ?? process.cwd());
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(chalk.red(`Not a directory: ${root}`));
    process.exit(1);
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const confirm = async (q: string) => /^y(es)?$/i.test((await rl.question(chalk.yellow(`? ${q} [y/N] `))).trim());

  const agent = new Agent(new OllamaLLM(), { root, confirm }, {
    onToolCall: (name, args) => console.log(chalk.dim(`  → ${name} ${JSON.stringify(args)}`)),
    onToolResult: (_name, result) => config.debug && console.log(chalk.dim(`    ${preview(result)}`)),
  });

  console.log(chalk.bold.magenta("Elena") + chalk.dim(" — local developer assistant"));
  console.log(chalk.dim(`${greeting()}. Project: ${root}  ·  Model: ${config.model}`));
  console.log(chalk.dim("Type 'exit' to quit.\n"));

  while (true) {
    let input: string;
    try {
      input = (await rl.question(chalk.cyan("you › "))).trim();
    } catch {
      break; // Ctrl+D / closed stdin
    }
    if (!input) continue;
    if (input === "exit" || input === "quit") break;

    try {
      const answer = await agent.send(input);
      console.log(`\n${chalk.magenta("elena ›")} ${answer}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/ECONNREFUSED|fetch failed/.test(msg)) {
        console.error(chalk.red(`Can't reach Ollama at ${config.host}. Is it running? (brew services start ollama)`));
      } else if (/not found/i.test(msg) && msg.includes(config.model)) {
        console.error(chalk.red(`Model ${config.model} isn't pulled. Run: ollama pull ${config.model}`));
      } else {
        console.error(chalk.red(`Error: ${msg}`));
      }
    }
  }
  rl.close();
}

main();
