import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// Project root: one level above server/ (ts-node) or two above dist/server/ (compiled).
export const ROOT = path.basename(path.dirname(__dirname)) === "dist" ? path.resolve(__dirname, "..", "..") : path.resolve(__dirname, "..");

export type SqlParams = ReadonlyArray<string | number | bigint | null>;

/**
 * Persistence adapter. Services only talk to this interface, so a Postgres/MySQL driver can be
 * swapped in by implementing it (the SQL in this repo sticks to portable constructs plus SQLite
 * datetime('now') defaults declared in db/schema.sql).
 * transaction() callbacks are synchronous: do not await inside them.
 */
export interface DbAdapter {
  exec(sql: string): void;
  run(sql: string, params?: SqlParams): { changes: number; lastInsertRowid: number | bigint };
  get<T>(sql: string, params?: SqlParams): T | undefined;
  all<T>(sql: string, params?: SqlParams): T[];
  transaction<T>(fn: () => T): T;
}

class SqliteAdapter implements DbAdapter {
  private conn: Database.Database;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.conn = new Database(file);
    this.conn.pragma("journal_mode = WAL");
    this.conn.pragma("foreign_keys = ON");
  }

  exec(sql: string): void {
    this.conn.exec(sql);
  }

  run(sql: string, params: SqlParams = []) {
    const r = this.conn.prepare(sql).run(...params);
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
  }

  get<T>(sql: string, params: SqlParams = []): T | undefined {
    return this.conn.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, params: SqlParams = []): T[] {
    return this.conn.prepare(sql).all(...params) as T[];
  }

  transaction<T>(fn: () => T): T {
    return this.conn.transaction(fn)();
  }
}

export const db: DbAdapter = new SqliteAdapter(process.env.DATABASE_PATH || path.join(ROOT, "db", "approvals.sqlite"));

export function migrate(): void {
  db.exec(fs.readFileSync(path.join(ROOT, "db", "schema.sql"), "utf-8"));
}
