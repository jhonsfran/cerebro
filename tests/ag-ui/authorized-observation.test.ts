import { test } from "bun:test";
import assert from "node:assert/strict";

import { Effect, Stream } from "effect";

import { authorizedObservation } from "../../packages/ag-ui/src/authorized-observation.ts";
import { Denied, Unavailable } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import type { Observation } from "../../packages/contracts/src/session-service.ts";

const address = {
  agentId: id.agent("agent-1"),
  conversationId: id.conversation("conversation-1"),
  organizationId: id.organization("organization-1"),
  sessionId: id.session("session-1"),
};
const denial = new Denied({ code: "revoked", reason: "Access revoked" });
const frame = (generation = 3): Observation => ({
  accessGeneration: generation,
  address,
  epoch: "host-1",
  reason: "revoked",
  schemaVersion: 1,
  sequence: 1,
  type: "access-denied",
});

test("delivery checks current access before exposing a host frame", async () => {
  let checks = 0;
  const source = authorizedObservation({
    accessGeneration: 3,
    address,
    authorize: Effect.suspend(() => {
      checks += 1;
      return Effect.fail(denial);
    }),
    source: Stream.make(frame()),
  });
  const values = await Effect.runPromise(
    Stream.runCollect(Stream.scoped(source))
  );
  assert.equal(checks, 1);
  assert.equal(values.length, 1);
  assert.equal(values[0]?.type, "access-denied");
  assert.notEqual(values[0]?.epoch, "host-1");
});

test("an idle attachment emits denial and closes within one second", async () => {
  const started = performance.now();
  const values = await Effect.runPromise(
    Stream.runCollect(
      Stream.scoped(
        authorizedObservation({
          accessGeneration: 3,
          address,
          authorize: Effect.fail(denial),
          source: Stream.fromEffect(Effect.never),
        })
      )
    )
  );
  assert.equal(values.length, 1);
  assert.equal(values[0]?.type, "access-denied");
  assert.ok(performance.now() - started < 1000);
});

test("a stalled current-access read fails closed within one second", async () => {
  const started = performance.now();
  await assert.rejects(
    Effect.runPromise(
      Stream.runCollect(
        Stream.scoped(
          authorizedObservation({
            accessGeneration: 3,
            address,
            authorize: Effect.never,
            source: Stream.fromEffect(Effect.never),
          })
        )
      )
    ),
    (error: unknown) => {
      assert.ok(error instanceof Unavailable);
      assert.equal(error.reason, "Current access could not be verified.");
      return true;
    }
  );
  assert.ok(performance.now() - started < 1000);
});

test("an unavailable authority closes delivery without claiming revocation", async () => {
  const delivered: Observation[] = [];
  const source = authorizedObservation({
    accessGeneration: 3,
    address,
    authorize: Effect.fail(
      new Unavailable({ reason: "Authority storage unavailable" })
    ),
    source: Stream.make(frame()),
  });
  await assert.rejects(
    Effect.runPromise(
      Stream.runForEach(Stream.scoped(source), (value) =>
        Effect.sync(() => {
          delivered.push(value);
        })
      )
    ),
    (error: unknown) => {
      assert.ok(error instanceof Unavailable);
      assert.equal(error.reason, "Authority storage unavailable");
      return true;
    }
  );
  assert.deepEqual(delivered, []);
});

test("frames from an old access generation are discarded", async () => {
  const values = await Effect.runPromise(
    Stream.runCollect(
      Stream.scoped(
        authorizedObservation({
          accessGeneration: 3,
          address,
          authorize: Effect.void,
          source: Stream.make(frame(2), frame(3)),
        })
      )
    )
  );
  assert.equal(values.length, 1);
  assert.equal(values[0]?.accessGeneration, 3);
});
