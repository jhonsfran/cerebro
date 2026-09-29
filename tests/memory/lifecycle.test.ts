import { expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { id } from "../../packages/contracts/src/index.ts";
import {
  memoryArtifact,
  memoryArtifactDelete,
  memoryRecord,
} from "../../packages/db/src/schema/memory.ts";
import { artifactRef } from "../../packages/memory/src/artifact-store.ts";
import {
  createArtifactStore,
  createMemoryStore,
} from "../../packages/memory/src/index.ts";
import { effectOptions, fixture, readOptions } from "./fixture.ts";

test("ingestion repeats by actual source fingerprint and operation actor and arguments", async () => {
  const f = await fixture();
  try {
    await f.grant("source");
    const source = f.source("source", "Original stored document");
    const options = effectOptions();
    const first = await f.memory.ingest(f.scope, source, options);
    expect(first).toEqual({
      status: "ok",
      value: { generation: 1, sourceId: "source", version: "v1" },
    });
    expect(await f.memory.ingest(f.scope, source, options)).toEqual(first);
    const reordered = {
      chunks: [{ id: "source-chunk", text: "Original stored document" }],
      document: "Original stored document",
      expectedGeneration: null,
      observedAt: 1_760_000_000_000,
      sourceId: id.source("source"),
      uri: "https://example.test/source",
      version: "v1",
      visibility: { kind: "organization" as const },
    };
    expect(await f.memory.ingest(f.scope, reordered, options)).toEqual(first);
    expect(await f.memory.ingest(f.scope, source, effectOptions())).toEqual(
      first
    );
    const changed = {
      ...source,
      chunks: [{ id: "source-chunk", text: "Different document" }],
      document: "Different document",
    };
    const resolved1 = await f.memory.ingest(f.scope, changed, options);
    expect(resolved1.status).toBe("conflict");
    const resolved2 = await f.memory.ingest(f.scope, changed, effectOptions());
    expect(resolved2.status).toBe("conflict");
    const second = await f.secondActor();
    await f.grant("source", true, second.scope.context.actor.id);
    const resolved3 = await f.memory.ingest(second.scope, source, options);
    expect(resolved3.status).toBe("conflict");
    const original = await f.repository.artifact(
      f.organizationId,
      `${options.operationId}:original`
    );
    if (!original) {
      throw new Error("The original document artifact was not stored.");
    }
    const bytes = await f.artifacts.read(
      f.scope,
      artifactRef(original),
      readOptions()
    );
    if (bytes.status !== "ok") {
      throw new Error("Original document read failed.");
    }
    expect(new TextDecoder().decode(bytes.value)).toBe(
      "Original stored document"
    );
  } finally {
    await f.close();
  }
});

test("source replacement removes obsolete vectors and transitive derived sources", async () => {
  const f = await fixture();
  try {
    const a = await f.add("a", "Obsolete refund process");
    const b = await f.add("b", "Summary B document");
    const c = await f.add("c", "Summary C document");
    const summary = (source: typeof b, sourceId: string, parentId: string) => ({
      dependentSourceIds: [id.source(parentId)],
      id: `${sourceId}-summary`,
      kind: "conversation-summary" as const,
      provenance: {
        observedAt: source.input.observedAt,
        sourceId: id.source(sourceId),
        sourceUri: source.input.uri,
        sourceVersion: "v1",
      },
      text: "Obsolete refund summary",
      visibility: { kind: "organization" as const },
    });
    const resolved4 = await f.memory.remember(
      f.scope,
      summary(b, "b", "a"),
      effectOptions()
    );
    expect(resolved4.status).toBe("ok");
    const resolved5 = await f.memory.remember(
      f.scope,
      summary(c, "c", "b"),
      effectOptions()
    );
    expect(resolved5.status).toBe("ok");
    const replacement = f.source("a", "Current travel process", {
      generation: a.result.generation,
      version: "v2",
    });
    expect(
      await f.memory.ingest(f.scope, replacement, effectOptions())
    ).toEqual({
      status: "ok",
      value: { generation: 2, sourceId: "a", version: "v2" },
    });
    const rows = await f.database
      .select({ id: memoryRecord.id, version: memoryRecord.sourceVersion })
      .from(memoryRecord)
      .where(eq(memoryRecord.organizationId, f.organizationId));
    expect(rows).toEqual([{ id: "a-chunk", version: "v2" }]);
    const resolved6 = await f.repository.source(f.organizationId, "b");
    expect(resolved6?.state).toBe("deleted");
    const resolved7 = await f.repository.source(f.organizationId, "c");
    expect(resolved7?.state).toBe("deleted");
    const resolved8 = await f.memory.ingest(f.scope, a.input, effectOptions());
    expect(resolved8.status).toBe("conflict");
  } finally {
    await f.close();
  }
});

test("a late embedding completion cannot overwrite a newer source publication", async () => {
  const f = await fixture();
  try {
    await f.add("race", "Version one source");
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const slow = createMemoryStore({
      ...f.dependencies,
      embeddings: {
        ...f.dependencies.embeddings,
        async embed(texts, options) {
          entered.resolve();
          await release.promise;
          return await f.dependencies.embeddings.embed(texts, options);
        },
      },
    });
    const late = slow.ingest(
      f.scope,
      f.source("race", "Version two late", { generation: 1, version: "v2" }),
      effectOptions()
    );
    await entered.promise;
    expect(
      await f.memory.ingest(
        f.scope,
        f.source("race", "Version three current", {
          generation: 1,
          version: "v3",
        }),
        effectOptions()
      )
    ).toEqual({
      status: "ok",
      value: { generation: 2, sourceId: "race", version: "v3" },
    });
    release.resolve();
    const resolved9 = await late;
    expect(resolved9.status).toBe("conflict");
    const current = await f.memory.retrieve(
      { ...f.scope, limit: 1, text: "current" },
      readOptions()
    );
    if (current.status !== "ok") {
      throw new Error("Current publication retrieval failed.");
    }
    expect(current.value[0]?.record.text).toBe("Version three current");
  } finally {
    await f.close();
  }
});

test("forget deletes transitive content and retries failed MinIO deletion after restart", async () => {
  const f = await fixture();
  try {
    await f.add("root", "Forget original content");
    const derived = await f.add("derived", "Derived original content");
    const resolved10 = await f.memory.remember(
      f.scope,
      {
        dependentSourceIds: [id.source("root")],
        id: "derived-summary",
        kind: "conversation-summary",
        provenance: {
          observedAt: derived.input.observedAt,
          sourceId: id.source("derived"),
          sourceUri: derived.input.uri,
          sourceVersion: "v1",
        },
        text: "Forget derived summary",
        visibility: { kind: "organization" },
      },
      effectOptions()
    );
    expect(resolved10.status).toBe("ok");
    const originals = await f.database
      .select()
      .from(memoryArtifact)
      .where(eq(memoryArtifact.organizationId, f.organizationId));
    const failingObjects = {
      ...f.objects,
      delete() {
        throw new Error("Injected MinIO deletion failure.");
      },
    };
    const failing = createMemoryStore({
      ...f.dependencies,
      objects: failingObjects,
    });
    const effect = effectOptions();
    expect(await failing.forget(f.scope, id.source("root"), effect)).toEqual({
      status: "ok",
      value: { removed: 3 },
    });
    expect(await failing.forget(f.scope, id.source("root"), effect)).toEqual({
      status: "ok",
      value: { removed: 3 },
    });
    expect(
      await f.memory.retrieve(
        { ...f.scope, limit: 10, text: "Forget" },
        readOptions()
      )
    ).toEqual({ status: "ok", value: [] });
    const pending = await f.database
      .select()
      .from(memoryArtifactDelete)
      .where(eq(memoryArtifactDelete.objectKey, originals[0]?.objectKey ?? ""));
    expect(pending[0]?.lastError).toBe("Injected MinIO deletion failure.");
    const restarted = createArtifactStore(f.dependencies);
    expect(await restarted.cleanup(readOptions())).toEqual({
      status: "ok",
      value: { deleted: 2, failed: 0 },
    });
    await Promise.all(
      originals.map(
        async (original) =>
          await expect(
            f.objects.read(original.objectKey, readOptions())
          ).rejects.toThrow("HTTP 404")
      )
    );
    const resolved11 = await f.memory.ingest(
      f.scope,
      f.source("root", "Stale restored content"),
      effectOptions()
    );
    expect(resolved11.status).toBe("conflict");
    const [firstOriginal] = originals;
    if (!firstOriginal) {
      throw new Error("The source original was not stored.");
    }
    const resolved12 = await f.artifacts.read(
      f.scope,
      artifactRef(firstOriginal),
      readOptions()
    );
    expect(resolved12.status).toBe("not-found");
  } finally {
    await f.close();
  }
});

test("canonical artifacts ignore forged visibility and bind actual bytes and deletion replay", async () => {
  const f = await fixture();
  try {
    const source = await f.add("private-artifact", "Private artifact source", {
      visibility: { kind: "private", ownerId: f.scope.context.actor.id },
    });
    const metadata = {
      organizationId: f.organizationId,
      provenance: {
        observedAt: source.input.observedAt,
        sourceId: id.source("private-artifact"),
        sourceUri: source.input.uri,
        sourceVersion: "v1",
      },
      visibility: {
        kind: "private" as const,
        ownerId: f.scope.context.actor.id,
      },
    };
    const put = effectOptions();
    const stored = await f.artifacts.put(
      f.scope,
      new TextEncoder().encode("canonical bytes"),
      metadata,
      put
    );
    if (stored.status !== "ok") {
      throw new Error("Artifact put failed.");
    }
    const resolved13 = await f.artifacts.put(
      f.scope,
      new TextEncoder().encode("different bytes"),
      metadata,
      put
    );
    expect(resolved13.status).toBe("conflict");
    const second = await f.secondActor();
    await f.grant("private-artifact", true, second.scope.context.actor.id);
    const forged = {
      ...stored.value,
      organizationId: id.organization("forged"),
      provenance: { ...stored.value.provenance, sourceId: id.source("forged") },
      visibility: { kind: "organization" as const },
    };
    const resolved14 = await f.artifacts.read(
      second.scope,
      forged,
      readOptions()
    );
    expect(resolved14.status).toBe("denied");
    const positive = await f.artifacts.read(f.scope, forged, readOptions());
    if (positive.status !== "ok") {
      throw new Error("Canonical artifact read failed.");
    }
    expect(new TextDecoder().decode(positive.value)).toBe("canonical bytes");
    const deletion = effectOptions();
    expect(await f.artifacts.delete(f.scope, stored.value, deletion)).toEqual({
      status: "ok",
      value: undefined,
    });
    expect(await f.artifacts.delete(f.scope, stored.value, deletion)).toEqual({
      status: "ok",
      value: undefined,
    });
    const resolved15 = await f.artifacts.delete(
      second.scope,
      stored.value,
      deletion
    );
    expect(resolved15.status).toBe("denied");
    const resolved16 = await f.artifacts.read(
      f.scope,
      stored.value,
      readOptions()
    );
    expect(resolved16.status).toBe("not-found");
  } finally {
    await f.close();
  }
});

test("artifact reads recheck grant revocation after remote fetch and ingest cancellation is unknown", async () => {
  const f = await fixture();
  try {
    const source = await f.add("remote", "Remote source content");
    const artifact = await f.artifacts.put(
      f.scope,
      new TextEncoder().encode("remote bytes"),
      {
        organizationId: f.organizationId,
        provenance: {
          observedAt: source.input.observedAt,
          sourceId: id.source("remote"),
          sourceUri: source.input.uri,
          sourceVersion: "v1",
        },
        visibility: { kind: "organization" },
      },
      effectOptions()
    );
    if (artifact.status !== "ok") {
      throw new Error("Remote artifact put failed.");
    }
    const reads = createArtifactStore({
      ...f.dependencies,
      objects: {
        ...f.objects,
        async read(key, options) {
          const bytes = await f.objects.read(key, options);
          await f.grant("remote", false);
          return bytes;
        },
      },
    });
    const resolved17 = await reads.read(f.scope, artifact.value, readOptions());
    expect(resolved17.status).toBe("denied");
    await f.grant("cancelled");
    const abort = new AbortController();
    const options = { ...effectOptions(), signal: abort.signal };
    const effects = createMemoryStore({
      ...f.dependencies,
      objects: {
        ...f.objects,
        async put(key, bytes, request) {
          await f.objects.put(key, bytes, request);
          abort.abort();
        },
      },
    });
    const cancelled = await effects.ingest(
      f.scope,
      f.source("cancelled", "Remote effect completes despite cancellation"),
      options
    );
    expect(cancelled.status).toBe("unknown-outcome");
    if (cancelled.status !== "unknown-outcome") {
      throw new Error("Cancellation did not report uncertainty.");
    }
    expect(cancelled.operationId).toBe(options.operationId);
    const reconciled = await f.memory.ingest(
      f.scope,
      f.source("cancelled", "Remote effect completes despite cancellation"),
      { ...options, deadlineAt: Date.now() + 30_000, signal: undefined }
    );
    expect(reconciled).toEqual({
      status: "ok",
      value: { generation: 1, sourceId: "cancelled", version: "v1" },
    });
  } finally {
    await f.close();
  }
});

test("two summaries preserve their exact dependencies through retrieval and operation replay", async () => {
  const f = await fixture({ retrievalMode: "full-text" });
  try {
    await f.add("parent-a", "Evidence A document");
    await f.add("parent-c", "Evidence C document");
    const source = await f.add(
      "conversation",
      "Conversation original document"
    );
    const base = {
      kind: "conversation-summary" as const,
      provenance: {
        observedAt: source.input.observedAt,
        sourceId: id.source("conversation"),
        sourceUri: source.input.uri,
        sourceVersion: "v1",
      },
      text: "Independent summary content",
      visibility: { kind: "organization" as const },
    };
    const first = {
      ...base,
      dependentSourceIds: [id.source("parent-a")],
      id: "summary-one",
    };
    const second = {
      ...base,
      dependentSourceIds: [id.source("parent-c")],
      id: "summary-two",
    };
    const firstEffect = effectOptions();
    expect(await f.memory.remember(f.scope, first, firstEffect)).toEqual({
      status: "ok",
      value: first,
    });
    expect(await f.memory.remember(f.scope, second, effectOptions())).toEqual({
      status: "ok",
      value: second,
    });
    expect(await f.memory.remember(f.scope, first, firstEffect)).toEqual({
      status: "ok",
      value: first,
    });
    const retrieved = await f.memory.retrieve(
      { ...f.scope, limit: 10, text: "Independent summary" },
      readOptions()
    );
    if (retrieved.status !== "ok") {
      throw new Error("Summary retrieval failed.");
    }
    expect(retrieved.value.map((hit) => hit.record)).toEqual([first, second]);
    expect(
      await f.memory.forget(f.scope, id.source("parent-a"), effectOptions())
    ).toEqual({ status: "ok", value: { removed: 4 } });
    const lifecycleResult1 = await f.memory.remember(
      f.scope,
      first,
      firstEffect
    );
    expect(lifecycleResult1.status).toBe("denied");
  } finally {
    await f.close();
  }
});

test("revocation and nonexistent-source tombstones prevent stale ingestion", async () => {
  const f = await fixture();
  try {
    const source = await f.add("revoked", "Revoke stored content");
    expect(
      await f.memory.revoke(f.scope, id.source("revoked"), effectOptions())
    ).toEqual({ status: "ok", value: { removed: 1 } });
    const revoked = await f.repository.source(f.organizationId, "revoked");
    expect(revoked?.state).toBe("revoked");
    const lifecycleResult2 = await f.memory.ingest(
      f.scope,
      source.input,
      effectOptions()
    );
    expect(lifecycleResult2.status).toBe("conflict");
    await f.grant("never-published");
    expect(
      await f.memory.forget(
        f.scope,
        id.source("never-published"),
        effectOptions()
      )
    ).toEqual({ status: "ok", value: { removed: 0 } });
    const lifecycleResult3 = await f.memory.ingest(
      f.scope,
      f.source("never-published", "Stale unpublished content"),
      effectOptions()
    );
    expect(lifecycleResult3.status).toBe("conflict");
  } finally {
    await f.close();
  }
});
