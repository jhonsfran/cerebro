import type { SessionStreamItem } from "@cerebro/contracts/session";
import { and, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";

import type {
  LedgerKind,
  LedgerValueMap,
  OutboxEvent,
} from "../ledger-records.ts";
import { operationRows, sessionRows } from "./schema.ts";

export class LedgerStore {
  private readonly db;

  constructor(storage: DurableObjectStorage) {
    this.db = drizzle(storage);
  }

  read<Kind extends LedgerKind>(
    kind: Kind,
    id: string
  ): LedgerValueMap[Kind] | undefined {
    return this.db
      .select()
      .from(operationRows)
      .where(eq(operationRows.id, `${kind}:${id}`))
      .get()?.result as LedgerValueMap[Kind] | undefined;
  }

  write<Kind extends LedgerKind>(
    kind: Kind,
    id: string,
    value: LedgerValueMap[Kind]
  ): void {
    const result = structuredClone(value);
    const eventId = kind === "outbox" ? (value as OutboxEvent).eventId : null;
    this.db
      .insert(operationRows)
      .values({ eventId, id: `${kind}:${id}`, kind, result })
      .onConflictDoUpdate({
        set: { eventId, kind, result },
        target: operationRows.id,
      })
      .run();
  }

  list<Kind extends LedgerKind>(kind: Kind): LedgerValueMap[Kind][] {
    return this.db
      .select()
      .from(operationRows)
      .where(eq(operationRows.kind, kind))
      .orderBy(operationRows.id)
      .all()
      .map((row) => row.result as LedgerValueMap[Kind]);
  }

  streamAfter(cursor: string): SessionStreamItem[] {
    return this.db
      .select()
      .from(operationRows)
      .where(
        and(
          eq(operationRows.kind, "stream"),
          gt(operationRows.id, `stream:${cursor.padStart(16, "0")}`)
        )
      )
      .orderBy(operationRows.id)
      .all()
      .map((row) => row.result as SessionStreamItem);
  }

  deleteOutbox(eventId: string): void {
    this.db
      .delete(operationRows)
      .where(
        and(
          eq(operationRows.kind, "outbox"),
          eq(operationRows.eventId, eventId)
        )
      )
      .run();
  }

  readSession(key: string): string | undefined {
    return this.db
      .select()
      .from(sessionRows)
      .where(eq(sessionRows.key, key))
      .get()?.sessionId;
  }

  writeSession(key: string, value: string): void {
    this.db
      .insert(sessionRows)
      .values({ key, sessionId: value })
      .onConflictDoUpdate({
        set: { sessionId: value },
        target: sessionRows.key,
      })
      .run();
  }
}
