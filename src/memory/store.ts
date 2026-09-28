import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync as DB } from "node:sqlite";
import type { Message } from "../llm.js";

// Loaded with require (not a static import) so it runs after quiet.ts has filtered
// Node's "SQLite is experimental" warning. Static imports all load before any code runs.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export interface Memory {
  id: number;
  /** "global", or the absolute path of the project the memory belongs to. */
  scope: string;
  content: string;
  created_at: string;
}

export interface ProjectScan {
  root: string;
  summary: string;
  git_head: string | null;
  /** UTC, "YYYY-MM-DD HH:MM:SS" (SQLite datetime format). */
  scanned_at: string;
}

export interface ConversationSummary {
  id: number;
  root: string;
  title: string;
  started_at: string;
  updated_at: string;
  /** Number of user messages. */
  turns: number;
}

export const GLOBAL = "global";

export class MemoryStore {
  private db: DB;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // Elena may be open in a terminal and running as Claude's MCP server at the same time:
    // WAL lets them share the file, and the timeout waits out brief write locks instead of failing.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id         INTEGER PRIMARY KEY,
        scope      TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope);
      CREATE TABLE IF NOT EXISTS conversations (
        id         INTEGER PRIMARY KEY,
        root       TEXT NOT NULL,
        title      TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS conversations_root ON conversations(root, updated_at);
      CREATE TABLE IF NOT EXISTS messages (
        id              INTEGER PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role            TEXT NOT NULL,
        content         TEXT NOT NULL,
        tool_calls      TEXT,
        tool_name       TEXT
      );
      CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, id);
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_scans (
        root       TEXT PRIMARY KEY,
        summary    TEXT NOT NULL,
        git_head   TEXT,
        scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  startConversation(root: string, title: string): number {
    const row = this.db
      .prepare("INSERT INTO conversations (root, title) VALUES (?, ?) RETURNING id")
      .get(root, title) as { id: number };
    return row.id;
  }

  addMessage(conversationId: number, m: Message) {
    this.db
      .prepare("INSERT INTO messages (conversation_id, role, content, tool_calls, tool_name) VALUES (?, ?, ?, ?, ?)")
      .run(conversationId, m.role, m.content, m.tool_calls ? JSON.stringify(m.tool_calls) : null, m.tool_name ?? null);
    this.db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conversationId);
  }

  /** Most recently active conversations for a project. */
  listConversations(root: string, limit = 10): ConversationSummary[] {
    return this.db
      .prepare(
        `SELECT c.*, (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') AS turns
         FROM conversations c WHERE c.root = ? ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
      )
      .all(root, limit) as unknown as ConversationSummary[];
  }

  getMessages(conversationId: number): Message[] {
    const rows = this.db
      .prepare("SELECT role, content, tool_calls, tool_name FROM messages WHERE conversation_id = ? ORDER BY id")
      .all(conversationId) as { role: Message["role"]; content: string; tool_calls: string | null; tool_name: string | null }[];
    return rows.map((r) => ({
      role: r.role,
      content: r.content,
      ...(r.tool_calls ? { tool_calls: JSON.parse(r.tool_calls) } : {}),
      ...(r.tool_name ? { tool_name: r.tool_name } : {}),
    }));
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string) {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  deleteSetting(key: string) {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  saveScan(root: string, summary: string, gitHead: string | null) {
    this.db
      .prepare(
        `INSERT INTO project_scans (root, summary, git_head) VALUES (?, ?, ?)
         ON CONFLICT(root) DO UPDATE SET summary = excluded.summary, git_head = excluded.git_head, scanned_at = datetime('now')`,
      )
      .run(root, summary, gitHead);
  }

  getScan(root: string): ProjectScan | undefined {
    return this.db.prepare("SELECT * FROM project_scans WHERE root = ?").get(root) as unknown as ProjectScan | undefined;
  }

  add(scope: string, content: string): Memory {
    return this.db
      .prepare("INSERT INTO memories (scope, content) VALUES (?, ?) RETURNING *")
      .get(scope, content.trim()) as unknown as Memory;
  }

  /** Global memories plus those for `project`, newest first. */
  list(project: string, limit = 100): Memory[] {
    return this.db
      .prepare("SELECT * FROM memories WHERE scope IN (?, ?) ORDER BY id DESC LIMIT ?")
      .all(GLOBAL, project, limit) as unknown as Memory[];
  }

  /** Case-insensitive search across every scope, so Elena can find notes from other projects. */
  search(query: string, limit = 20): Memory[] {
    // Match each word loosely: "ports" should find "port", "services" should find "service".
    const words = query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => (w.length > 4 ? w.replace(/(es|s)$/i, "") : w));
    if (!words.length) return [];
    const where = words.map(() => "content LIKE ? ESCAPE '\\'").join(" AND ");
    const params = words.map((w) => `%${w.replace(/[\\%_]/g, (c) => "\\" + c)}%`);
    return this.db
      .prepare(`SELECT * FROM memories WHERE ${where} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as unknown as Memory[];
  }

  get(id: number): Memory | undefined {
    return this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as unknown as Memory | undefined;
  }

  remove(id: number): boolean {
    return Number(this.db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes) > 0;
  }

  close() {
    this.db.close();
  }
}

export function formatMemory(m: Memory, project?: string): string {
  const where = m.scope === GLOBAL ? "global" : m.scope === project ? "this project" : path.basename(m.scope);
  return `#${m.id} [${where}] ${m.content}`;
}
