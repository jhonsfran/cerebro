import { expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { id } from "../../packages/contracts/src/index.ts";
import { memoryRecord } from "../../packages/db/src/schema/memory.ts";
import { effectOptions, fixture, readOptions } from "./fixture.ts";

test("full-text memory ingests, remembers, and retrieves without an embedding provider", async () => {
  const f = await fixture({
    embeddings: undefined,
    retrievalMode: "full-text",
  });
  try {
    const text = "Refund requests require proof of purchase.";
    const source = await f.add("refund-policy", text);
    const record = {
      id: "refund-fact",
      kind: "remembered-fact" as const,
      provenance: {
        observedAt: source.input.observedAt,
        sourceId: id.source("refund-policy"),
        sourceUri: source.input.uri,
        sourceVersion: source.input.version,
      },
      text,
      visibility: { kind: "organization" as const },
    };
    const effect = effectOptions();
    expect(await f.memory.remember(f.scope, record, effect)).toEqual({
      status: "ok",
      value: record,
    });
    expect(await f.memory.remember(f.scope, record, effect)).toEqual({
      status: "ok",
      value: record,
    });
    const retrieved = await f.memory.retrieve(
      { ...f.scope, limit: 10, text: "Refund" },
      readOptions()
    );
    if (retrieved.status !== "ok") {
      throw new Error("Full-text retrieval failed without embeddings.");
    }
    expect(retrieved.value.map((hit) => hit.record.id).toSorted()).toEqual([
      "refund-fact",
      "refund-policy-chunk",
    ]);
    const rows = await f.database
      .select({
        dimensions: memoryRecord.embeddingDimensions,
        embedding: memoryRecord.embedding,
        model: memoryRecord.embeddingModel,
      })
      .from(memoryRecord)
      .where(eq(memoryRecord.organizationId, f.organizationId));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toEqual({ dimensions: null, embedding: null, model: null });
    }
  } finally {
    await f.close();
  }
});

test("agent source restrictions apply before the result limit", async () => {
  const f = await fixture({
    embeddings: undefined,
    retrievalMode: "full-text",
  });
  try {
    for (const index of [0, 1, 2, 3, 4, 5]) {
      // oxlint-disable-next-line no-await-in-loop -- Each source publication holds the same organization lock.
      await f.add(`other-${index}`, "rareanswer ".repeat(20));
    }
    await f.add("selected", "rareanswer selected evidence");
    const result = await f.memory.retrieve(
      {
        ...f.scope,
        limit: 6,
        text: "rareanswer",
        sourceIds: [id.source("selected")],
      },
      readOptions()
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      throw new Error("Selected-source retrieval failed");
    }
    expect(result.value.map((hit) => hit.record.text)).toEqual([
      "rareanswer selected evidence",
    ]);
    expect(
      await f.memory.retrieve(
        { ...f.scope, limit: 6, text: "rareanswer", sourceIds: [] },
        readOptions()
      )
    ).toEqual({ status: "ok", value: [] });
  } finally {
    await f.close();
  }
});

test("six results remain available with 17001 authorized records", async () => {
  const f = await fixture({
    embeddings: undefined,
    retrievalMode: "full-text",
  });
  try {
    const { input } = await f.add("large-source", "Original document");
    await Promise.all(
      Array.from({ length: 17 }, (_batchValue, batch) =>
        f.database.insert(memoryRecord).values(
          Array.from({ length: 1000 }, (_recordValue, index) => ({
            id: `bulk-${batch}-${index}`,
            organizationId: f.organizationId,
            sourceId: input.sourceId,
            sourceVersion: input.version,
            sourceUri: input.uri,
            observedAt: new Date(input.observedAt),
            kind: "source-chunk" as const,
            content: "Scalable company evidence",
            visibility: { kind: "organization" as const },
          }))
        )
      )
    );
    const result = await f.memory.retrieve(
      { ...f.scope, limit: 6, text: "Scalable" },
      readOptions()
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      throw new Error("Large retrieval failed");
    }
    expect(result.value.map((hit) => hit.record.text)).toEqual(
      Array.from({ length: 6 }, () => "Scalable company evidence")
    );
  } finally {
    await f.close();
  }
}, 30_000);
