import { test } from "bun:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { migrateLegacySessionMetadata } from "../../apps/server/src/session/content.ts";

const storageFor = (database) => ({
  sql: {
    exec: (query, ...bindings) => {
      const rows = database.prepare(query).all(...bindings);
      return { toArray: () => rows };
    },
  },
});
const sources = (database) =>
  database
    .prepare("SELECT source_id FROM cerebro_content_source ORDER BY source_id")
    .all()
    .map((row) => row.source_id);

test("legacy pinned agent version and source dependencies survive SQL migration and replay", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(
      "CREATE TABLE cerebro_pi_session (id INTEGER PRIMARY KEY, state TEXT NOT NULL)"
    );
    database.exec(
      "CREATE TABLE cerebro_pi_content (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)"
    );
    database.exec(
      "CREATE TABLE pi_tasks (id INTEGER PRIMARY KEY, record BLOB NOT NULL)"
    );
    const nativeBytes = Buffer.from(
      '{ "memos": { "cerebro-dispatch": "legacy-dispatch" }, "state": { "status": "waiting" } }'
    );
    database.prepare("INSERT INTO pi_tasks VALUES (1, ?)").run(nativeBytes);
    const state = JSON.stringify({
      snapshot: {
        agentVersion: 7,
        outputs: [
          {
            dependencies: { sourceIds: ["private-source"] },
            text: "Protected answer",
          },
        ],
        tools: [
          { dependencies: { sourceIds: ["tool-source", "private-source"] } },
        ],
      },
    });
    database.prepare("INSERT INTO cerebro_pi_session VALUES (1, ?)").run(state);
    database.prepare("INSERT INTO cerebro_pi_content VALUES (1, ?)").run(
      JSON.stringify({
        dependencies: { sourceIds: ["document-source", "private-source"] },
      })
    );
    const storage = storageFor(database);
    assert.equal(migrateLegacySessionMetadata(storage), 7);
    assert.deepEqual(sources(database), [
      "document-source",
      "private-source",
      "tool-source",
    ]);
    assert.equal(migrateLegacySessionMetadata(storage), 7);
    assert.deepEqual(sources(database), [
      "document-source",
      "private-source",
      "tool-source",
    ]);
    assert.equal(
      database.prepare("SELECT state FROM cerebro_pi_session WHERE id=1").get()
        .state,
      state
    );
    assert.deepEqual(
      Buffer.from(
        database.prepare("SELECT record FROM pi_tasks WHERE id=1").get().record
      ),
      nativeBytes
    );
  } finally {
    database.close();
  }
});

test("invalid legacy source metadata fails before permission dependencies can be dropped", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(
      "CREATE TABLE cerebro_pi_session (id INTEGER PRIMARY KEY, state TEXT NOT NULL)"
    );
    const invalid = JSON.stringify({
      snapshot: {
        agentVersion: 4,
        outputs: [{ dependencies: { sourceIds: [42] } }],
        tools: [],
      },
    });
    database
      .prepare("INSERT INTO cerebro_pi_session VALUES (1, ?)")
      .run(invalid);
    assert.throws(() => migrateLegacySessionMetadata(storageFor(database)));
    assert.deepEqual(sources(database), []);
    database.prepare("UPDATE cerebro_pi_session SET state=? WHERE id=1").run(
      JSON.stringify({
        snapshot: {
          agentVersion: 4,
          outputs: [{ dependencies: { sourceIds: ["repaired-source"] } }],
          tools: [],
        },
      })
    );
    assert.equal(migrateLegacySessionMetadata(storageFor(database)), 4);
    assert.deepEqual(sources(database), ["repaired-source"]);
  } finally {
    database.close();
  }
});

test("new native storage has no legacy pin and retains existing source metadata", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const storage = storageFor(database);
    assert.equal(migrateLegacySessionMetadata(storage), undefined);
    assert.deepEqual(sources(database), []);
    database
      .prepare("INSERT INTO cerebro_content_source VALUES (?)")
      .run("native-source");
    assert.equal(migrateLegacySessionMetadata(storage), undefined);
    assert.deepEqual(sources(database), ["native-source"]);
  } finally {
    database.close();
  }
});
