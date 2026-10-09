import { test } from "bun:test";
import assert from "node:assert/strict";

import { Effect, Stream } from "effect";

import {
  CHAT_CONTENT_TYPE,
  MAX_CHAT_BATCH_BYTES,
  MAX_CHAT_FRAME_BYTES,
  MAX_DOMAIN_FRAME_BYTES,
  decodeObservation,
  observationIdentity,
  protocolBatchResponse,
  protocolBatches,
  protocolResponse,
  readProtocolBatches,
} from "../../packages/ag-ui/src/protocol.ts";

const observation = decodeObservation({
  accessGeneration: 0,
  address: {
    agentId: "agent",
    conversationId: "conversation",
    organizationId: "company",
    sessionId: "session",
  },
  epoch: "epoch",
  reason: "attach",
  schemaVersion: 1,
  sequence: 0,
  snapshot: {
    address: {
      agentId: "agent",
      conversationId: "conversation",
      organizationId: "company",
      sessionId: "session",
    },
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
});

const collectBatch = (response: Response) => {
  assert.ok(response.body);
  return Effect.runPromise(
    Stream.runCollect(readProtocolBatches(response.body))
  );
};

test("private delivery carries one domain observation and retains the ordered mapped batch", async () => {
  const wire = await protocolBatchResponse(Stream.make(observation)).text();
  const envelope = JSON.parse(wire);
  assert.deepEqual(Object.keys(envelope), ["events"]);
  assert.equal(envelope.events.length, 2);
  const batches = await collectBatch(new Response(wire));
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0]?.observation, observation);
  assert.deepEqual(batches[0]?.events, envelope.events);
});

test("the private reader rejects a line above its bounded expansion limit", async () => {
  await assert.rejects(
    collectBatch(new Response(`${" ".repeat(MAX_CHAT_BATCH_BYTES + 1)}\n`)),
    { reason: "Chat observation frame is too large." }
  );
});

test("the private reader rejects an excessive mapped frame within a valid batch bound", async () => {
  const batches = await Effect.runPromise(
    Stream.runCollect(Stream.scoped(protocolBatches(Stream.make(observation))))
  );
  const wire = JSON.stringify({
    events: [
      ...(batches[0]?.events ?? []),
      {
        delta: "A".repeat(MAX_CHAT_FRAME_BYTES),
        messageId: "assistant",
        metadata: { cerebro: observationIdentity(observation) },
        type: "TEXT_MESSAGE_CONTENT",
      },
    ],
  });
  assert.ok(new TextEncoder().encode(wire).length < MAX_CHAT_BATCH_BYTES);
  await assert.rejects(collectBatch(new Response(`${wire}\n`)), {
    reason: "Chat observation frame is invalid.",
  });
});

test("the private reader rejects source observations above the domain limit", async () => {
  const wire = JSON.stringify({
    events: [
      {
        metadata: { cerebro: observationIdentity(observation) },
        name: "cerebro.snapshot",
        type: "CUSTOM",
        value: { ...observation, epoch: "A".repeat(MAX_DOMAIN_FRAME_BYTES) },
      },
    ],
  });
  await assert.rejects(collectBatch(new Response(`${wire}\n`)), {
    reason: "Chat observation frame is invalid.",
  });
});

test("server encoding retains both source and mapped frame limits", async () => {
  const excessive = decodeObservation({
    ...observation,
    epoch: "A".repeat(MAX_DOMAIN_FRAME_BYTES),
  });
  await assert.rejects(protocolBatchResponse(Stream.make(excessive)).text(), {
    reason: "Chat observation frame is too large.",
  });
  const event = {
    delta: "A".repeat(MAX_CHAT_FRAME_BYTES),
    messageId: "assistant",
    type: "TEXT_MESSAGE_CONTENT" as const,
  };
  const response = protocolResponse(
    Stream.make({ events: [event], observation })
  );
  assert.equal(response.headers.get("Content-Type"), CHAT_CONTENT_TYPE);
  await assert.rejects(response.text(), {
    reason: "Chat observation frame is too large.",
  });
});
