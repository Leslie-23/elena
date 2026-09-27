import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync as DB } from "node:sqlite";

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

export const GLOBAL = "global";

export class MemoryStore {
  private db: DB;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id         INTEGER PRIMARY KEY,
        scope      TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope);
      CREATE TABLE IF NOT EXISTS project_scans (
        root       TEXT PRIMARY KEY,
        summary    TEXT NOT NULL,
        git_head   TEXT,
        scanned_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
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
    const words = query.trim().split(/\s+/).filter(Boolean);
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
