import { Ollama } from "ollama";
import { config } from "./config.js";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
}

export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description: string }>;
      required?: string[];
    };
  };
}

/** Any backend Elena can think with. Swap Ollama for something else by implementing this. */
export interface LLM {
  chat(messages: Message[], tools: ToolSchema[], opts?: ChatOptions): Promise<Message>;
  /** Optional: process a prompt ahead of time so the next chat that starts with it is fast. */
  warm?(messages: Message[], tools: ToolSchema[], model: string, think?: boolean): Promise<void>;
}

export interface ChatOptions {
  /** Receives answer text as it is generated, for streaming to the terminal. */
  onToken?(text: string): void;
  /** Called once when the model starts reasoning (thinking mode), which produces no visible text for a while. */
  onThinking?(): void;
  /** Override config.think for this call. */
  think?: boolean;
  /** Which model to use for this call. */
  model?: string;
  /** Token counts Ollama reports once the reply is done (the prompt count covers the whole context, cached or not). */
  onUsage?(usage: { promptTokens: number; outputTokens: number }): void;
}

/** Shared client for chat, model listing and pulls. */
export const ollama = new Ollama({ host: config.host });

export class OllamaLLM implements LLM {
  constructor(private defaultModel = config.model ?? "qwen3:14b") {}

  async chat(messages: Message[], tools: ToolSchema[], opts: ChatOptions = {}): Promise<Message> {
    const stream = await ollama.chat({
      model: opts.model ?? this.defaultModel,
      messages,
      tools,
      stream: true,
      think: opts.think ?? config.think,
      keep_alive: config.keepAlive,
      options: { num_ctx: config.numCtx },
    });

    let content = "";
    const toolCalls: ToolCall[] = [];
    let thinking = false;
    for await (const chunk of stream) {
      if (chunk.message.thinking && !thinking) {
        thinking = true;
        opts.onThinking?.();
      }
      if (chunk.message.content) {
        content += chunk.message.content;
        opts.onToken?.(chunk.message.content);
      }
      if (chunk.message.tool_calls) toolCalls.push(...(chunk.message.tool_calls as ToolCall[]));
      if (chunk.done && typeof chunk.prompt_eval_count === "number") {
        opts.onUsage?.({ promptTokens: chunk.prompt_eval_count, outputTokens: chunk.eval_count ?? 0 });
      }
    }
    return { role: "assistant", content, tool_calls: toolCalls.length ? toolCalls : undefined };
  }

  /**
   * Ollama caches the processed prompt, so reading the system prompt and tool list now
   * (one output token) means the user's first message only has to process their own text.
   */
  async warm(messages: Message[], tools: ToolSchema[], model: string, think?: boolean): Promise<void> {
    // Must match the real request (including `think`), or the cached prompt won't be reused.
    await ollama.chat({
      model,
      messages,
      tools,
      think,
      stream: false,
      keep_alive: config.keepAlive,
      options: { num_ctx: config.numCtx, num_predict: 1 },
    });
  }
}
