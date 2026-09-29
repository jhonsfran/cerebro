import type { ToolOperationJournal } from "../../../packages/contracts/src/operation-journal.ts";
import type { ToolExecution } from "../../../packages/contracts/src/tools.ts";
import { DurableOperationJournal } from "./journal-core.ts";
import { SqliteDatabase } from "./sqlite-database.ts";

export class SqliteOperationJournal<
  Value,
> extends DurableOperationJournal<Value> {
  private readonly sqliteDatabase: SqliteDatabase;
  constructor(path: string, namespace: string) {
    const database = new SqliteDatabase(path);
    super(database, namespace);
    this.sqliteDatabase = database;
  }
  close(): void {
    this.sqliteDatabase.sqlite.close();
  }
}

export const SqliteToolOperationJournal: new (
  path: string,
  namespace: string
) => SqliteOperationJournal<ToolExecution> & ToolOperationJournal =
  SqliteOperationJournal<ToolExecution>;
