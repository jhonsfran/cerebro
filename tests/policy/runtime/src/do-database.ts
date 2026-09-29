import type { JournalDatabase } from "../../fixtures/journal-core.ts";

export class DoDatabase implements JournalDatabase {
  private readonly storage: DurableObjectStorage;
  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
  }
  exec(query: string, ...parameters: string[]): void {
    this.storage.sql.exec(query, ...parameters);
  }
  row(query: string, ...parameters: string[]): { payload: string } | undefined {
    const [row] = this.storage.sql
      .exec<{ payload: string }>(query, ...parameters)
      .toArray();
    return row ? { payload: row.payload } : undefined;
  }
  transaction<Value>(body: () => Value): Value {
    return this.storage.transactionSync(body);
  }
}
