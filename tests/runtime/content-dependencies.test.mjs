import { test } from "bun:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { createSourceDependencyStore } from "../../apps/server/src/session/content.ts";

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
const addressFor = (name) => ({
  agentId: `agent:${name}`,
  conversationId: `conversation:${name}`,
  organizationId: "organization",
  sessionId: `session:${name}`,
});

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

test("fresh identity dependencies do not import legacy conversation metadata", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE cerebro_pi_session (state TEXT NOT NULL)");
    const state = JSON.stringify({
      snapshot: { outputs: [{ dependencies: { sourceIds: ["old-source"] } }] },
    });
    database.prepare("INSERT INTO cerebro_pi_session VALUES (?)").run(state);
    const metadata = metadataFor(database);
    const dependencies = await metadata(() =>
      createSourceDependencyStore(
        storageFor(database),
        "session:fresh",
        metadata
      )
    );
    assert.deepEqual(await dependencies.all(), []);
    assert.equal(
      database.prepare("SELECT state FROM cerebro_pi_session").get().state,
      state
    );
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

test("history inheritance copies source, tool and chat evidence monotonically into its receiving scope", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const metadata = metadataFor(database);
    const storage = storageFor(database);
    const [earlier, source, target, sibling] = await Promise.all(
      ["earlier", "source", "target", "sibling"].map((name) =>
        metadata(() =>
          createSourceDependencyStore(
            storage,
            addressFor(name).sessionId,
            metadata
          )
        )
      )
    );
    await earlier.add(["earlier-source", "shared-source"]);
    await earlier.addTool("earlier-tool");
    await source.add(["source-source", "shared-source"]);
    await source.addTool("source-tool");
    await target.add(["target-source"]);
    await target.addTool("target-tool");
    await sibling.add(["sibling-source"]);
    await metadata(() =>
      source.inherit(addressFor("earlier"), ["native-earlier-tool"], true)
    );
    await metadata(() =>
      target.inherit(
        addressFor("source"),
        ["native-source-tool", "source-tool"],
        true
      )
    );
    await metadata(() =>
      target.inherit(addressFor("source"), ["native-source-tool"], true)
    );
    assert.deepEqual(await target.all(), [
      "earlier-source",
      "shared-source",
      "source-source",
      "target-source",
    ]);
    assert.deepEqual(await target.tools(), [
      "earlier-tool",
      "native-earlier-tool",
      "native-source-tool",
      "source-tool",
      "target-tool",
    ]);
    assert.deepEqual(await target.history(), [
      addressFor("earlier"),
      addressFor("source"),
    ]);
    assert.deepEqual(await source.history(), [addressFor("earlier")]);
    assert.deepEqual(await source.tools(), [
      "earlier-tool",
      "native-earlier-tool",
      "source-tool",
    ]);
    assert.deepEqual(await sibling.all(), ["sibling-source"]);
    assert.deepEqual(await sibling.tools(), []);
    assert.deepEqual(await sibling.history(), []);
    const reopened = await metadata(() =>
      createSourceDependencyStore(
        storageFor(database),
        addressFor("target").sessionId,
        metadata
      )
    );
    assert.deepEqual(await reopened.all(), await target.all());
    assert.deepEqual(await reopened.tools(), await target.tools());
    assert.deepEqual(await reopened.history(), await target.history());
  } finally {
    database.close();
  }
});

test("fork inheritance keeps prior history evidence and omits a new dependency on its parent chat", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const metadata = metadataFor(database);
    const storage = storageFor(database);
    const [evidence, parent, fork] = await Promise.all(
      ["evidence", "parent", "fork"].map((name) =>
        metadata(() =>
          createSourceDependencyStore(
            storage,
            addressFor(name).sessionId,
            metadata
          )
        )
      )
    );
    await evidence.add(["company-source"]);
    await evidence.addTool("company-tool");
    await parent.add(["parent-source"]);
    await metadata(() =>
      parent.inherit(addressFor("evidence"), ["historic-tool"], true)
    );
    await metadata(() => fork.inherit(addressFor("parent"), [], false));
    assert.deepEqual(await fork.all(), ["company-source", "parent-source"]);
    assert.deepEqual(await fork.tools(), ["company-tool", "historic-tool"]);
    assert.deepEqual(await fork.history(), [addressFor("evidence")]);
    await parent.add(["later-parent-source"]);
    await parent.addTool("later-parent-tool");
    assert.deepEqual(await fork.all(), ["company-source", "parent-source"]);
    assert.deepEqual(await fork.tools(), ["company-tool", "historic-tool"]);
    await metadata(() => fork.inherit(addressFor("parent"), [], false));
    assert.deepEqual(await fork.all(), [
      "company-source",
      "later-parent-source",
      "parent-source",
    ]);
    assert.deepEqual(await fork.tools(), [
      "company-tool",
      "historic-tool",
      "later-parent-tool",
    ]);
    assert.deepEqual(await fork.history(), [addressFor("evidence")]);
  } finally {
    database.close();
  }
});

test("history copies flatten cycles without recording the receiving chat as its own evidence", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const metadata = metadataFor(database);
    const storage = storageFor(database);
    const [first, second] = await Promise.all(
      ["first", "second"].map((name) =>
        metadata(() =>
          createSourceDependencyStore(
            storage,
            addressFor(name).sessionId,
            metadata
          )
        )
      )
    );
    await first.add(["first-source"]);
    await second.add(["second-source"]);
    await metadata(() => first.inherit(addressFor("second"), [], true));
    await metadata(() => second.inherit(addressFor("first"), [], true));
    await metadata(() => first.inherit(addressFor("second"), [], true));
    assert.deepEqual(await first.all(), ["first-source", "second-source"]);
    assert.deepEqual(await second.all(), ["first-source", "second-source"]);
    assert.deepEqual(await first.history(), [addressFor("second")]);
    assert.deepEqual(await second.history(), [addressFor("first")]);
  } finally {
    database.close();
  }
});
