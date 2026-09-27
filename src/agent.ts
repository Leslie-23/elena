import { config } from "./config.js";
import type { LLM, Message } from "./llm.js";
import { systemPrompt } from "./prompts/system.js";
import { tools, toolsByName } from "./tools/index.js";
import type { Tool, ToolContext } from "./tools/types.js";
import { truncate } from "./tools/exec.js";

export interface AgentEvents {
  onToolCall?(name: string, args: Record<string, unknown>): void;
  onToolResult?(name: string, result: string): void;
  onToken?(text: string): void;
  onThinking?(): void;
  /** Every message added to the conversation (not the system prompt), e.g. to save it. */
  onMessage?(message: Message): void;
}

export interface AgentOptions {
  /** Tools this agent may use (default: all). Subagents get a read-only subset. */
  tools?: Tool[];
  /** Builds the system prompt (default: Elena's). */
  systemPrompt?: (ctx: ToolContext) => string;
}

export class Agent {
  private messages: Message[];
  private tools: Tool[];
  private toolsByName: Map<string, Tool>;

  constructor(
    private llm: LLM,
    private ctx: ToolContext,
    private events: AgentEvents = {},
    private options: AgentOptions = {},
  ) {
    this.tools = options.tools ?? tools;
    this.toolsByName = options.tools ? new Map(this.tools.map((t) => [t.schema.function.name, t])) : toolsByName;
    this.messages = [{ role: "system", content: this.buildSystemPrompt() }];
  }

  private buildSystemPrompt(): string {
    if (this.options.systemPrompt) return this.options.systemPrompt(this.ctx);
    const { root, memory } = this.ctx;
    return systemPrompt(root, memory.list(root, config.maxPromptMemories), memory.getScan(root));
  }

  /** Pre-process the system prompt, tools and any loaded history for `model`, so the next reply comes sooner. */
  async warmUp(model: string, think?: boolean): Promise<void> {
    await this.llm.warm?.(this.messages, this.tools.map((t) => t.schema), model, think);
  }

  /** Replace the conversation with `history` (e.g. a resumed one). The system prompt is kept. */
  loadHistory(history: Message[]) {
    this.messages = [this.messages[0], ...history];
  }

  /** Start a fresh conversation. */
  reset() {
    this.messages = [this.messages[0]];
  }

  private push(message: Message) {
    this.messages.push(message);
    this.events.onMessage?.(message);
  }

  /** Rebuild the system prompt, e.g. after a scan finishes. The conversation so far is kept. */
  refreshSystemPrompt() {
    this.messages[0] = { role: "system", content: this.buildSystemPrompt() };
  }

  /** One user turn: think, call tools, repeat until the model answers in plain text. */
  async send(userInput: string, opts: { think?: boolean; model?: string } = {}): Promise<string> {
    this.push({ role: "user", content: userInput });
    const schemas = this.tools.map((t) => t.schema);

    for (let step = 0; step < config.maxSteps; step++) {
      const reply = await this.llm.chat(this.messages, schemas, {
        onToken: this.events.onToken,
        onThinking: this.events.onThinking,
        think: opts.think,
        model: opts.model,
      });
      this.push(reply);

      if (!reply.tool_calls?.length) return reply.content;

      for (const call of reply.tool_calls) {
        const { name, arguments: args } = call.function;
        this.events.onToolCall?.(name, args);
        const result = truncate(await this.runTool(name, args ?? {}));
        this.events.onToolResult?.(name, result);
        this.push({ role: "tool", tool_name: name, content: result });
      }
    }
    return `(Stopped after ${config.maxSteps} steps without a final answer.)`;
  }

  private async runTool(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.toolsByName.get(name);
    if (!tool) return `Unknown tool: ${name}. Available: ${[...this.toolsByName.keys()].join(", ")}`;
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
