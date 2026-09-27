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
  /** `onToken` receives answer text as it is generated, for streaming to the terminal. */
  chat(messages: Message[], tools: ToolSchema[], onToken?: (text: string) => void): Promise<Message>;
}

export class OllamaLLM implements LLM {
  private client = new Ollama({ host: config.host });

  constructor(private model = config.model) {}

  async chat(messages: Message[], tools: ToolSchema[], onToken?: (text: string) => void): Promise<Message> {
    const stream = await this.client.chat({
      model: this.model,
      messages,
      tools,
      stream: true,
      think: config.think,
      keep_alive: config.keepAlive,
      options: { num_ctx: config.numCtx },
    });

    let content = "";
    const toolCalls: ToolCall[] = [];
    for await (const chunk of stream) {
      if (chunk.message.content) {
        content += chunk.message.content;
        onToken?.(chunk.message.content);
      }
      if (chunk.message.tool_calls) toolCalls.push(...(chunk.message.tool_calls as ToolCall[]));
    }
    return { role: "assistant", content, tool_calls: toolCalls.length ? toolCalls : undefined };
  }
}
