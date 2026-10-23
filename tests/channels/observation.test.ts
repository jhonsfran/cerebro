/* oxlint-disable no-await-in-loop -- Observation tests wait for serial lifecycle transitions. */
import { test } from "bun:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { Schema } from "effect";

import {
  createObservationClient,
  decodeObservation,
  ObservationProtocolError,
} from "../../apps/web/src/features/product/observation";
import { ChatSnapshot } from "../../packages/contracts/src/session-service.ts";

const snapshot = Schema.decodeUnknownSync(ChatSnapshot)({
  address: {
    agentId: "agent-1",
    conversationId: "conversation-1",
    organizationId: "organization-1",
    sessionId: "session-1",
  },
  agentVersion: 1,
  queuedInputs: [],
  tools: [],
  approvals: [],
  busy: true,
  messages: [
    { id: "native-entry-1", role: "user", state: "complete", text: "Question" },
    {
      id: "partial:native-task-1",
      role: "assistant",
      state: "streaming",
      text: "Answer so far",
      thinking: "Thinking so far",
    },
  ],
});

const frame = (value = snapshot) =>
  decodeObservation({ snapshot: value, type: "snapshot" });
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
  if (signal.aborted) {
    end.resolve(null);
  } else {
    signal.addEventListener("abort", () => end.resolve(null), { once: true });
  }
  return end.promise;
};

test("each native snapshot replaces the full view and keeps native message order", async () => {
  const restored = Schema.decodeUnknownSync(ChatSnapshot)({
    ...snapshot,
    busy: false,
    messages: [
      {
        id: "native-entry-2",
        role: "assistant",
        state: "complete",
        text: "Completed answer",
      },
      {
        id: "native-entry-1",
        role: "user",
        state: "complete",
        text: "Question",
      },
    ],
  });
  const views: string[][] = [];
  const observer = createObservationClient({
    address: snapshot.address,
    generation: () => 0,
    onDenied: () => assert.fail("Unexpected denial"),
    onSnapshot: (value) =>
      views.push(value?.messages.map((message) => message.id) ?? []),
    open: (_generation, signal) =>
      (async function* observe() {
        yield frame();
        yield frame(restored);
        yield frame({ ...snapshot, busy: false, messages: [] });
        await openUntilAbort(signal);
      })(),
  });
  try {
    observer.attach();
    await waitFor(() => views.length === 3);
    assert.deepEqual(views, [
      ["native-entry-1", "partial:native-task-1"],
      ["native-entry-2", "native-entry-1"],
      [],
    ]);
    assert.deepEqual(observer.getSnapshot()?.messages, []);
  } finally {
    observer.dispose();
  }
});

test("a full snapshot restores native thinking, tool output, and pending approval", async () => {
  const restored = Schema.decodeUnknownSync(ChatSnapshot)({
    ...snapshot,
    approvals: [
      {
        approvalId: "approval-1",
        arguments: { ticket: "ticket-1" },
        callId: "native-call-1",
        expiresAt: 60_000,
        operationId: "operation-1",
        state: "pending",
        taskId: "native-task-1",
        toolId: "write-ticket",
      },
    ],
    messages: [
      ...snapshot.messages,
      {
        id: "native-entry-3",
        role: "tool",
        state: "complete",
        text: "Tool output",
        toolName: "read-policy",
      },
    ],
  });
  const observer = createObservationClient({
    address: snapshot.address,
    generation: () => 0,
    onDenied: () => assert.fail("Unexpected denial"),
    onSnapshot: () => {},
    open: (_generation, signal) =>
      (async function* observe() {
        yield frame(restored);
        await openUntilAbort(signal);
      })(),
  });
  try {
    observer.attach();
    await waitFor(() => observer.getSnapshot() !== null);
    assert.deepEqual(observer.getSnapshot(), restored);
  } finally {
    observer.dispose();
  }
});

test("denial clears protected state, ignores later frames, and stops reconnect", async () => {
  let generation = 0;
  let denials = 0;
  let opens = 0;
  let closes = 0;
  const views: (ChatSnapshot | null)[] = [];
  const source = async function* source() {
    opens += 1;
    try {
      yield frame();
      yield decodeObservation({ reason: "revoked", type: "access-denied" });
      yield frame({ ...snapshot, messages: [] });
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
    onSnapshot: (value) => views.push(value),
    open: source,
    retryDelayMs: 1,
  });
  observer.attach();
  await waitFor(() => denials === 1 && closes === 1);
  await delay(25);
  assert.equal(observer.getSnapshot(), null);
  assert.deepEqual(views, [snapshot, null]);
  assert.equal(opens, 1);
  observer.dispose();
});

test("a snapshot for another conversation never replaces the protected view", async () => {
  const errors: string[] = [];
  const source = async function* source() {
    yield decodeObservation({
      snapshot: {
        ...snapshot,
        address: { ...snapshot.address, conversationId: "conversation-2" },
      },
      type: "snapshot",
    });
  };
  const observer = createObservationClient({
    address: snapshot.address,
    generation: () => 0,
    onDenied: () => assert.fail("Unexpected denial"),
    onError: (error) => errors.push(error.message),
    onSnapshot: () => assert.fail("Unexpected snapshot"),
    open: source,
    retryDelayMs: 1,
  });
  try {
    observer.attach();
    await waitFor(() => errors.length > 0);
    assert.match(errors[0] ?? "", /different conversation/u);
    assert.equal(observer.getSnapshot(), null);
  } finally {
    observer.dispose();
  }
});

test("EOF reconnects from a fresh full snapshot without submitting work", async () => {
  let opens = 0;
  const fresh = { ...snapshot, busy: false, messages: [] };
  const observer = createObservationClient({
    address: snapshot.address,
    generation: () => 0,
    onDenied: () => assert.fail("Unexpected denial"),
    onSnapshot: () => {},
    open: (_generation, signal) =>
      (async function* observe() {
        opens += 1;
        if (opens === 1) {
          yield frame();
          return;
        }
        yield frame(fresh);
        await openUntilAbort(signal);
      })(),
    retryDelayMs: 1,
  });
  try {
    observer.attach();
    await waitFor(
      () => opens === 2 && observer.getSnapshot()?.messages.length === 0
    );
    assert.deepEqual(observer.getSnapshot(), fresh);
  } finally {
    observer.dispose();
  }
});

test("detaching releases the attachment and reattach requests a fresh snapshot", async () => {
  let opens = 0;
  let closes = 0;
  const statuses: string[] = [];
  const observer = createObservationClient({
    address: snapshot.address,
    generation: () => 0,
    onDenied: () => assert.fail("Unexpected denial"),
    onSnapshot: () => {},
    onStatus: (status) => statuses.push(status),
    open: (_generation, signal) =>
      (async function* observe() {
        opens += 1;
        try {
          yield frame();
          await openUntilAbort(signal);
        } finally {
          closes += 1;
        }
      })(),
  });
  observer.attach();
  await waitFor(() => statuses.includes("connected"));
  observer.detach();
  await waitFor(() => closes === 1);
  observer.attach();
  await waitFor(() => opens === 2);
  observer.dispose();
  await waitFor(() => closes === 2);
  assert.deepEqual(statuses.slice(0, 3), [
    "connecting",
    "connected",
    "disconnected",
  ]);
});

for (const failure of ["schema", "address", "limit"] as const) {
  test(`${failure} faults stop observation until explicit reconnect`, async () => {
    let opens = 0;
    const statuses: string[] = [];
    const errors: string[] = [];
    const observer = createObservationClient({
      address: snapshot.address,
      generation: () => 0,
      onDenied: () => assert.fail("Unexpected denial"),
      onError: (error) => errors.push(error.message),
      onSnapshot: () => {},
      onStatus: (status) => statuses.push(status),
      open: (_generation, signal) =>
        (async function* source() {
          opens += 1;
          yield frame();
          if (opens === 1) {
            if (failure === "schema") {
              yield { snapshot: {}, type: "snapshot" };
            } else if (failure === "address") {
              yield frame({
                ...snapshot,
                address: {
                  ...snapshot.address,
                  conversationId: "another-conversation",
                },
              });
            } else {
              throw new ObservationProtocolError(
                "Observation frame exceeds the transport limit."
              );
            }
            return;
          }
          await openUntilAbort(signal);
        })(),
      retryDelayMs: 1,
    });
    try {
      observer.attach();
      await waitFor(() => statuses.at(-1) === "failed");
      await delay(20);
      assert.equal(opens, 1);
      assert.equal(errors.length, 1);
      assert.deepEqual(observer.getSnapshot(), snapshot);
      assert.deepEqual(statuses, ["connecting", "connected", "failed"]);
      observer.attach();
      await waitFor(() => opens === 2 && statuses.at(-1) === "connected");
      assert.deepEqual(observer.getSnapshot(), snapshot);
    } finally {
      observer.dispose();
    }
  });
}

test("an interrupted frame retries and restores a fresh snapshot", async () => {
  let opens = 0;
  const fresh = { ...snapshot, busy: false, messages: [] };
  const errors: string[] = [];
  const observer = createObservationClient({
    address: snapshot.address,
    generation: () => 0,
    onDenied: () => assert.fail("Unexpected denial"),
    onError: (error) => errors.push(error.message),
    onSnapshot: () => {},
    open: (_generation, signal) =>
      (async function* source() {
        opens += 1;
        if (opens === 1) {
          yield frame();
          throw new Error("Observation ended inside a frame.");
        }
        yield frame(fresh);
        await openUntilAbort(signal);
      })(),
    retryDelayMs: 1,
  });
  try {
    observer.attach();
    await waitFor(() => opens === 2);
    assert.deepEqual(observer.getSnapshot(), fresh);
    assert.deepEqual(errors, ["Observation ended inside a frame."]);
  } finally {
    observer.dispose();
  }
});
