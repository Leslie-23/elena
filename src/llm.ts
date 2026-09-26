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
  chat(messages: Message[], tools: ToolSchema[]): Promise<Message>;
}

export class OllamaLLM implements LLM {
  private client = new Ollama({ host: config.host });

  constructor(private model = config.model) {}

  async chat(messages: Message[], tools: ToolSchema[]): Promise<Message> {
    const res = await this.client.chat({
      model: this.model,
      messages,
      tools,
      options: { num_ctx: config.numCtx },
    });
    return {
      role: "assistant",
      content: res.message.content ?? "",
      tool_calls: res.message.tool_calls as ToolCall[] | undefined,
    };
  }
}
