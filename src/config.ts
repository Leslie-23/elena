export const config = {
  host: process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
  model: process.env.ELENA_MODEL ?? "qwen3:14b",
  // Ollama's default context is small; tool output fills it fast.
  numCtx: Number(process.env.ELENA_NUM_CTX ?? 16384),
  // Hard stop so a confused model can't loop forever.
  maxSteps: Number(process.env.ELENA_MAX_STEPS ?? 12),
  // Tool output is truncated to this many characters before going back to the model.
  // The model reads input at ~120 tokens/s on an M1 Pro, so 4000 chars ≈ 8s per tool result.
  maxToolOutput: Number(process.env.ELENA_MAX_TOOL_OUTPUT ?? 4000),
  // Qwen3's reasoning mode is ~7x slower per answer. Off unless ELENA_THINK=1.
  think: process.env.ELENA_THINK === "1",
  // Keep the model in memory between questions so it isn't reloaded after 5 idle minutes.
  keepAlive: process.env.ELENA_KEEP_ALIVE ?? "30m",
  commandTimeoutMs: 15_000,
  debug: process.env.ELENA_DEBUG === "1",
};
