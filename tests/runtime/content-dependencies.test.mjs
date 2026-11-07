import { test } from "bun:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { createSourceDependencyStore } from "../../packages/runtime/src/content-dependency-store.ts";

const storageFor = (database) => ({
  sql: {
    exec: (query, ...bindings) => {
      const rows = database.prepare(query).all(...bindings);
      return { toArray: () => rows };
    },
  },
});
const metadataFor = (database) => {
  let tail = Promise.resolve();
  return (operation) => {
    const result = tail.then(async () => {
      database.exec("BEGIN");
      try {
        const value = await operation();
        database.exec("COMMIT");
        return value;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
    tail = result.then(
      () => null,
      () => null
    );
    return result;
  };
};
test("source dependencies persist per conversation when an identity hosts multiple chats", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const storage = storageFor(database);
    const metadata = metadataFor(database);
    const first = await metadata(() =>
      createSourceDependencyStore(storage, "session:first", metadata)
    );
    const second = await metadata(() =>
      createSourceDependencyStore(storage, "session:second", metadata)
    );
    assert.deepEqual(await first.all(), []);
    assert.deepEqual(await second.all(), []);

    await first.add(["private-source", "shared-source", "private-source"]);
    await second.add(["second-source", "shared-source"]);
    assert.deepEqual(await first.all(), ["private-source", "shared-source"]);
    assert.deepEqual(await second.all(), ["second-source", "shared-source"]);

    const reopened = await metadata(() =>
      createSourceDependencyStore(
        storageFor(database),
        "session:first",
        metadata
      )
    );
    assert.deepEqual(await reopened.all(), ["private-source", "shared-source"]);
    const fresh = await metadata(() =>
      createSourceDependencyStore(storage, "session:new", metadata)
    );
    assert.deepEqual(await fresh.all(), []);
    await reopened.add(["later-source"]);
    assert.deepEqual(await first.all(), [
      "later-source",
      "private-source",
      "shared-source",
    ]);
    assert.deepEqual(await second.all(), ["second-source", "shared-source"]);
  } finally {
    database.close();
  }
});

test("source reads and writes wait for an unrelated failed native transaction", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const metadata = metadataFor(database);
    const sources = await metadata(() =>
      createSourceDependencyStore(
        storageFor(database),
        "session:protected",
        metadata
      )
    );
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    const failed = assert.rejects(
      metadata(async () => {
        database
          .prepare("INSERT INTO cerebro_content_source VALUES (?, ?)")
          .run("session:protected", "uncommitted-source");
        entered.resolve();
        await release.promise;
        throw new Error("Native transaction rolled back");
      }),
      /Native transaction rolled back/u
    );
    await entered.promise;
    const read = sources.all();
    const write = sources.add(["retained-source"]);
    release.resolve();
    await failed;
    assert.deepEqual(await read, []);
    await write;
    assert.deepEqual(await sources.all(), ["retained-source"]);
  } finally {
    database.close();
  }
});
