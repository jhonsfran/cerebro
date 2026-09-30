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
