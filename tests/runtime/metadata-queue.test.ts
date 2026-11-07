import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { test } from "node:test";

import { id } from "../../packages/contracts/src/identity.ts";
import { createModels } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  Harness,
  createRegistry,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { piContext } from "../../packages/runtime/src/pi-harness.ts";
import type { MetadataTransaction } from "../../packages/runtime/src/session-agent.ts";

const platformImports = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return { shortCircuit: true, url: "data:text/javascript,export {};" };
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ERR_MODULE_NOT_FOUND" &&
        specifier.startsWith(".")
      ) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});
const { openPiSessionStore } =
  await import("../../packages/runtime/node_modules/agents/dist/harness/pi/index.js");
const { createSourceDependencyStore } =
  await import("../../packages/runtime/src/content-dependency-store.ts");
platformImports.deregister();

const setup = async () => {
  const database = new DatabaseSync(":memory:");
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  let armed = false;
  let rejectCommit = false;
  let insideNativeTransaction = false;
  let sourceWritesInsideNativeTransaction = 0;
  const storage = {
    sql: {
      exec: (query: string, ...bindings: SQLInputValue[]) => {
        if (
          rejectCommit &&
          query.startsWith("UPDATE pi_durable_metadata SET next_id")
        ) {
          throw new Error("Injected native commit failure");
        }
        if (
          insideNativeTransaction &&
          query.startsWith("INSERT OR IGNORE INTO cerebro_content_source")
        ) {
          sourceWritesInsideNativeTransaction += 1;
        }
        const rows = database.prepare(query).all(...bindings);
        return {
          [Symbol.iterator]: () => rows[Symbol.iterator](),
          next: () =>
            rows.length ? { done: false, value: rows[0] } : { done: true },
          toArray: () => rows,
        };
      },
    },
    transaction: async <A>(operation: () => Promise<A>): Promise<A> => {
      database.exec("BEGIN");
      insideNativeTransaction = true;
      try {
        if (armed) {
          armed = false;
          entered.resolve(true);
          await release.promise;
        }
        const value = await operation();
        database.exec("COMMIT");
        return value;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      } finally {
        insideNativeTransaction = false;
      }
    },
  };
  // The SDK uses only SQL and transaction from this platform storage fixture.
  const platformStorage = storage as unknown as DurableObjectStorage;
  const context = piContext();
  let nativeStorage = await openPiSessionStore(platformStorage);
  let pi = await Harness.open(
    nativeStorage,
    {
      models: createModels(),
      registry: createRegistry(),
      settings: { extensions: [] },
    },
    context
  );
  const metadata: MetadataTransaction = (operation) =>
    pi.commit(operation, context);
  const sources = await metadata(() =>
    createSourceDependencyStore(
      platformStorage,
      id.session("session:protected"),
      metadata
    )
  );
  return {
    arm: (failure: boolean) => {
      armed = true;
      rejectCommit = failure;
    },
    close: async () => {
      release.resolve(true);
      await pi.close(context);
      database.close();
    },
    createConversation: () =>
      pi.createConversation({ ownership: { kind: "ownerless" } }, context),
    database,
    entered: entered.promise,
    host: () => pi,
    metadata,
    reopen: async () => {
      await pi.close(context);
      rejectCommit = false;
      armed = false;
      nativeStorage = await openPiSessionStore(platformStorage);
      pi = await Harness.open(
        nativeStorage,
        {
          models: createModels(),
          registry: createRegistry(),
          settings: { extensions: [] },
        },
        context
      );
    },
    sourceStore: (sessionId: string) =>
      metadata(() =>
        createSourceDependencyStore(
          platformStorage,
          id.session(sessionId),
          metadata
        )
      ),
    storage: () => nativeStorage,
    release: () => release.resolve(true),
    sourceRows: () =>
      database
        .prepare(
          "SELECT source_id FROM cerebro_content_source ORDER BY source_id"
        )
        .all()
        .map((row) => row.source_id),
    sourceWritesInsideNativeTransaction: () =>
      sourceWritesInsideNativeTransaction,
    sources,
  };
};

test("source metadata cannot acknowledge a write inside a failed native Pi commit", async () => {
  const fixture = await setup();
  try {
    fixture.arm(true);
    const native = assert.rejects(
      fixture.createConversation(),
      /Injected native commit failure/u
    );
    await fixture.entered;
    const metadata = Promise.allSettled([
      fixture.sources.all(),
      fixture.sources.add(["private-source"]),
    ]);
    fixture.release();
    await native;
    const outcomes = await metadata;
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status),
      ["rejected", "rejected"]
    );
    assert.equal(fixture.sourceWritesInsideNativeTransaction(), 0);
    assert.deepEqual(fixture.sourceRows(), []);
  } finally {
    await fixture.close();
  }
});

test("source metadata commits after a concurrent native Pi conversation commit", async () => {
  const fixture = await setup();
  try {
    fixture.arm(false);
    const native = fixture.createConversation();
    await fixture.entered;
    const write = fixture.sources.add(["private-source"]);
    fixture.release();
    const conversation = await native;
    await write;
    assert.ok(conversation.id > 0);
    assert.equal(fixture.sourceWritesInsideNativeTransaction(), 0);
    assert.deepEqual(await fixture.sources.all(), ["private-source"]);
    assert.deepEqual(fixture.sourceRows(), ["private-source"]);
  } finally {
    await fixture.close();
  }
});
