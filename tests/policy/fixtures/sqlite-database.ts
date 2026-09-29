import { DatabaseSync } from "node:sqlite";

import type { JournalDatabase } from "./journal-core.ts";

export class SqliteDatabase implements JournalDatabase {
  readonly sqlite: DatabaseSync;
  constructor(path: string) {
    this.sqlite = new DatabaseSync(path);
    this.sqlite.exec(
      "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;"
    );
  }
  exec(sql: string, ...parameters: string[]): void {
    this.sqlite.prepare(sql).run(...parameters);
  }
  row(sql: string, ...parameters: string[]): { payload: string } | undefined {
    const row = this.sqlite.prepare(sql).get(...parameters);
    if (!row) {
      return undefined;
    }
    if (typeof row.payload !== "string") {
      throw new TypeError("Invalid fixture journal row.");
    }
    return { payload: row.payload };
  }
  transaction<Value>(body: () => Value): Value {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const value = body();
      this.sqlite.exec("COMMIT");
      return value;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}
