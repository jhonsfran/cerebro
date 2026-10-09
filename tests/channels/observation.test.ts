/* oxlint-disable no-await-in-loop -- Observation tests wait for serial lifecycle transitions. */
import { test } from "bun:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { Schema } from "effect";

import {
  createObservationClient,
  decodeObservation,
} from "../../apps/web/src/features/product/observation";
import {
  projectObservation,
  projectionMessages,
} from "../../apps/web/src/features/product/projection";
import {
  CanonicalOutput,
  DomainSnapshot,
} from "../../packages/contracts/src/session-service.ts";
import type { Observation } from "../../packages/contracts/src/session-service.ts";

const snapshot = Schema.decodeUnknownSync(DomainSnapshot)({
  address: {
    agentId: "agent-1",
    conversationId: "conversation-1",
    organizationId: "organization-1",
    sessionId: "session-1",
  },
  agentVersion: 1,
  approvals: [],
  executions: [{ executionId: "execution-1", runIds: ["run-1"] }],
  outputs: [],
  revision: 0,
  runs: [{ runId: "run-1", state: "running" }],
  tools: [],
  userMessages: [
    {
      eventId: "event-1",
      mode: "follow-up",
      occurredAt: 1,
      runId: "run-1",
      text: "Question",
    },
  ],
});
const frame = (
  epoch = "epoch-1",
  generation = 0,
  state = snapshot,
  partial?: readonly {
    executionId: string;
    runId: string;
    text: string;
    thinking: string;
  }[]
): Observation =>
  decodeObservation({
    accessGeneration: generation,
    address: snapshot.address,
    epoch,
    partial,
    reason: "attach",
    schemaVersion: 1,
    sequence: 0,
    snapshot: state,
    type: "snapshot",
  });
const update = (
  sequence: number,
  revision: number,
  value: unknown,
  epoch = "epoch-1",
  generation = 0
): Observation =>
  decodeObservation({
    accessGeneration: generation,
    address: snapshot.address,
    epoch,
    revision,
    schemaVersion: 1,
    sequence,
    type: "update",
    update: value,
  });
const output = Schema.decodeUnknownSync(CanonicalOutput)({
  answerId: "answer-1",
  citations: [
    {
      observedAt: 1,
      sourceId: "source-1",
      sourceUri: "https://fixture.invalid/source",
      sourceVersion: "1",
    },
  ],
  dependencies: { sourceIds: ["source-1"], toolIds: [] },
  executionId: "execution-1",
  runId: "run-1",
  runIds: ["run-1"],
  text: "Canonical answer",
});
const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }
  assert.fail("Observation lifecycle did not settle.");
};
const openUntilAbort = (signal: AbortSignal) => {
  const end = Promise.withResolvers<null>();
  signal.addEventListener("abort", () => end.resolve(null), { once: true });
  return end.promise;
};

test("canonical output replaces provisional text and clears execution citations", () => {
  let projection = projectObservation(null, frame());
  projection = projectObservation(
    projection,
    update(1, 0, {
      executionId: "execution-1",
      runId: "run-1",
      text: "Partial",
      type: "provisional-text",
    })
  );
  projection = projectObservation(
    projection,
    update(2, 0, {
      citation: output.citations[0],
      dependencies: output.dependencies,
      executionId: "execution-1",
      runId: "run-1",
      text: "Partial",
      type: "citation",
    })
  );
  assert.equal(projection?.provisional["execution-1"], "Partial");
  assert.equal(projection?.citations.length, 1);
  projection = projectObservation(
    projection,
    update(3, 1, { output, type: "canonical-output" })
  );
  assert.deepEqual(projection?.provisional, {});
  assert.deepEqual(projection?.citations, []);
  assert.deepEqual(
    projectionMessages(projection).map((message) => [
      message.id,
      message.parts.map((part) => part.type),
    ]),
    [
      ["event-1", ["text"]],
      ["assistant:answer-1", ["text"]],
    ]
  );
});

test("a partial snapshot restores text and thinking for the active execution", () => {
  const projection = projectObservation(
    null,
    frame("epoch-1", 0, snapshot, [
      {
        executionId: "execution-1",
        runId: "run-1",
        text: "Answer so far",
        thinking: "Thinking so far",
      },
    ])
  );
  const [, answer] = projectionMessages(projection);
  assert.deepEqual(answer?.parts, [
    {
      content: "Thinking so far",
      stepId: "assistant:execution-1",
      type: "thinking",
    },
    { content: "Answer so far", type: "text" },
  ]);
});

test("joined steering inputs project one answer under the shared execution", () => {
  const joined = Schema.decodeUnknownSync(DomainSnapshot)({
    ...snapshot,
    executions: [{ executionId: "execution-1", runIds: ["run-1", "run-2"] }],
    outputs: [{ ...output, runIds: ["run-1", "run-2"] }],
    runs: [
      { completedAt: 3, runId: "run-1", state: "completed" },
      { completedAt: 3, runId: "run-2", state: "completed" },
    ],
    userMessages: [
      ...snapshot.userMessages,
      {
        eventId: "event-2",
        mode: "steer",
        occurredAt: 2,
        runId: "run-2",
        text: "Steering input",
      },
    ],
  });
  const messages = projectionMessages(
    projectObservation(null, frame("epoch-1", 0, joined))
  );
  assert.deepEqual(
    messages.map((message) => message.id),
    ["event-1", "event-2", "assistant:answer-1"]
  );
});

test("tools and approvals upsert by their operation identity", () => {
  const tool = {
    arguments: { ticket: "ticket-1" },
    dependencies: { sourceIds: [], toolIds: ["tool-1"] },
    effect: "write",
    operationId: "operation-1",
    output: null,
    runId: "run-1",
    state: "waiting-for-approval",
    toolId: "tool-1",
    toolVersion: "1",
  };
  const approval = {
    approvalId: "approval-1",
    expiresAt: 60_000,
    operationId: "operation-1",
    runId: "run-1",
    state: "pending",
  };
  let projection = projectObservation(null, frame());
  projection = projectObservation(
    projection,
    update(1, 1, { ...tool, type: "tool" })
  );
  projection = projectObservation(
    projection,
    update(2, 2, { ...approval, type: "approval" })
  );
  projection = projectObservation(
    projection,
    update(3, 3, { ...approval, state: "allowed", type: "approval" })
  );
  projection = projectObservation(
    projection,
    update(4, 4, {
      ...tool,
      output: { ok: true },
      state: "succeeded",
      type: "tool",
    })
  );
  assert.equal(projection?.snapshot.tools.length, 1);
  assert.equal(projection?.snapshot.tools[0]?.state, "succeeded");
  assert.equal(projection?.snapshot.approvals.length, 1);
  assert.equal(projection?.snapshot.approvals[0]?.state, "allowed");
  const [, answer] = projectionMessages(projection);
  assert.deepEqual(
    answer?.parts.map((part) => part.type),
    ["tool-call", "tool-result"]
  );
});

test("denial clears protected state, ignores later frames and stops reconnect", async () => {
  let generation = 0;
  let denials = 0;
  let opens = 0;
  let closes = 0;
  const source = async function* source() {
    opens += 1;
    try {
      yield frame();
      yield update(1, 0, {
        executionId: "execution-1",
        runId: "run-1",
        text: "Private",
        type: "provisional-text",
      });
      yield decodeObservation({
        accessGeneration: 0,
        address: snapshot.address,
        epoch: "epoch-1",
        reason: "revoked",
        schemaVersion: 1,
        sequence: 2,
        type: "access-denied",
      });
      yield update(3, 1, { output, type: "canonical-output" });
    } finally {
      closes += 1;
    }
  };
  const observer = createObservationClient({
    address: snapshot.address,
    generation: () => generation,
    onDenied: () => {
      denials += 1;
      generation += 1;
    },
    onProjection: () => {},
    open: () => source(),
    retryDelayMs: 1,
  });
  observer.attach();
  await waitFor(() => denials === 1 && closes === 1);
  await delay(25);
  assert.equal(observer.getProjection(), null);
  assert.equal(opens, 1);
  observer.dispose();
});

test("frames from another generation or conversation never reach the projection", async () => {
  const errors: string[] = [];
  const projections: number[] = [];
  const source = async function* source() {
    yield frame("stale", 1);
    yield frame();
    yield decodeObservation({
      ...frame("other"),
      address: { ...snapshot.address, conversationId: "conversation-2" },
    });
  };
  const observer = createObservationClient({
    address: snapshot.address,
    generation: () => 0,
    onDenied: () => assert.fail("Unexpected denial"),
    onError: (error) => errors.push(error.message),
    onProjection: (projection) => {
      projections.push(projection?.snapshot.revision ?? -1);
    },
    open: () => source(),
    retryDelayMs: 1,
  });
  try {
    observer.attach();
    await waitFor(() => errors.length >= 1);
    assert.match(errors[0] ?? "", /different conversation/u);
    assert.ok(projections.length >= 1);
    assert.ok(projections.every((revision) => revision === 0));
  } finally {
    observer.dispose();
  }
});

test("EOF and sequence gaps reconnect from a fresh snapshot", async () => {
  let opens = 0;
  const observer = createObservationClient({
    address: snapshot.address,
    generation: () => 0,
    onDenied: () => assert.fail("Unexpected denial"),
    onError: () => {},
    onProjection: () => {},
    open: (_generation, signal) =>
      (async function* observe() {
        opens += 1;
        if (opens === 1) {
          yield frame("eof");
          return;
        }
        if (opens === 2) {
          yield frame("gap");
          yield update(2, 1, { output, type: "canonical-output" }, "gap");
          return;
        }
        yield frame(
          "repaired",
          0,
          Schema.decodeUnknownSync(DomainSnapshot)({
            ...snapshot,
            outputs: [output],
            revision: 1,
          })
        );
        await openUntilAbort(signal);
      })(),
    retryDelayMs: 1,
  });
  try {
    observer.attach();
    await waitFor(
      () =>
        opens === 3 && observer.getProjection()?.snapshot.outputs.length === 1
    );
    assert.equal(
      projectionMessages(observer.getProjection()).filter(
        (message) => message.role === "assistant"
      ).length,
      1
    );
  } finally {
    observer.dispose();
  }
});

test("detaching releases the open attachment and a reattach starts over", async () => {
  let opens = 0;
  let closes = 0;
  const statuses: string[] = [];
  const observer = createObservationClient({
    address: snapshot.address,
    generation: () => 0,
    onDenied: () => assert.fail("Unexpected denial"),
    onProjection: () => {},
    onStatus: (status) => statuses.push(status),
    open: (_generation, signal) =>
      (async function* observe() {
        opens += 1;
        try {
          yield frame(`epoch-${opens}`);
          await openUntilAbort(signal);
        } finally {
          closes += 1;
        }
      })(),
    retryDelayMs: 1,
  });
  observer.attach();
  await waitFor(() => statuses.includes("connected"));
  observer.detach();
  await waitFor(() => closes === 1);
  observer.attach();
  await waitFor(() => opens === 2 && closes === 1);
  observer.dispose();
  await waitFor(() => closes === 2);
  assert.deepEqual(statuses.slice(0, 3), [
    "connecting",
    "connected",
    "disconnected",
  ]);
});
