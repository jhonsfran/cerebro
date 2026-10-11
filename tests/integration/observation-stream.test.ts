import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect, Stream } from "effect";

import { readObservationStream } from "../../apps/server/src/session/observation-stream.ts";
import { guardedObservation } from "../../packages/api/src/observation-delivery.ts";
import { Denied, Unavailable } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import type { Observation } from "../../packages/contracts/src/session-service.ts";

const address = {
  agentId: id.agent("agent-1"),
  conversationId: id.conversation("conversation-1"),
  organizationId: id.organization("organization-1"),
  sessionId: id.session("session-1"),
};
const frame: Observation = {
  accessGeneration: 0,
  address,
  epoch: "epoch-ñ",
  reason: "revoked",
  schemaVersion: 1,
  sequence: 0,
  type: "access-denied",
};

test("revocation closes an idle upstream body while its next read is pending", async () => {
  let cancelled = false;
  let checks = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const guarded = guardedObservation({
    accessGeneration: 0,
    address,
    authorize: () => {
      checks += 1;
      return Promise.reject(
        new Denied({ code: "revoked", reason: "Access revoked" })
      );
    },
    body,
    recheckMs: 10,
  });
  const values = await Effect.runPromise(
    Stream.runCollect(readObservationStream(guarded)).pipe(Effect.timeout(1500))
  );
  assert.equal(values.length, 1);
  assert.equal(values[0].type, "access-denied");
  assert.equal(values[0].accessGeneration, 0);
  assert.equal(cancelled, true);
  assert.equal(checks, 1);
});

test("forwarded bytes pass through unchanged until the next access read fails", async () => {
  const encoder = new TextEncoder();
  let checks = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
    },
  });
  const guarded = guardedObservation({
    accessGeneration: 0,
    address,
    authorize: () => {
      checks += 1;
      return checks < 3
        ? Promise.resolve()
        : Promise.reject(new Unavailable({ reason: "Authority unavailable" }));
    },
    body,
    recheckMs: 10,
  });
  await assert.rejects(
    Effect.runPromise(Stream.runCollect(readObservationStream(guarded))),
    (error: unknown) => error instanceof Unavailable
  );
  assert.ok(checks >= 3);
});

test("observation decoding preserves fragmented UTF-8 and frozen fields", async () => {
  const bytes = new TextEncoder().encode(`${JSON.stringify(frame)}\n`);
  const unicodeAt = bytes.indexOf(0xc3);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, unicodeAt + 1));
      controller.enqueue(bytes.slice(unicodeAt + 1));
      controller.close();
    },
  });
  const values = await Effect.runPromise(
    Stream.runCollect(readObservationStream(body))
  );
  assert.deepEqual(values, [frame]);
});

test("oversized fragmented frames fail before JSON decoding", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(1_048_576)));
      controller.enqueue(new TextEncoder().encode("x"));
      controller.close();
    },
  });
  await assert.rejects(
    Effect.runPromise(Stream.runCollect(readObservationStream(body))),
    (error: unknown) => {
      assert.ok(error instanceof Unavailable);
      assert.equal(error.reason, "Session observation frame is too large.");
      return true;
    }
  );
});

test("the frame limit counts UTF-8 bytes across fragmented chunks", async () => {
  const bytes = new TextEncoder().encode(
    `${JSON.stringify({ ...frame, epoch: "ñ".repeat(600_000) })}\n`
  );
  assert.ok(bytes.length > 1_048_576);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 700_001));
      controller.enqueue(bytes.slice(700_001));
      controller.close();
    },
  });
  await assert.rejects(
    Effect.runPromise(Stream.runCollect(readObservationStream(body))),
    (error: unknown) => {
      assert.ok(error instanceof Unavailable);
      assert.equal(error.reason, "Session observation frame is too large.");
      return true;
    }
  );
});

test("EOF cannot complete a frame without its NDJSON newline", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(frame)));
      controller.close();
    },
  });
  await assert.rejects(
    Effect.runPromise(Stream.runCollect(readObservationStream(body))),
    (error: unknown) => {
      assert.ok(error instanceof Unavailable);
      assert.equal(error.reason, "Session observation frame is incomplete.");
      return true;
    }
  );
});
