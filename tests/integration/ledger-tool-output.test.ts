import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { id } from "../../packages/contracts/src/identity.ts";
import { SessionLedger } from "../../packages/runtime/src/ledger.ts";

const storageFor = (database: DatabaseSync): DurableObjectStorage =>
  ({
    sql: {
      exec: (query: string, ...parameters: (string | number | null)[]) => {
        const statement = database.prepare(query);
        let rows: Record<string, unknown>[] = [];
        if (statement.columns().length === 0) {
          statement.run(...parameters);
        } else {
          rows = statement.all(...parameters);
        }
        return {
          next: () => rows.values().next(),
          raw: () => {
            const raw = rows.map((row) => Object.values(row));
            const iterator = raw.values();
            return {
              next: () => iterator.next(),
              toArray: () => raw,
              [Symbol.iterator]: () => iterator,
            };
          },
          toArray: () => rows,
          [Symbol.iterator]: () => rows.values(),
        };
      },
    },
    transactionSync: <Value>(work: () => Value): Value => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const value = work();
        database.exec("COMMIT");
        return value;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  }) as unknown as DurableObjectStorage;

test("a recovered tool receipt projects one stream and audit event and rejects changed content", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const storage = storageFor(database);
    const ledger = new SessionLedger(storage);
    ledger.bind({
      agentId: id.agent("agent-a"),
      conversationId: id.conversation("conversation-a"),
      organizationId: id.organization("company-a"),
      sessionId: id.session("session-a"),
    });
    const item = {
      dependencies: { sourceIds: [], toolIds: ["tool-a"] },
      operationId: id.operation("tool-operation"),
      output: { value: "approved" },
      runId: id.run("run-a"),
      toolId: id.tool("tool-a"),
      type: "tool" as const,
    };
    const cursor = ledger.recordToolOutput(item);
    const reopened = new SessionLedger(storage);
    assert.equal(reopened.recordToolOutput(item), cursor);
    assert.equal(reopened.stream("0").length, 1);
    assert.equal(reopened.pendingOutbox().length, 1);
    assert.throws(
      () =>
        reopened.recordToolOutput({ ...item, output: { value: "changed" } }),
      /identity changed/u
    );
    assert.equal(reopened.stream("0").length, 1);
    assert.equal(reopened.pendingOutbox().length, 1);
  } finally {
    database.close();
  }
});

test("an existing tool stream from the prior ledger format is reused without a second audit", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const storage = storageFor(database);
    const old = new SessionLedger(storage);
    old.bind({
      agentId: id.agent("agent-a"),
      conversationId: id.conversation("conversation-a"),
      organizationId: id.organization("company-a"),
      sessionId: id.session("session-a"),
    });
    const item = {
      dependencies: { sourceIds: [], toolIds: ["tool-a"] },
      operationId: id.operation("legacy-tool-operation"),
      output: { value: "approved" },
      runId: id.run("run-a"),
      toolId: id.tool("tool-a"),
      type: "tool" as const,
    };
    const cursor = old.append(item.runId, item);
    const upgraded = new SessionLedger(storage);
    assert.equal(upgraded.recordToolOutput(item), cursor);
    assert.equal(upgraded.recordToolOutput(item), cursor);
    assert.equal(upgraded.stream("0").length, 1);
    assert.equal(upgraded.pendingOutbox().length, 1);
    assert.throws(
      () =>
        upgraded.recordToolOutput({ ...item, output: { value: "changed" } }),
      /identity changed/u
    );
    assert.equal(upgraded.stream("0").length, 1);
    assert.equal(upgraded.pendingOutbox().length, 1);
  } finally {
    database.close();
  }
});
