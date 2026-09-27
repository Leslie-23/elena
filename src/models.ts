import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ollama } from "./llm.js";
import type { MemoryStore } from "./memory/store.js";

export type Task = "chat" | "code" | "review";
export const TASKS: Task[] = ["chat", "code", "review"];

export const TASK_LABELS: Record<Task, string> = {
  chat: "questions, git, ports, processes",
  code: "explaining, debugging, writing code",
  review: "reviewing changes",
};

/**
 * Preferred models per task, best first. Elena uses the first one that's installed and supports tools.
 * Override in ~/.elena/models.json, e.g. {"code": ["devstral:24b", "qwen3:14b"]}.
 * qwen3:30b and qwen3-coder:30b are mixture-of-experts (3B active params), so they're large but not slow.
 */
const DEFAULT_PREFS: Record<Task, string[]> = {
  chat: ["qwen3:30b", "qwen3:14b", "gpt-oss:20b", "qwen3:8b", "llama3.1:8b", "qwen3:4b"],
  code: ["qwen3-coder:30b", "qwen3:30b", "devstral:24b", "qwen2.5-coder:14b", "qwen3:14b", "qwen3:8b"],
  // Reviews use thinking mode, so prefer models that support it.
  review: ["qwen3:30b", "gpt-oss:20b", "qwen3:14b", "qwen3-coder:30b", "qwen3:8b"],
};

/** Download sizes from the Ollama registry (GB), for pull suggestions and to skip models that won't fit in RAM. */
const KNOWN_SIZES_GB: Record<string, number> = {
  "qwen3:30b": 18.6, "qwen3-coder:30b": 18.6, "qwen3:14b": 9.3, "qwen3:8b": 5.2, "qwen3:4b": 2.5,
  "gpt-oss:20b": 13.8, "devstral:24b": 14.3, "qwen2.5-coder:14b": 9.0, "llama3.1:8b": 4.9,
};

export interface ModelInfo {
  name: string;
  sizeGB: number;
  tools: boolean;
  thinking: boolean;
}

export interface Pick {
  model: string;
  why: "pinned" | "auto" | "fallback";
  /** A better model for this task that isn't installed. */
  suggest?: { name: string; sizeGB?: number };
}

/** "llama3.1" and "llama3.1:latest" are the same model. */
export function normalize(name: string): string {
  return name.includes(":") ? name : `${name}:latest`;
}

const RAM_GB = os.totalmem() / 1e9;
/** Leave room for the context cache, the OS and your apps. */
const fits = (name: string) => (KNOWN_SIZES_GB[name] ?? 0) <= RAM_GB * 0.6;

export class ModelRouter {
  private installed: ModelInfo[] = [];
  private prefs: Record<Task, string[]>;

  /** `envPin` (from ELENA_MODEL) forces one model for every task this session. */
  constructor(
    private store: MemoryStore,
    elenaHome: string,
    private envPin?: string,
  ) {
    this.prefs = { ...DEFAULT_PREFS };
    try {
      const custom = JSON.parse(readFileSync(path.join(elenaHome, "models.json"), "utf8"));
      for (const t of TASKS) if (Array.isArray(custom[t])) this.prefs[t] = custom[t].map(String).map(normalize);
    } catch {
      // no custom preferences
    }
  }

  /** Reload installed models and their capabilities from Ollama. */
  async refresh(): Promise<ModelInfo[]> {
    const { models } = await ollama.list();
    this.installed = await Promise.all(
      models.map(async (m) => {
        const caps = await ollama
          .show({ model: m.name })
          .then((s) => (s as { capabilities?: string[] }).capabilities ?? [])
          .catch(() => [] as string[]);
        return { name: m.name, sizeGB: m.size / 1e9, tools: caps.includes("tools"), thinking: caps.includes("thinking") };
      }),
    );
    this.installed.sort((a, b) => a.name.localeCompare(b.name));
    return this.installed;
  }

  list(): ModelInfo[] {
    return this.installed;
  }

  info(name: string): ModelInfo | undefined {
    const n = normalize(name);
    return this.installed.find((m) => m.name === n);
  }

  pinned(task: Task): string | undefined {
    return this.envPin ?? this.store.getSetting(`model.${task}`) ?? undefined;
  }

  /** Pin a model for one task or all of them; `null` goes back to automatic choice. */
  pin(task: Task | "all", name: string | null) {
    for (const t of task === "all" ? TASKS : [task]) {
      if (name === null) this.store.deleteSetting(`model.${t}`);
      else this.store.setSetting(`model.${t}`, normalize(name));
    }
  }

  get envPinned(): boolean {
    return this.envPin !== undefined;
  }

  pick(task: Task): Pick {
    const usable = (name: string) => this.info(name)?.tools === true;

    const pin = this.pinned(task);
    if (pin && usable(pin)) return { model: normalize(pin), why: "pinned" };

    const prefs = this.prefs[task].filter(fits);
    const chosen = prefs.find(usable);
    // The best preference ranked above what we're using that isn't installed yet.
    const betterIdx = chosen ? prefs.indexOf(chosen) : prefs.length;
    const missing = prefs.slice(0, betterIdx).find((p) => !this.info(p));
    const suggest = missing ? { name: missing, sizeGB: KNOWN_SIZES_GB[missing] } : undefined;
    if (chosen) return { model: chosen, why: "auto", suggest };

    // Nothing from the list is installed: use the biggest installed model that supports tools.
    const any = this.installed.filter((m) => m.tools && m.sizeGB <= RAM_GB * 0.6).sort((a, b) => b.sizeGB - a.sizeGB)[0];
    if (any) return { model: any.name, why: "fallback", suggest: suggest ?? { name: prefs[0], sizeGB: KNOWN_SIZES_GB[prefs[0]] } };

    throw new Error(`No installed model supports tool calling. Run /pull ${prefs[0] ?? "qwen3:14b"}`);
  }
}

const CODE_HINTS =
  /```|`[^`]+`|\b[\w/.-]+\.(tsx?|jsx?|mjs|py|go|rs|java|kt|swift|rb|php|cs|c|cpp|h|sql|vue|svelte)\b|\b(explain|debug|fix|bug|refactor|implement|write|rewrite|function|class|method|component|hook|stack ?trace|exception|type ?error|compile|unit test|tests?\b|why (is|does|doesn't|isn't) (this|the|my) (code|function)|how does .+ work)\b/i;

const FOLLOW_UP = /^(and|also|what about|how about|then|ok|okay|so|but|same|line)\b|\b(it|that|this|those|there|them)\b/i;

/**
 * Guess the task from what the user typed, without a model call.
 * Short follow-ups ("and line 40?", "why does it do that?") stay on the previous task
 * so the model isn't swapped mid-thread.
 */
export function classify(input: string, previous?: Task): Task {
  if (CODE_HINTS.test(input)) return "code";
  if (previous === "code" && input.length < 60 && FOLLOW_UP.test(input)) return "code";
  return "chat";
}
