import { config } from "./config.js";
import type { Message } from "./llm.js";

/**
 * Characters of history that fit alongside the system prompt, tools (~2.5k tokens) and a reply.
 * ~3.5 characters per token.
 */
const HISTORY_BUDGET_CHARS = Math.floor(config.numCtx * 3.5 * 0.6);

/**
 * Keep the most recent messages that fit the model's context, starting at a user message
 * so the model never sees a tool result or answer without the question that led to it.
 */
export function fitHistory(messages: Message[], budget = HISTORY_BUDGET_CHARS): { kept: Message[]; dropped: number } {
  let chars = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    chars += messages[i].content.length + (messages[i].tool_calls ? JSON.stringify(messages[i].tool_calls).length : 0);
    if (chars > budget) break;
    start = i;
  }
  while (start < messages.length && messages[start].role !== "user") start++;
  return { kept: messages.slice(start), dropped: start };
}

/** A conversation's title: the first line of its first message. */
export function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 60 ? line.slice(0, 59) + "…" : line || "(untitled)";
}
