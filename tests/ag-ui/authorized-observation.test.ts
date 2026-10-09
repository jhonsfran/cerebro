import { test } from "bun:test";
import assert from "node:assert/strict";

import { Effect, Stream } from "effect";

import {
  authorizedObservation,
  authorizedProtocolResponse,
} from "../../packages/ag-ui/src/authorized-observation.ts";
import {
  protocolBatches,
  decodeStreamChunk,
} from "../../packages/ag-ui/src/protocol.ts";
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

test("a host denial frame passes through without another access read", async () => {
  let checks = 0;
  const source = authorizedObservation({
    accessGeneration: 3,
    address,
    authorize: Effect.suspend(() => {
      checks += 1;
      return Effect.void;
    }),
    source: Stream.make(frame()),
  });
  const values = await Effect.runPromise(
    Stream.runCollect(Stream.scoped(source))
  );
  assert.equal(checks, 0);
  assert.equal(values.length, 1);
  assert.equal(values[0]?.type, "access-denied");
  assert.equal(values[0]?.epoch, "host-1");
});

test("an idle attachment rechecks access on its interval and closes on denial", async () => {
  const started = performance.now();
  const values = await Effect.runPromise(
    Stream.runCollect(
      Stream.scoped(
        authorizedObservation({
          accessGeneration: 3,
          accessRecheckMs: 10,
          address,
          authorize: Effect.fail(denial),
          source: Stream.fromEffect(Effect.never),
        })
      )
    )
  );
  assert.equal(values.length, 1);
  assert.equal(values[0]?.type, "access-denied");
  assert.notEqual(values[0]?.epoch, "host-1");
  assert.ok(performance.now() - started < 1000);
});

test("a stalled current-access read fails closed within two seconds", async () => {
  const started = performance.now();
  await assert.rejects(
    Effect.runPromise(
      Stream.runCollect(
        Stream.scoped(
          authorizedObservation({
            accessGeneration: 3,
            accessRecheckMs: 10,
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
  assert.ok(performance.now() - started < 2000);
});

test("an unavailable authority closes delivery without claiming revocation", async () => {
  const delivered: Observation[] = [];
  const source = authorizedObservation({
    accessGeneration: 3,
    accessRecheckMs: 10,
    address,
    authorize: Effect.fail(
      new Unavailable({ reason: "Authority storage unavailable" })
    ),
    source: Stream.fromEffect(Effect.never),
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

test("a mapped batch keeps event order and revokes on the access interval", async () => {
  let checks = 0;
  const snapshot: Observation = {
    accessGeneration: 3,
    address,
    epoch: "batch-host",
    reason: "attach",
    schemaVersion: 1,
    sequence: 0,
    snapshot: {
      address,
      agentVersion: 1,
      approvals: [],
      executions: [],
      outputs: [],
      revision: 0,
      runs: [],
      tools: [],
      userMessages: [],
    },
    type: "snapshot",
  };
  const response = authorizedProtocolResponse({
    accessGeneration: 3,
    accessRecheckMs: 10,
    address,
    authorize: Effect.suspend(() => {
      checks += 1;
      return checks === 1 ? Effect.void : Effect.fail(denial);
    }),
    source: Stream.concat(
      protocolBatches(Stream.make(snapshot)),
      Stream.fromEffect(Effect.never)
    ),
  });
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const first = await reader.read();
  const second = await reader.read();
  const initial =
    `${decoder.decode(first.value)}${decoder.decode(second.value)}`
      .trim()
      .split("\n")
      .map((line) => decodeStreamChunk(JSON.parse(line)));
  assert.deepEqual(
    initial.map((event) => event.type),
    ["CUSTOM", "MESSAGES_SNAPSHOT"]
  );
  const next = await reader.read();
  const revoked = decodeStreamChunk(JSON.parse(decoder.decode(next.value)));
  assert.equal(revoked.type, "CUSTOM");
  assert.equal(
    revoked.type === "CUSTOM" ? revoked.name : null,
    "cerebro.access-denied"
  );
  assert.ok(checks >= 2);
  const end = await reader.read();
  assert.equal(end.done, true);
  reader.releaseLock();
});
