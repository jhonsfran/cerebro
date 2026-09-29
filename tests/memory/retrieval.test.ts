import { expect, test } from "bun:test";

import { createMemoryStore } from "../../packages/memory/src/index.ts";
import { fixture, readOptions } from "./fixture.ts";

test("real PostgreSQL full-text fixed questions return literal provenance citations", async () => {
  const f = await fixture({ retrievalMode: "full-text" });
  try {
    await f.add(
      "travel",
      "Employees must submit travel receipts within thirty days. The finance team approves reimbursements."
    );
    await f.add(
      "leave",
      "Parental leave lasts sixteen weeks. Human resources approves leave requests."
    );
    const questions = [
      {
        sourceId: "travel",
        text: "Who approves travel reimbursements?",
        uri: "https://example.test/travel",
      },
      {
        sourceId: "leave",
        text: "How many weeks does parental leave last?",
        uri: "https://example.test/leave",
      },
    ];
    await Promise.all(
      questions.map(async (question) => {
        const result = await f.memory.retrieve(
          { ...f.scope, limit: 1, text: question.text },
          readOptions()
        );
        expect(result.status).toBe("ok");
        if (result.status !== "ok") {
          throw new Error("Retrieval failed.");
        }
        expect(result.value.map((hit) => hit.citation)).toEqual([
          {
            observedAt: 1_760_000_000_000,
            sourceId: question.sourceId,
            sourceUri: question.uri,
            sourceVersion: "v1",
          },
        ]);
      })
    );
    const citation = await f.memory.retrieve(
      { ...f.scope, limit: 1, text: "travel" },
      readOptions()
    );
    if (citation.status !== "ok") {
      throw new Error("Citation retrieval failed.");
    }
    expect(citation.value[0]?.record.text).toBe(
      "Employees must submit travel receipts within thirty days. The finance team approves reimbursements."
    );
  } finally {
    await f.close();
  }
});

test("real pgvector semantic and hybrid queries rank synthetic fixture embeddings", async () => {
  const f = await fixture();
  try {
    await f.add("billing", "billing refunds payment invoices");
    await f.add("other", "oranges forests waterfalls animals");
    await Promise.all(
      (["semantic", "hybrid"] as const).map(async (retrievalMode) => {
        const memory = createMemoryStore({ ...f.dependencies, retrievalMode });
        const result = await memory.retrieve(
          { ...f.scope, limit: 1, text: "billing refunds payment invoices" },
          readOptions()
        );
        expect(result.status).toBe("ok");
        if (result.status !== "ok") {
          throw new Error("Vector retrieval failed.");
        }
        expect(result.value.map((hit) => hit.record.id)).toEqual([
          "billing-chunk",
        ]);
      })
    );
    const indices =
      await f.client`select indexdef from pg_indexes where tablename = 'memory_record' and indexname = 'memory_record_search_idx'`;
    expect(indices[0]?.indexdef).toContain("USING gin (search)");
  } finally {
    await f.close();
  }
});

test("a denied highest relevance source cannot occupy a limit of one", async () => {
  const f = await fixture({ retrievalMode: "full-text" });
  try {
    await f.add("secret", "refund refund refund refund refund refund");
    await f.add("public", "A refund is available with a receipt.");
    await f.grant("secret", false);
    const result = await f.memory.retrieve(
      { ...f.scope, limit: 1, text: "refund" },
      readOptions()
    );
    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      throw new Error("Filtered retrieval failed.");
    }
    expect(result.value.map((hit) => hit.record.id)).toEqual(["public-chunk"]);
  } finally {
    await f.close();
  }
});

test("full-text retrieval uses stored text when an embedding provider is unavailable or changed", async () => {
  const f = await fixture();
  try {
    await f.add("fts", "The finance team approves reimbursements.");
    let calls = 0;
    const memory = createMemoryStore({
      ...f.dependencies,
      embeddings: {
        dimensions: 1536,
        embed() {
          calls += 1;
          throw new Error("Provider down.");
        },
        model: "different-model",
      },
      retrievalMode: "full-text",
    });
    const result = await memory.retrieve(
      { ...f.scope, limit: 1, text: "reimbursements" },
      readOptions()
    );
    if (result.status !== "ok") {
      throw new Error("Full-text retrieval failed.");
    }
    expect(result.value[0]?.record.text).toBe(
      "The finance team approves reimbursements."
    );
    expect(calls).toBe(0);
  } finally {
    await f.close();
  }
});

test("an actor without permitted records does not call an embedding provider", async () => {
  const f = await fixture();
  try {
    await f.add("paid", "Billing private content");
    await f.grant("paid", false);
    let calls = 0;
    const memory = createMemoryStore({
      ...f.dependencies,
      embeddings: {
        ...f.dependencies.embeddings,
        embed: () => {
          calls += 1;
          return Promise.reject(new Error("Should not be called."));
        },
      },
    });
    expect(
      await memory.retrieve(
        { ...f.scope, limit: 1, text: "Billing" },
        readOptions()
      )
    ).toEqual({ status: "ok", value: [] });
    expect(calls).toBe(0);
  } finally {
    await f.close();
  }
});
