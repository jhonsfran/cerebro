/* oxlint-disable no-await-in-loop -- Observation tests wait for serial lifecycle transitions. */
import { test } from "bun:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { Effect, Stream, Schema } from "effect";

import { createObservationClient } from "../../packages/ag-ui/src/client.ts";
import {
  projectObservation,
  projectionMessages,
} from "../../packages/ag-ui/src/projection.ts";
import {
  createObservationGuard,
  createProtocolProjection,
  decodeCustomObservation,
  decodeObservation,
  observationEvent,
  observationIterable,
  observationResponse,
  ResnapshotRequiredError,
} from "../../packages/ag-ui/src/protocol.ts";
import { Denied } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import { DomainSnapshot } from "../../packages/contracts/src/session-service.ts";
import type { Observation } from "../../packages/contracts/src/session-service.ts";
import {
  allowedContext,
  userEvent,
} from "../../packages/contracts/src/testing/fixtures.ts";
import { createSessionFake } from "../../packages/contracts/src/testing/session-fakes.ts";

const snapshot = Schema.decodeUnknownSync(DomainSnapshot)({
  address: {
    agentId: "agent-1",
    conversationId: "conversation-1",
    organizationId: "organization-1",
    sessionId: "session-1",
  },
  agentVersion: 1,
  approvals: [],
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
  state = snapshot
): Observation =>
  decodeObservation({
    accessGeneration: generation,
    address: snapshot.address,
    epoch,
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
const output = {
  citations: [
    {
      observedAt: 1,
      sourceId: "source-1",
      sourceUri: "https://fixture.invalid/source",
      sourceVersion: "1",
    },
  ],
  dependencies: { sourceIds: ["source-1"], toolIds: [] },
  runId: "run-1",
  text: "Canonical answer",
};
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
  expiresAt: Date.now() + 60_000,
  operationId: "operation-1",
  runId: "run-1",
  state: "pending",
};
const waitFor = async (predicate: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }
  assert.fail("Observation lifecycle did not settle.");
};
const readOptions = () => ({ deadlineAt: Date.now() + 60_000 });
const effectOptions = () => ({
  ...readOptions(),
  operationId: id.operation("command-1"),
  requestDigest: id.digest("digest-1"),
});

// A real frozen SessionService fake feeds the same scoped adapter as the backend.
const fakeSource = (state = snapshot, frames: readonly Observation[] = []) => {
  const fake = createSessionFake(state, frames);
  const counts = { closes: 0, observers: 0, opens: 0 };
  const open = (generation: number, signal: AbortSignal) => {
    counts.opens += 1;
    const epoch = `fixture-${counts.opens}`;
    return (async function* observe() {
      counts.observers += 1;
      try {
        const source = fake.service.stream(
          state.address,
          allowedContext,
          { accessGeneration: generation },
          readOptions()
        );
        for await (const value of observationIterable(source)) {
          yield { ...value, accessGeneration: generation, epoch };
        }
        if (!signal.aborted) {
          const end = Promise.withResolvers<null>();
          signal.addEventListener("abort", () => end.resolve(null), {
            once: true,
          });
          await end.promise;
        }
      } finally {
        counts.observers -= 1;
        counts.closes += 1;
      }
    })();
  };
  return { counts, fake, open };
};

test("domain and custom schemas reject partial snapshots and mismatched custom names", () => {
  const incomplete = { ...snapshot, tools: undefined };
  assert.throws(() => frame("epoch", 0, incomplete));
  const event = observationEvent(frame());
  assert.equal(event.type, "CUSTOM");
  assert.deepEqual(
    decodeCustomObservation({ name: "cerebro.snapshot", value: frame() }),
    frame()
  );
  assert.throws(() =>
    decodeCustomObservation({ name: "cerebro.approval", value: frame() })
  );
});

test("guard rejects stale identities, generations, epochs and duplicate frames", () => {
  const guard = createObservationGuard(snapshot.address, 2);
  assert.equal(guard(frame("old", 1)), undefined);
  assert.ok(guard(frame("one", 2)));
  const early = update(
    1,
    0,
    { runId: "run-1", text: "early", type: "provisional-text" },
    "one",
    2
  );
  assert.ok(guard(early));
  assert.equal(guard(early), undefined);
  assert.ok(guard(frame("two", 2)));
  assert.equal(
    guard(
      update(
        2,
        0,
        { runId: "run-1", text: "late", type: "provisional-text" },
        "one",
        2
      )
    ),
    undefined
  );
  assert.equal(
    guard({
      ...frame("three", 2),
      address: { ...snapshot.address, organizationId: "other" },
    }),
    undefined
  );
});

test("sequence and committed revision gaps require a canonical resnapshot", () => {
  const guard = createObservationGuard(snapshot.address, 0);
  guard(frame());
  assert.throws(
    () =>
      guard(
        update(2, 0, { runId: "run-1", text: "gap", type: "provisional-text" })
      ),
    ResnapshotRequiredError
  );
  const revisions = createObservationGuard(snapshot.address, 0);
  revisions(frame());
  assert.throws(
    () =>
      revisions(
        update(1, 2, { run: { runId: "run-1", state: "running" }, type: "run" })
      ),
    ResnapshotRequiredError
  );
});

test("snapshot replacement clears empty collections and canonical output replaces provisional text", () => {
  let projection = projectObservation(null, frame());
  projection = projectObservation(
    projection,
    update(1, 0, {
      runId: "run-1",
      text: "Early draft",
      type: "provisional-text",
    })
  );
  assert.equal(projectionMessages(projection).at(-1)?.parts[0]?.type, "text");
  projection = projectObservation(
    projection,
    update(2, 1, { output, type: "canonical-output" })
  );
  assert.equal(
    JSON.stringify(projectionMessages(projection)).includes("Early draft"),
    false
  );
  assert.equal(
    projectionMessages(projection).filter(
      (message) => message.role === "assistant"
    ).length,
    1
  );
  projection = projectObservation(
    projection,
    frame("reconnect", 0, { ...snapshot, runs: [], userMessages: [] })
  );
  assert.deepEqual(projectionMessages(projection), []);
  assert.deepEqual(projection?.snapshot.approvals, []);
});

test("shared run identity projects one answer for joined steering operations", () => {
  const projection = projectObservation(
    null,
    frame("joined", 0, {
      ...snapshot,
      outputs: Schema.decodeUnknownSync(DomainSnapshot)({
        ...snapshot,
        outputs: [output],
      }).outputs,
      userMessages: [
        ...snapshot.userMessages,
        {
          eventId: id.event("steer-event"),
          mode: "steer",
          occurredAt: 1,
          runId: id.run("run-1"),
          text: "Steering",
        },
      ],
    })
  );
  assert.equal(
    projectionMessages(projection).filter((message) => message.role === "user")
      .length,
    2
  );
  assert.equal(
    projectionMessages(projection).filter(
      (message) => message.role === "assistant"
    ).length,
    1
  );
});

test("tools and approvals upsert by occurrence identity and retain arguments, output and expiry", () => {
  let projection = projectObservation(null, frame());
  projection = projectObservation(
    projection,
    update(1, 1, { ...tool, type: "tool" })
  );
  projection = projectObservation(
    projection,
    update(2, 2, { ...tool, operationId: "operation-2", type: "tool" })
  );
  projection = projectObservation(
    projection,
    update(3, 3, {
      ...tool,
      output: { saved: true },
      state: "succeeded",
      type: "tool",
    })
  );
  projection = projectObservation(
    projection,
    update(4, 4, { ...approval, type: "approval" })
  );
  projection = projectObservation(
    projection,
    update(5, 5, { ...approval, state: "allowed", type: "approval" })
  );
  assert.equal(projection?.snapshot.tools.length, 2);
  assert.deepEqual(projection?.snapshot.tools[0]?.output, { saved: true });
  assert.equal(projection?.snapshot.approvals.length, 1);
  assert.equal(projection?.snapshot.approvals[0]?.state, "allowed");
});

test("protocol maps text and tool semantics to standard AG-UI events and approvals to custom events", () => {
  const project = createProtocolProjection();
  project(frame());
  assert.deepEqual(
    project(
      update(1, 0, { runId: "run-1", text: "Early", type: "provisional-text" })
    ).map((event) => event.type),
    ["CUSTOM", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"]
  );
  const events = project(update(2, 1, { ...tool, type: "tool" }));
  assert.deepEqual(
    events.map((event) => event.type),
    ["CUSTOM", "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"]
  );
  assert.deepEqual(
    project(update(3, 2, { ...approval, type: "approval" })).map(
      (event) => event.type
    ),
    ["CUSTOM"]
  );
});

test("Effect stream conversion releases observer scope without cancelling durable work", async () => {
  let releases = 0;
  const source = Stream.concat(
    Stream.fromEffect(
      Effect.acquireRelease(Effect.succeed(frame()), () =>
        Effect.sync(() => {
          releases += 1;
        })
      )
    ),
    Stream.never
  );
  const iterator = observationIterable(source)[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.return?.();
  assert.equal(releases, 1);
  const response = observationResponse(Stream.succeed(frame()));
  assert.equal(response.headers.get("Content-Type"), "application/x-ndjson");
  const body = await response.text();
  assert.deepEqual(JSON.parse(body.trim()), frame());
});

test("page load, approval from another observer, detach and reattach call zero submissions", async () => {
  const frames = [
    update(1, 0, { runId: "run-1", text: "Early", type: "provisional-text" }),
    update(2, 1, { ...approval, type: "approval" }),
    update(3, 2, { ...approval, state: "allowed", type: "approval" }),
    update(4, 3, { output, type: "canonical-output" }),
  ];
  const source = fakeSource(snapshot, frames);
  const observer = createObservationClient({
    address: snapshot.address,
    generation: () => 0,
    onDenied: () => assert.fail("Unexpected denial"),
    onProjection: () => {},
    open: source.open,
  });
  try {
    assert.equal(source.counts.opens, 0);
    observer.attach();
    await waitFor(
      () => observer.getProjection()?.snapshot.outputs.length === 1
    );
    assert.ok(
      JSON.stringify(observer.client.getMessages()).includes("Canonical answer")
    );
    assert.equal(source.fake.counts.submit, 0);
    observer.detach();
    await waitFor(() => source.counts.observers === 0);
    observer.attach();
    await waitFor(
      () => source.counts.opens === 2 && source.counts.observers === 1
    );
    assert.equal(source.fake.counts.submit, 0);
    assert.equal(source.counts.closes, 1);
    await assert.rejects(
      observer.connection.connect([])[Symbol.asyncIterator]().next(),
      /Cerebro commands/u
    );
  } finally {
    observer.detach();
    observer.dispose();
  }
});

test("denial clears protected state, rejects delayed frames and stops reconnect", async () => {
  let generation = 0;
  let denials = 0;
  const denial = decodeObservation({
    accessGeneration: 0,
    address: snapshot.address,
    epoch: "epoch-1",
    reason: "revoked",
    schemaVersion: 1,
    sequence: 2,
    type: "access-denied",
  });
  const source = fakeSource(snapshot, [
    update(1, 0, { runId: "run-1", text: "Private", type: "provisional-text" }),
    denial,
    update(3, 1, { output, type: "canonical-output" }),
  ]);
  const observer = createObservationClient({
    address: snapshot.address,
    generation: () => generation,
    onDenied: () => {
      denials += 1;
      generation += 1;
    },
    onProjection: () => {},
    open: source.open,
    retryDelayMs: 1,
  });
  observer.attach();
  await waitFor(() => denials === 1);
  await waitFor(() => source.counts.observers === 0);
  await delay(25);
  assert.equal(observer.getProjection(), null);
  assert.deepEqual(observer.client.getMessages(), []);
  assert.equal(source.counts.opens, 1);
  assert.equal(source.fake.counts.submit, 0);
  observer.dispose();
});

test("normal EOF and sequence gaps reconnect with canonical state and no submit", async () => {
  const fake = createSessionFake(snapshot);
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
        const end = Promise.withResolvers<null>();
        signal.addEventListener("abort", () => end.resolve(null), {
          once: true,
        });
        await end.promise;
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
    assert.equal(fake.counts.submit, 0);
  } finally {
    observer.detach();
    observer.dispose();
  }
});

test("frozen fake command retries preserve submission mode and stable request IDs", async () => {
  const fake = createSessionFake(snapshot);
  const command = { event: userEvent, mode: "steer", type: "submit" } as const;
  const first = await Effect.runPromise(
    fake.service.submit(command, effectOptions())
  );
  const repeat = await Effect.runPromise(
    fake.service.submit(command, effectOptions())
  );
  assert.equal(first.runId, repeat.runId);
  assert.equal(repeat.replayed, true);
  assert.equal(fake.counts.submit, 1);
  await assert.rejects(
    Effect.runPromise(
      fake.service.submit({ ...command, mode: "replace" }, effectOptions())
    )
  );
});

test("completion delivered during hydration is observed on the same subscription", async () => {
  const source = fakeSource(snapshot, [
    update(1, 1, { output, type: "canonical-output" }),
    update(2, 2, {
      run: { completedAt: 1, runId: "run-1", state: "completed" },
      type: "run",
    }),
  ]);
  const observer = createObservationClient({
    address: snapshot.address,
    generation: () => 0,
    onDenied: () => assert.fail("Unexpected denial"),
    onProjection: () => {},
    open: source.open,
  });
  try {
    observer.attach();
    await waitFor(
      () => observer.getProjection()?.snapshot.runs[0]?.state === "completed"
    );
    assert.equal(source.counts.opens, 1);
    assert.equal(source.fake.counts.submit, 0);
    assert.equal(
      projectionMessages(observer.getProjection()).filter(
        (message) => message.role === "assistant"
      ).length,
      1
    );
  } finally {
    observer.detach();
    observer.dispose();
  }
});

test("a pre-snapshot typed denial clears existing protected state and does not retry", async () => {
  const source = fakeSource();
  source.fake.setAllowed(false);
  let denied = 0;
  const observer = createObservationClient({
    address: snapshot.address,
    generation: () => 0,
    onDenied: () => {
      denied += 1;
    },
    onProjection: () => {},
    open: source.open,
    retryDelayMs: 1,
  });
  observer.attach();
  await waitFor(() => denied === 1);
  await delay(20);
  assert.equal(source.counts.opens, 1);
  assert.equal(source.counts.observers, 0);
  assert.equal(source.fake.counts.submit, 0);
  assert.deepEqual(observer.client.getMessages(), []);
  observer.dispose();
});

test("transient hydration failure retries observation without a command", async () => {
  const source = fakeSource();
  let attempts = 0;
  const observer = createObservationClient({
    address: snapshot.address,
    generation: () => 0,
    onDenied: () => assert.fail("Unexpected denial"),
    onError: () => {},
    onProjection: () => {},
    open: (generation, signal) =>
      (async function* observe() {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("Fixture transport unavailable");
        }
        yield* source.open(generation, signal);
      })(),
    retryDelayMs: 1,
  });
  try {
    observer.attach();
    await waitFor(() => observer.getProjection() !== null);
    assert.equal(attempts, 2);
    assert.equal(source.fake.counts.submit, 0);
  } finally {
    observer.detach();
    observer.dispose();
  }
});

test("delayed old attachment frames cannot paint after rapid detach and reattach", async () => {
  const source = fakeSource();
  const late = Promise.withResolvers<null>();
  let attempts = 0;
  let oldWaiting = false;
  const seen: string[] = [];
  const observer = createObservationClient({
    address: snapshot.address,
    generation: () => 0,
    onDenied: () => assert.fail("Unexpected denial"),
    onProjection: (projection) => seen.push(JSON.stringify(projection)),
    open: (generation, signal) =>
      (async function* observe() {
        attempts += 1;
        if (attempts === 1) {
          yield frame("old-attachment");
          oldWaiting = true;
          await late.promise;
          yield update(
            1,
            0,
            {
              runId: "run-1",
              text: "STALE PRIVATE FRAME",
              type: "provisional-text",
            },
            "old-attachment"
          );
          return;
        }
        yield* source.open(generation, signal);
      })(),
  });
  try {
    observer.attach();
    await waitFor(() => oldWaiting);
    observer.detach();
    observer.attach();
    late.resolve(null);
    await waitFor(() => attempts === 2 && source.counts.observers === 1);
    assert.equal(
      seen.some((value) => value.includes("STALE PRIVATE FRAME")),
      false
    );
    assert.equal(source.fake.counts.submit, 0);
  } finally {
    observer.detach();
    observer.dispose();
  }
});

test("unknown outcomes remain a custom domain failure and never become a success event", () => {
  const project = createProtocolProjection();
  project(frame());
  const events = project(
    update(1, 1, {
      run: {
        operationId: "operation-1",
        runId: "run-1",
        state: "unknown-outcome",
      },
      type: "run",
    })
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["CUSTOM", "RUN_ERROR"]
  );
  assert.equal(
    events.some((event) => event.type === "RUN_FINISHED"),
    false
  );
});

test("detaching between the hydration snapshot and joining releases the observer", async () => {
  const source = fakeSource();
  let observer: ReturnType<typeof createObservationClient> | null = null;
  observer = createObservationClient({
    address: snapshot.address,
    generation: () => 0,
    onDenied: () => assert.fail("Unexpected denial"),
    onProjection: () => observer?.detach(),
    open: source.open,
  });
  observer.attach();
  await waitFor(
    () => source.counts.opens === 1 && source.counts.observers === 0
  );
  assert.equal(source.counts.closes, 1);
  assert.equal(source.fake.counts.submit, 0);
  observer.dispose();
});

test("canonical outputs render even when the snapshot contains no active run records", () => {
  const state = Schema.decodeUnknownSync(DomainSnapshot)({
    ...snapshot,
    outputs: [output],
    runs: [],
    userMessages: [],
  });
  const projection = projectObservation(null, frame("history", 0, state));
  assert.equal(projectionMessages(projection).length, 1);
  assert.ok(
    JSON.stringify(projectionMessages(projection)).includes("Canonical answer")
  );
});

const attachmentFailures = [
  {
    label: "HTTP 401",
    value: Object.assign(new Error("Unauthorized"), { status: 401 }),
  },
  {
    label: "HTTP 403",
    value: Object.assign(new Error("Forbidden"), { status: 403 }),
  },
  {
    label: "typed Denied",
    value: new Denied({ code: "revoked", reason: "Denied" }),
  },
  { label: "transport error", value: new Error("Transport failed") },
] as const;

for (const state of ["failed", "unknown-outcome"] as const) {
  test(`current ${state} observations still report domain errors`, async () => {
    const source = fakeSource(snapshot, [
      update(1, 1, {
        run: { endedAt: 1, operationId: "operation-1", runId: "run-1", state },
        type: "run",
      }),
    ]);
    const errors: Error[] = [];
    const observer = createObservationClient({
      address: snapshot.address,
      generation: () => 0,
      onDenied: () => assert.fail("Unexpected denial"),
      onError: (error) => errors.push(error),
      onProjection: () => {},
      open: source.open,
    });
    try {
      observer.attach();
      await waitFor(() => errors.length === 1);
      assert.equal(observer.getProjection()?.snapshot.runs[0]?.state, state);
      assert.match(
        errors[0]?.message ?? "",
        state === "failed" ? /Execution failed/u : /Reconciliation is required/u
      );
      assert.equal(source.fake.counts.submit, 0);
    } finally {
      observer.dispose();
    }
  });
}

for (const retirement of ["reattach", "dispose", "generation"] as const) {
  for (const failure of attachmentFailures) {
    test(`iterator cleanup ${failure.label} after ${retirement} cannot affect current observation`, async () => {
      const source = fakeSource();
      const releaseRead = Promise.withResolvers<null>();
      const releaseCleanup = Promise.withResolvers<null>();
      const cleanupSettled = Promise.withResolvers<null>();
      const effects: string[] = [];
      let generation = 0;
      let attempts = 0;
      let waiting = false;
      let cleanupStarted = false;
      let sentSnapshot = false;
      const iterator: AsyncIterator<unknown> = {
        next: async () => {
          if (!sentSnapshot) {
            sentSnapshot = true;
            return { done: false, value: frame("retired") };
          }
          waiting = true;
          await releaseRead.promise;
          return { done: true, value: undefined };
        },
        return: async () => {
          cleanupStarted = true;
          try {
            await releaseCleanup.promise;
            throw failure.value;
          } finally {
            cleanupSettled.resolve(null);
          }
        },
      };
      const observer = createObservationClient({
        address: snapshot.address,
        generation: () => generation,
        onDenied: () => effects.push("denied"),
        onError: () => effects.push("error"),
        onProjection: () => effects.push("projection"),
        onStatus: (status) => effects.push(status),
        open: (accessGeneration, signal) => {
          attempts += 1;
          return attempts === 1
            ? { [Symbol.asyncIterator]: () => iterator }
            : source.open(accessGeneration, signal);
        },
      });
      try {
        observer.attach();
        await waitFor(() => waiting);
        if (retirement === "generation") {
          generation += 1;
        } else if (retirement === "dispose") {
          observer.dispose();
        } else {
          observer.detach();
          observer.attach();
          await waitFor(() => source.counts.observers === 1);
        }
        effects.length = 0;
        releaseRead.resolve(null);
        await waitFor(() => cleanupStarted);
        releaseCleanup.resolve(null);
        await cleanupSettled.promise;
        await delay(20);
        assert.deepEqual(effects, []);
        assert.equal(observer.client.getError(), undefined);
        if (retirement === "reattach") {
          assert.equal(source.counts.observers, 1);
          assert.deepEqual(observer.getProjection()?.snapshot, snapshot);
        } else if (retirement === "dispose") {
          observer.attach();
          assert.equal(attempts, 1);
        }
        assert.equal(source.fake.counts.submit, 0);
      } finally {
        releaseRead.resolve(null);
        releaseCleanup.resolve(null);
        observer.dispose();
      }
    });
  }
}

for (const stage of ["snapshot", "tail"] as const) {
  for (const retirement of ["reattach", "dispose", "generation"] as const) {
    for (const failure of attachmentFailures) {
      test(`${stage} ${failure.label} after ${retirement} cannot affect current observation`, async () => {
        const source = fakeSource();
        const release = Promise.withResolvers<null>();
        const settled = Promise.withResolvers<null>();
        const effects: string[] = [];
        let generation = 0;
        let attempts = 0;
        let waiting = false;
        const observer = createObservationClient({
          address: snapshot.address,
          generation: () => generation,
          onDenied: () => effects.push("denied"),
          onError: () => effects.push("error"),
          onProjection: () => effects.push("projection"),
          onStatus: (status) => effects.push(status),
          open: (accessGeneration, signal) =>
            (async function* observe() {
              attempts += 1;
              if (attempts > 1) {
                yield* source.open(accessGeneration, signal);
                return;
              }
              try {
                if (stage === "tail") {
                  yield frame("retired", accessGeneration);
                }
                waiting = true;
                await release.promise;
                throw failure.value;
              } finally {
                settled.resolve(null);
              }
            })(),
          retryDelayMs: 1,
        });
        try {
          observer.attach();
          await waitFor(() => waiting);
          if (retirement === "generation") {
            generation += 1;
          } else if (retirement === "dispose") {
            observer.dispose();
          } else {
            observer.detach();
            observer.attach();
            await waitFor(() => source.counts.observers === 1);
          }
          effects.length = 0;
          release.resolve(null);
          await settled.promise;
          await delay(20);
          assert.equal(effects.includes("denied"), false);
          assert.equal(effects.includes("error"), false);
          assert.equal(observer.client.getError(), undefined);
          if (retirement !== "reattach") {
            assert.deepEqual(effects, []);
          }
          if (retirement === "generation") {
            observer.detach();
            observer.attach();
          }
          if (retirement !== "dispose") {
            await waitFor(() => source.counts.observers === 1);
            assert.deepEqual(observer.getProjection()?.snapshot, snapshot);
            assert.equal(attempts, 2);
          }
          assert.equal(source.fake.counts.submit, 0);
        } finally {
          release.resolve(null);
          observer.dispose();
        }
      });
    }
  }
  for (const failure of attachmentFailures.slice(0, 3)) {
    test(`current ${stage} ${failure.label} still clears protected state and stops retrying`, async () => {
      const source = fakeSource();
      let denials = 0;
      let attempts = 0;
      const observer = createObservationClient({
        address: snapshot.address,
        generation: () => 0,
        onDenied: () => {
          denials += 1;
        },
        onProjection: () => {},
        open: (generation) =>
          (async function* observe() {
            attempts += 1;
            if (stage === "tail") {
              yield frame("current", generation);
            }
            throw failure.value;
          })(),
        retryDelayMs: 1,
      });
      try {
        observer.attach();
        await waitFor(() => denials === 1);
        await delay(20);
        assert.equal(observer.getProjection(), null);
        assert.deepEqual(observer.client.getMessages(), []);
        assert.equal(attempts, 1);
        assert.equal(denials, 1);
        assert.equal(source.fake.counts.submit, 0);
      } finally {
        observer.dispose();
      }
    });
  }
}
