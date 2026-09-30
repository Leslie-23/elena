import { config } from "./config.js";
import type { LLM, Message } from "./llm.js";
import { systemPrompt } from "./prompts/system.js";
import { fileListing } from "./project/scan.js";
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

/** "Let me check package.json.", "I'll look at…" ending a reply that has no tool call. */
export const ANNOUNCED_ACTION =
  /\b(let me|let's|let us|i'll|i will|i'm going to|i am going to|i need to|we need to|we should|next,? (i|we))\b[^.!?\n]{0,80}\b(check|look|search|read|find|open|inspect|run|verify|examine|review|implement|modify|change|add|write|edit|update|create|fix)\b[^!?\n]{0,120}$/i;

const SUMMARY_PREFIX = "Summary of our conversation so far (older messages were compacted to save context):";

/** Offers to the user ("let me know if you'd like me to check…") aren't unfinished actions. */
export const OFFER = /\b(let me know|if you('d| would)? like|would you like|want me to|shall i|should i)\b/i;

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
    return systemPrompt(root, memory.list(root, config.maxPromptMemories), memory.getScan(root), fileListing(root));
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

  // ---- context window --------------------------------------------------------

  /** Tokens per character, measured from Ollama's real counts (a rough 1/3.5 until the first reply). */
  private tokensPerChar = 1 / 3.5;
  /** The real size of the last request plus its reply, and how many characters that was. */
  private measured?: { tokens: number; chars: number };

  private schemaChars(): number {
    return JSON.stringify(this.tools.map((t) => t.schema)).length;
  }

  private messageChars(m: Message): number {
    return m.content.length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
  }

  private totalChars(): number {
    return this.schemaChars() + this.messages.reduce((n, m) => n + this.messageChars(m), 0);
  }

  private recordUsage(promptTokens: number, outputTokens: number, replyChars: number) {
    const chars = this.totalChars() + replyChars;
    const tokens = promptTokens + outputTokens;
    this.measured = { tokens, chars };
    if (chars > 1000) this.tokensPerChar = tokens / chars;
  }

  /**
   * How full the context window is. Exact right after a reply (Ollama's count); estimated from the
   * measured tokens-per-character ratio once the conversation has changed since.
   */
  contextUsage(): { used: number; limit: number; exact: boolean } {
    const chars = this.totalChars();
    if (this.measured && this.measured.chars === chars) return { used: this.measured.tokens, limit: config.numCtx, exact: true };
    return { used: Math.round(chars * this.tokensPerChar), limit: config.numCtx, exact: false };
  }

  /** What the context is made of, in (estimated) tokens. */
  contextBreakdown(): { label: string; tokens: number }[] {
    const t = (chars: number) => Math.round(chars * this.tokensPerChar);
    const sum = (role: Message["role"]) =>
      this.messages.slice(1).filter((m) => m.role === role).reduce((n, m) => n + this.messageChars(m), 0);
    return [
      { label: "Instructions (rules, file list, scan, memories)", tokens: t(this.messages[0].content.length) },
      { label: `Tool definitions (${this.tools.length})`, tokens: t(this.schemaChars()) },
      { label: "Your messages", tokens: t(sum("user")) },
      { label: "Elena's replies and tool calls", tokens: t(sum("assistant")) },
      { label: "Tool results", tokens: t(sum("tool")) },
    ];
  }

  /** Index of the first message of the last `turns` user turns (kept verbatim when compacting). */
  private recentStart(turns: number): number {
    let seen = 0;
    for (let i = this.messages.length - 1; i > 0; i--) {
      if (this.messages[i].role === "user" && ++seen === turns) return i;
    }
    return 1;
  }

  /**
   * Cheap first step: shorten tool results older than the last `keepTurns` turns. Elena already
   * used them; what she concluded is in her replies. Returns how many were trimmed.
   */
  pruneToolResults(keepTurns = 2): number {
    const cutoff = this.recentStart(keepTurns);
    let trimmed = 0;
    for (let i = 1; i < cutoff; i++) {
      const m = this.messages[i];
      if (m.role === "tool" && m.content.length > 300 && !m.content.startsWith("[trimmed")) {
        this.messages[i] = { ...m, content: `[trimmed to save context] ${m.content.slice(0, 200)}…` };
        trimmed++;
      }
    }
    return trimmed;
  }

  /**
   * Replace everything before the last `keepTurns` turns with a short summary written by the model.
   * Returns false if there was nothing old enough to summarise.
   */
  async summarizeHistory(model: string, keepTurns = 2): Promise<boolean> {
    const cutoff = this.recentStart(keepTurns);
    const old = this.messages.slice(1, cutoff);
    const oldChars = old.reduce((n, m) => n + this.messageChars(m), 0);
    // Too little to be worth it: a summary wouldn't be much shorter, and each pass risks dropping a fact.
    if (old.length < 2 || oldChars * this.tokensPerChar < 1200) return false;

    const transcript = old
      .map((m) =>
        m.role === "user" && m.content.startsWith(SUMMARY_PREFIX)
          ? `Earlier summary (keep every fact from it):\n${m.content.slice(SUMMARY_PREFIX.length).trim()}`
          : m.role === "user" ? `User: ${m.content}`
        : m.role === "tool" ? `[${m.tool_name ?? "tool"} result: ${m.content.slice(0, 200).replace(/\s+/g, " ")}…]`
        : m.tool_calls?.length ? `Elena called ${m.tool_calls.map((c) => c.function.name).join(", ")}${m.content ? `: ${m.content}` : ""}`
        : `Elena: ${m.content}`,
      )
      .join("\n");
    const summary = await this.llm.chat(
      [
        {
          role: "system",
          content:
            "You compress a conversation between a user and Elena, their developer assistant, so Elena can continue it with less context. " +
            "Keep: decisions, facts learned (file paths, ports, commands, errors and their causes), what was changed, open questions and tasks, " +
            "and the user's preferences. Drop greetings, small talk and raw tool output. Write short bullet points, at most 200 words.",
        },
        { role: "user", content: transcript },
      ],
      [],
      { model, think: false },
    );
    const text = summary.content.trim();
    if (!text || text.length > oldChars * 0.7) return false; // not meaningfully smaller: keep the original
    this.messages = [
      this.messages[0],
      { role: "user", content: `${SUMMARY_PREFIX}\n${text}` },
      { role: "assistant", content: "Understood. I'll continue from that summary." },
      ...this.messages.slice(cutoff),
    ];
    return true;
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
    let nudged = false;
    let retriedEmpty = false;

    for (let step = 0; step < config.maxSteps; step++) {
      let usage: { promptTokens: number; outputTokens: number } | undefined;
      const reply = await this.llm.chat(this.messages, schemas, {
        onToken: this.events.onToken,
        onThinking: this.events.onThinking,
        think: opts.think,
        model: opts.model,
        onUsage: (u) => (usage = u),
      });
      if (usage) this.recordUsage(usage.promptTokens, usage.outputTokens, this.messageChars(reply));

      // The model wrote something, but it came back empty: Ollama drops a tool call it can't parse
      // (bad JSON, stray quotes). Ask once more instead of showing the user a blank reply.
      if (!reply.content.trim() && !reply.tool_calls?.length && !retriedEmpty) {
        retriedEmpty = true;
        this.push({
          role: "user",
          content: "Your last reply came through empty, probably a tool call with invalid arguments. Try again: call the tool with valid JSON arguments, or answer in plain text.",
        });
        continue;
      }
      this.push(reply);

      if (!reply.tool_calls?.length) {
        // Local models often end with "Let me check package.json." and never call the tool.
        const tail = reply.content.slice(-300);
        if (!nudged && ANNOUNCED_ACTION.test(tail) && !OFFER.test(tail)) {
          nudged = true;
          this.push({
            role: "user",
            content:
              "Go ahead and do that now with your tools, then answer. If it means creating or changing files, you can't do that " +
              'yourself: hand it to Claude with slash_command "/claude edit <task>".',
          });
          continue;
        }
        return reply.content;
      }

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
