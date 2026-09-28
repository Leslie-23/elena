import os from "node:os";
import path from "node:path";

const home = process.env.ELENA_HOME ?? path.join(os.homedir(), ".elena");

export const config = {
  dbPath: path.join(home, "elena.db"),
  // Most recent memories (global + this project) loaded into the system prompt at startup.
  maxPromptMemories: 50,
  host: process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
  home,
  // Set to force one model for every task. Otherwise Elena picks per task (see models.ts and /model).
  model: process.env.ELENA_MODEL as string | undefined,
  // Ollama's default context is small; tool output fills it fast.
  numCtx: Number(process.env.ELENA_NUM_CTX ?? 16384),
  // Hard stop so a confused model can't loop forever.
  maxSteps: Number(process.env.ELENA_MAX_STEPS ?? 12),
  // Tool output is truncated to this many characters before going back to the model.
  // The model reads input at ~120 tokens/s on an M1 Pro, so 4000 chars ≈ 8s per tool result.
  maxToolOutput: Number(process.env.ELENA_MAX_TOOL_OUTPUT ?? 4000),
  // Qwen3's reasoning mode is ~7x slower per answer. Off unless ELENA_THINK=1.
  think: process.env.ELENA_THINK === "1",
  // Reviews use thinking mode by default: in testing it found 3/3 planted bugs vs 1-2/3 without (57s vs 31s).
  reviewThink: process.env.ELENA_REVIEW_THINK !== "0",
  // Keep the model in memory between questions so it isn't reloaded after 5 idle minutes.
  keepAlive: process.env.ELENA_KEEP_ALIVE ?? "30m",
  commandTimeoutMs: 15_000,
  logDir: path.join(home, "logs"),
  // Max characters of diff sent for a review (~16k chars ≈ 4.5k tokens ≈ 40s to read on an M1 Pro).
  reviewMaxChars: Number(process.env.ELENA_REVIEW_MAX_CHARS ?? 16000),
  // macOS notifications for things that need you while the terminal isn't in front.
  notify: process.env.ELENA_NOTIFY !== "0",
  // Answers slower than this also send a notification (if you've switched away).
  notifyAfterSeconds: 20,
  // Background subagents share the GPU with the main chat, so keep this small.
  maxBackgroundAgents: 2,
  // Compact automatically when the context is this full (Ollama silently drops the start of the prompt,
  // Elena's instructions, if it overflows), aiming to get back under compactTarget.
  compactAt: Number(process.env.ELENA_COMPACT_AT ?? 0.75),
  compactTarget: Number(process.env.ELENA_COMPACT_TARGET ?? 0.5),
  debug: process.env.ELENA_DEBUG === "1",
};
