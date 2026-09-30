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

/**
 * Tool calls written as text, read forgivingly: <tool_call>{...}</tool_call> (or a missing or wrong
 * closing tag), "arguments" or "parameters", arguments as an object or a JSON string. Unknown tools are ignored.
 */
export function parseToolCalls(text: string, known: Set<string>): ToolCall[] {
  const calls: ToolCall[] = [];
  const blocks = [...text.matchAll(/<tool_call>\s*([\s\S]*?)\s*(?=<\/tool_call>|<tool_call>|$)/g)].map((m) => m[1]);
  if (!blocks.length && text.trim().startsWith("{")) blocks.push(text.trim());
  for (const block of blocks) {
    const json = block.slice(block.indexOf("{"), block.lastIndexOf("}") + 1);
    if (!json) continue;
    try {
      const obj = JSON.parse(json);
      // Normalise "/slash_command" or " read_file " to the real tool name.
      const rawName = obj.name ?? obj.function?.name;
      const name = typeof rawName === "string" ? rawName.trim().replace(/^\/+/, "") : rawName;
      let args = obj.arguments ?? obj.parameters ?? obj.function?.arguments ?? {};
      if (typeof args === "string") args = JSON.parse(args);
      if (typeof name === "string" && known.has(name) && args && typeof args === "object") calls.push({ function: { name, arguments: args } });
    } catch {
      // not valid JSON: skip this block
    }
  }
  return calls;
}

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
    let outputTokens = 0;
    // A reply that starts like a tool call written as text ("{" or "<tool_call>") is held back instead of
    // streamed, so the user never sees raw JSON; it's shown at the end if it turns out to be plain text.
    let held: boolean | undefined;
    for await (const chunk of stream) {
      if (chunk.message.thinking && !thinking) {
        thinking = true;
        opts.onThinking?.();
      }
      if (chunk.message.content) {
        content += chunk.message.content;
        if (held === undefined && content.trim()) held = /^\s*(\{|<tool_call>)/.test(content);
        if (held === false) opts.onToken?.(chunk.message.content);
      }
      if (chunk.message.tool_calls) toolCalls.push(...(chunk.message.tool_calls as ToolCall[]));
      if (chunk.done && typeof chunk.prompt_eval_count === "number") {
        outputTokens = chunk.eval_count ?? 0;
        opts.onUsage?.({ promptTokens: chunk.prompt_eval_count, outputTokens });
      }
    }
    if (held) {
      const calls = parseToolCalls(content, new Set(tools.map((t) => t.function.name)));
      if (calls.length) return { role: "assistant", content: "", tool_calls: [...toolCalls, ...calls] };
      opts.onToken?.(content); // it was plain text after all
    }
    // Written, but nothing came back: Ollama drops a tool call it can't parse (qwen3 sometimes writes
    // "parameters" instead of "arguments", or closes with <tool_call>). Ask again without Ollama's
    // parser and read the call ourselves.
    if (!content.trim() && !toolCalls.length && outputTokens > 0 && tools.length) {
      const recovered = await this.recoverToolCalls(messages, tools, opts);
      if (recovered.tool_calls?.length || recovered.content.trim()) {
        if (recovered.content.trim() && !recovered.tool_calls?.length) opts.onToken?.(recovered.content);
        return recovered;
      }
    }
    return { role: "assistant", content, tool_calls: toolCalls.length ? toolCalls : undefined };
  }

  /** The same request with the tools described in text, parsed leniently. */
  private async recoverToolCalls(messages: Message[], tools: ToolSchema[], opts: ChatOptions): Promise<Message> {
    const list = tools.map((t) => JSON.stringify({ name: t.function.name, description: t.function.description, parameters: t.function.parameters }));
    const instructions =
      `\n\n# Tools\nYou can call these functions:\n<tools>\n${list.join("\n")}\n</tools>\n` +
      `To call one, reply with exactly:\n<tool_call>\n{"name": "<function name>", "arguments": {<arguments as JSON>}}\n</tool_call>`;
    const [system, ...rest] = messages;
    const res = await ollama.chat({
      model: opts.model ?? this.defaultModel,
      messages: system?.role === "system" ? [{ ...system, content: system.content + instructions }, ...rest] : messages,
      stream: false,
      think: false,
      keep_alive: config.keepAlive,
      options: { num_ctx: config.numCtx },
    });
    const text = res.message.content ?? "";
    const calls = parseToolCalls(text, new Set(tools.map((t) => t.function.name)));
    return calls.length ? { role: "assistant", content: "", tool_calls: calls } : { role: "assistant", content: text.replace(/<\/?tool_call>/g, "").trim() };
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
