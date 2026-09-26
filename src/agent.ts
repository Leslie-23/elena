import { config } from "./config.js";
import type { LLM, Message } from "./llm.js";
import { systemPrompt } from "./prompts/system.js";
import { tools, toolsByName } from "./tools/index.js";
import type { ToolContext } from "./tools/types.js";
import { truncate } from "./tools/exec.js";

export interface AgentEvents {
  onToolCall?(name: string, args: Record<string, unknown>): void;
  onToolResult?(name: string, result: string): void;
}

export class Agent {
  private messages: Message[];

  constructor(
    private llm: LLM,
    private ctx: ToolContext,
    private events: AgentEvents = {},
  ) {
    this.messages = [{ role: "system", content: systemPrompt(ctx.root) }];
  }

  /** One user turn: think, call tools, repeat until the model answers in plain text. */
  async send(userInput: string): Promise<string> {
    this.messages.push({ role: "user", content: userInput });
    const schemas = tools.map((t) => t.schema);

    for (let step = 0; step < config.maxSteps; step++) {
      const reply = await this.llm.chat(this.messages, schemas);
      this.messages.push(reply);

      if (!reply.tool_calls?.length) return reply.content;

      for (const call of reply.tool_calls) {
        const { name, arguments: args } = call.function;
        this.events.onToolCall?.(name, args);
        const result = truncate(await this.runTool(name, args ?? {}));
        this.events.onToolResult?.(name, result);
        this.messages.push({ role: "tool", tool_name: name, content: result });
      }
    }
    return `(Stopped after ${config.maxSteps} steps without a final answer.)`;
  }

  private async runTool(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = toolsByName.get(name);
    if (!tool) return `Unknown tool: ${name}. Available: ${[...toolsByName.keys()].join(", ")}`;
    if (tool.requiresConfirmation) {
      const ok = await this.ctx.confirm(tool.confirmMessage?.(args) ?? `Run ${name} ${JSON.stringify(args)}?`);
      if (!ok) return "User declined.";
    }
    try {
      return await tool.run(args, this.ctx);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
