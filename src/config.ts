export const config = {
  host: process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434",
  model: process.env.ELENA_MODEL ?? "qwen3:14b",
  // Ollama's default context is small; tool output fills it fast.
  numCtx: Number(process.env.ELENA_NUM_CTX ?? 16384),
  // Hard stop so a confused model can't loop forever.
  maxSteps: Number(process.env.ELENA_MAX_STEPS ?? 12),
  // Tool output is truncated to this many characters before going back to the model.
  maxToolOutput: Number(process.env.ELENA_MAX_TOOL_OUTPUT ?? 8000),
  commandTimeoutMs: 15_000,
  debug: process.env.ELENA_DEBUG === "1",
};
