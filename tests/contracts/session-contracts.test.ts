/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Serial binding mutations are asserted at their await point. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect, Result, Schema } from "effect";

import {
  AuthorityService,
  enforceDecision,
} from "../../packages/contracts/src/authority-service.ts";
import type { AuthorityRequest } from "../../packages/contracts/src/authority-service.ts";
import type { HandoffTransition } from "../../packages/contracts/src/execution.ts";
import {
  Denied,
  failureToHttp,
  UnknownOutcome,
} from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import {
  DomainSnapshot,
  DomainUpdate,
  Observation,
} from "../../packages/contracts/src/session-service.ts";
import {
  createAuthorityFake,
  createToolFake,
} from "../../packages/contracts/src/testing/effect-fakes.ts";
import {
  allowedContext,
  allowedUser,
  unknownOutcomeInvocation,
  unknownOutcomeCapability,
  userEvent,
} from "../../packages/contracts/src/testing/fixtures.ts";
import {
  boundApprovalMatches,
  connectorFingerprint,
} from "../../packages/contracts/src/tool-service.ts";
import type {
  BoundApproval,
  BoundInvocation,
} from "../../packages/contracts/src/tool-service.ts";

const now = 1_800_000_000_000;
const invocation: BoundInvocation = {
  ...unknownOutcomeInvocation,
  runId: id.run("run-A"),
  state: "requested",
  tool: {
    ...unknownOutcomeInvocation.tool,
    connectorFingerprint: id.digest("sha256:registration"),
  },
};
const options = {
  deadlineAt: now + 1000,
  operationId: invocation.operationId,
  requestDigest: invocation.argumentDigest,
};
const approval: BoundApproval = {
  actorPrincipalId: allowedUser.id,
  agentId: invocation.agentId,
  approverId: allowedUser.id,
  argumentDigest: invocation.argumentDigest,
  connectorFingerprint: invocation.tool.connectorFingerprint,
  connectorId: invocation.tool.connectorId,
  effect: "write",
  expiresAt: now + 1000,
  id: "approval-A",
  operationId: invocation.operationId,
  organizationId: invocation.organizationId,
  policyVersion: "fixture-v1",
  principalId: allowedUser.id,
  runId: invocation.runId,
  toolId: invocation.tool.id,
  toolVersion: invocation.tool.version,
};
const authorityRequest: AuthorityRequest = {
  action: "execute",
  address: userEvent,
  context: allowedContext,
  pinnedAgent: {
    agentId: userEvent.agentId,
    enabledToolIds: [invocation.tool.id],
    grants: [],
    instructions: "fixture",
    model: "fixture",
    organizationId: userEvent.organizationId,
    version: 1,
  },
  resource: {
    id: invocation.tool.id,
    kind: "tool",
    organizationId: userEvent.organizationId,
  },
  tool: invocation.tool,
};
const failureTag = async <E>(effect: Effect.Effect<unknown, E>) => {
  const result = await Effect.runPromise(Effect.result(effect));
  assert.ok(Result.isFailure(result));
  return result.failure;
};

test("Effect 4 service keys resolve through the proposed fake Layer", async () => {
  const fake = createAuthorityFake(() => now);
  const permit = await Effect.runPromise(
    Effect.gen(function* requireAuthority() {
      const authority = yield* AuthorityService;
      return yield* authority.require(authorityRequest, options);
    }).pipe(Effect.provide(fake.layer))
  );
  assert.equal(permit.policyVersion, "fixture-v1");
});

test("policy denial remains data and unavailable enforcement fails closed", async () => {
  const fake = createAuthorityFake(() => now);
  fake.setDecision({
    decision: "deny",
    policyVersion: "fixture-v1",
    reason: "revoked",
  });
  assert.equal(
    (await Effect.runPromise(fake.service.evaluate(authorityRequest, options)))
      .decision,
    "deny"
  );
  assert.ok(
    (await failureTag(
      fake.service.require(authorityRequest, options)
    )) instanceof Denied
  );
  fake.setAvailable(false);
  assert.equal(
    (await failureTag(fake.service.require(authorityRequest, options)))._tag,
    "Unavailable"
  );
  assert.ok(
    (await failureTag(
      enforceDecision(authorityRequest, now, {
        decision: "deny",
        policyVersion: "p1",
        reason: "denied",
      })
    )) instanceof Denied
  );
});
test("approvals bind run, registration version and destination, arguments, identity, policy and expiry", async () => {
  assert.equal(
    await Effect.runPromise(
      boundApprovalMatches(approval, invocation, "fixture-v1", now)
    ),
    true
  );
  for (const changed of [
    { runId: id.run("run-B") },
    { connectorFingerprint: id.digest("sha256:other") },
    { argumentDigest: id.digest("sha256:other") },
    { actorPrincipalId: id.principal("other") },
    { principalId: id.principal("other") },
    { organizationId: id.organization("other") },
    { operationId: id.operation("other") },
    { toolVersion: "2" },
    { expiresAt: now },
    { policyVersion: "revoked" },
  ]) {
    assert.equal(
      await Effect.runPromise(
        boundApprovalMatches(
          { ...approval, ...changed },
          invocation,
          "fixture-v1",
          now
        )
      ),
      false
    );
  }
  const original = await Effect.runPromise(
    connectorFingerprint({
      connectorId: "c",
      destination: "https://fixture/a",
      version: "1",
    })
  );
  assert.notEqual(
    original,
    await Effect.runPromise(
      connectorFingerprint({
        connectorId: "c",
        destination: "https://fixture/a",
        version: "2",
      })
    )
  );
  assert.notEqual(
    original,
    await Effect.runPromise(
      connectorFingerprint({
        connectorId: "c",
        destination: "https://fixture/b",
        version: "1",
      })
    )
  );
});
test("a denied capability causes zero fake dispatches", async () => {
  const fake = createToolFake(() => now);
  const capability = {
    ...unknownOutcomeCapability,
    connectorFingerprint: invocation.tool.connectorFingerprint,
    expiresAt: now + 1000,
    policyVersion: "fixture-v1",
    runId: invocation.runId,
  };
  fake.setAllowed(false);
  assert.ok(
    (await failureTag(
      fake.service.execute(invocation, capability, options)
    )) instanceof Denied
  );
  assert.equal(fake.counts.dispatch, 0);
});
test("denial frames validate and HTTP conversion preserves unknown-outcome meaning", () => {
  const denial = {
    accessGeneration: 2,
    address: userEvent,
    epoch: "epoch-A",
    reason: "revoked",
    schemaVersion: 1,
    sequence: 0,
    type: "access-denied",
  };
  assert.equal(
    Schema.decodeUnknownSync(Observation)(denial).type,
    "access-denied"
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(Observation)({ ...denial, accessGeneration: -1 })
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(Observation)({ ...denial, reason: "EOF" })
  );
  assert.equal(
    failureToHttp(new Denied({ code: "revoked", reason: "revoked" })).status,
    403
  );
  assert.deepEqual(
    failureToHttp(
      new UnknownOutcome({
        operationId: invocation.operationId,
        reason: "uncertain write",
      })
    ),
    {
      body: { error: "UnknownOutcome", message: "uncertain write" },
      status: 409,
    }
  );
});

test("Effect 4 observation schemas preserve run variants, revision checks and canonical JSON", () => {
  const address = {
    agentId: userEvent.agentId,
    conversationId: userEvent.conversationId,
    organizationId: userEvent.organizationId,
    sessionId: userEvent.sessionId,
  };
  const metadata = {
    accessGeneration: 1,
    address,
    epoch: "epoch-A",
    schemaVersion: 1,
    sequence: 0,
  };
  const snapshot = {
    address,
    agentVersion: 1,
    approvals: [],
    executions: [],
    outputs: [],
    revision: 0,
    runs: [
      { runId: invocation.runId, state: "queued" },
      { runId: invocation.runId, state: "running" },
      { runId: invocation.runId, state: "waiting-for-approval" },
      { completedAt: now, runId: invocation.runId, state: "completed" },
      { endedAt: now, runId: invocation.runId, state: "failed" },
      { endedAt: now, runId: invocation.runId, state: "cancelled" },
    ],
    tools: [],
    userMessages: [],
  };
  const frame = { ...metadata, reason: "attach", snapshot, type: "snapshot" };
  assert.deepEqual(Schema.decodeUnknownSync(Observation)(frame), frame);
  for (const change of [
    { agentVersion: 0 },
    { revision: -1 },
    { revision: 0.5 },
    { runs: [{ runId: " ", state: "queued" }] },
    { runs: [{ runId: invocation.runId, state: "other" }] },
  ]) {
    assert.throws(() =>
      Schema.decodeUnknownSync(Observation)({
        ...frame,
        snapshot: { ...snapshot, ...change },
      })
    );
  }
  assert.throws(() =>
    Schema.decodeUnknownSync(Observation)({ ...frame, epoch: "" })
  );
  const update = {
    ...metadata,
    revision: 1,
    type: "update",
    update: {
      arguments: invocation.arguments,
      dependencies: { sourceIds: [], toolIds: [] },
      effect: invocation.tool.effect,
      operationId: invocation.operationId,
      output: { result: [null, true, 1, "ok"] },
      runId: invocation.runId,
      state: "succeeded",
      toolId: invocation.tool.id,
      toolVersion: invocation.tool.version,
      type: "tool",
    },
  };
  assert.deepEqual(Schema.decodeUnknownSync(Observation)(update), update);
  for (const output of [undefined, Number.NaN, { result: 1n }]) {
    assert.throws(() =>
      Schema.decodeUnknownSync(Observation)({
        ...update,
        update: { ...update.update, output },
      })
    );
  }
});

const submitCommand = (name: string) =>
  ({
    event: { ...userEvent, eventId: id.event(name) },
    type: "submit",
  }) as const;

const reloadSnapshot = (): DomainSnapshot => ({
  address: {
    agentId: userEvent.agentId,
    conversationId: userEvent.conversationId,
    organizationId: userEvent.organizationId,
    sessionId: userEvent.sessionId,
  },
  agentVersion: 1,
  approvals: [
    {
      approvalId: "approval-A",
      expiresAt: now + 1000,
      operationId: invocation.operationId,
      runId: invocation.runId,
      state: "pending",
    },
  ],
  executions: [
    {
      executionId: id.execution("execution:completed-run"),
      runIds: [id.run("completed-run")],
    },
  ],
  outputs: [
    {
      answerId: id.answer("answer:previous"),
      citations: [],
      dependencies: { sourceIds: [], toolIds: [] },
      executionId: id.execution("execution:completed-run"),
      runId: id.run("completed-run"),
      runIds: [id.run("completed-run")],
      text: "Previous canonical answer",
    },
  ],
  revision: 7,
  runs: [
    {
      completedAt: now - 1,
      runId: id.run("completed-run"),
      state: "completed",
    },
    { runId: invocation.runId, state: "waiting-for-approval" },
  ],
  tools: [
    {
      arguments: { ticket: "support-1" },
      dependencies: { sourceIds: [], toolIds: [invocation.tool.id] },
      effect: "write",
      operationId: invocation.operationId,
      output: null,
      runId: invocation.runId,
      state: "waiting-for-approval",
      toolId: invocation.tool.id,
      toolVersion: invocation.tool.version,
    },
    {
      arguments: { ticket: "previous-ticket" },
      dependencies: { sourceIds: [], toolIds: [invocation.tool.id] },
      effect: "read",
      operationId: id.operation("completed-tool"),
      output: { title: "Previous result" },
      runId: id.run("completed-run"),
      state: "succeeded",
      toolId: invocation.tool.id,
      toolVersion: invocation.tool.version,
    },
  ],
  userMessages: [
    {
      eventId: id.event("previous-message"),
      mode: "follow-up",
      occurredAt: now - 10,
      runId: id.run("completed-run"),
      text: "Previous question",
    },
    {
      eventId: userEvent.eventId,
      mode: "steer",
      occurredAt: userEvent.occurredAt,
      runId: invocation.runId,
      text: "Update the ticket",
    },
  ],
});

const decodeReloadSnapshot = (snapshot: DomainSnapshot): DomainSnapshot => {
  const persisted = JSON.stringify(snapshot);
  return Schema.decodeUnknownSync(DomainSnapshot)(JSON.parse(persisted));
};

test("reload snapshots retain messages, pending approvals and tool state; partial snapshots fail", () => {
  const snapshot = reloadSnapshot();
  const decoded = decodeReloadSnapshot(snapshot);
  assert.deepEqual(decoded, snapshot);
  for (const key of ["userMessages", "approvals", "tools", "executions"]) {
    const partial = { ...snapshot };
    Reflect.deleteProperty(partial, key);
    assert.throws(() => Schema.decodeUnknownSync(DomainSnapshot)(partial));
  }
  for (const change of [
    { userMessages: [{ ...snapshot.userMessages[0], eventId: "" }] },
    { userMessages: [{ ...snapshot.userMessages[0], occurredAt: Number.NaN }] },
    { approvals: [{ ...snapshot.approvals[0], approvalId: "" }] },
    {
      approvals: [
        { ...snapshot.approvals[0], expiresAt: Number.POSITIVE_INFINITY },
      ],
    },
    { approvals: [{ ...snapshot.approvals[0], state: "approved-maybe" }] },
    { tools: [{ ...snapshot.tools[0], arguments: { ticket: 1n } }] },
    { tools: [{ ...snapshot.tools[0], output: undefined }] },
    { tools: [{ ...snapshot.tools[0], toolVersion: "" }] },
  ]) {
    assert.throws(() =>
      Schema.decodeUnknownSync(DomainSnapshot)({ ...snapshot, ...change })
    );
  }
});

test("live message, approval and tool updates use the same records as canonical snapshots", () => {
  const snapshot = reloadSnapshot();
  const [message] = snapshot.userMessages;
  assert.deepEqual(
    Schema.decodeUnknownSync(DomainUpdate)({ message, type: "user-message" }),
    { message, type: "user-message" }
  );
  for (const state of [
    "pending",
    "allowed",
    "denied",
    "expired",
    "cancelled",
  ] as const) {
    const approvalState = { ...snapshot.approvals[0], state };
    assert.deepEqual(
      Schema.decodeUnknownSync(DomainSnapshot)({
        ...snapshot,
        approvals: [approvalState],
      }).approvals[0],
      approvalState
    );
    assert.deepEqual(
      Schema.decodeUnknownSync(DomainUpdate)({
        ...approvalState,
        type: "approval",
      }),
      { ...approvalState, type: "approval" }
    );
  }
  for (const state of [
    "requested",
    "waiting-for-approval",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "unknown-outcome",
  ] as const) {
    const tool = { ...snapshot.tools[0], state };
    assert.deepEqual(
      Schema.decodeUnknownSync(DomainSnapshot)({ ...snapshot, tools: [tool] })
        .tools[0],
      tool
    );
    assert.deepEqual(
      Schema.decodeUnknownSync(DomainUpdate)({ ...tool, type: "tool" }),
      { ...tool, type: "tool" }
    );
  }
});

test("joined runs reload one canonical answer and reject ambiguous execution membership", () => {
  const seed = reloadSnapshot();
  const runIds = [id.run("completed-run"), id.run("steered-run")] as const;
  const execution = {
    executionId: id.execution("execution:completed-run"),
    runIds,
  };
  const output = { ...seed.outputs[0], ...execution, runId: runIds[0] };
  const snapshot = { ...seed, executions: [execution], outputs: [output] };
  assert.deepEqual(decodeReloadSnapshot(snapshot), snapshot);
  assert.deepEqual(
    Schema.decodeUnknownSync(DomainUpdate)({ execution, type: "execution" }),
    { execution, type: "execution" }
  );
  assert.deepEqual(
    Schema.decodeUnknownSync(DomainUpdate)({
      output,
      type: "canonical-output",
    }),
    { output, type: "canonical-output" }
  );
  for (const change of [
    { executions: [] },
    { executions: [execution, execution] },
    {
      executions: [
        execution,
        { executionId: id.execution("other"), runIds: [runIds[1]] },
      ],
    },
    { executions: [{ ...execution, runIds: [] }] },
    { executions: [{ ...execution, runIds: [runIds[0], runIds[0]] }] },
    { outputs: [output, output] },
    { outputs: [{ ...output, answerId: "" }] },
    { outputs: [{ ...output, executionId: "" }] },
    { outputs: [{ ...output, runId: runIds[1] }] },
    { outputs: [{ ...output, runIds: [runIds[0]] }] },
  ]) {
    assert.throws(() =>
      Schema.decodeUnknownSync(DomainSnapshot)({ ...snapshot, ...change })
    );
  }
  assert.throws(() =>
    Schema.decodeUnknownSync(DomainUpdate)({
      runId: runIds[0],
      text: "old frame",
      type: "provisional-text",
    })
  );
});

test("atomic projection contract settles joined runs together and rolls back an invalid answer", async () => {
  const { createStoreFake } =
    await import("../../packages/contracts/src/testing/session-fakes.ts");
  const seed = reloadSnapshot();
  const fake = createStoreFake({
    ...seed,
    executions: [],
    outputs: [],
    runs: [],
  });
  const future = { ...options, deadlineAt: Date.now() + 60_000 };
  const first = await Effect.runPromise(
    fake.service.admit(
      submitCommand("joined-A"),
      authorityRequest.pinnedAgent,
      future
    )
  );
  const second = await Effect.runPromise(
    fake.service.admit(
      { ...submitCommand("joined-B"), mode: "steer" },
      authorityRequest.pinnedAgent,
      future
    )
  );
  const runIds = [first.run.runId, second.run.runId] as const;
  const execution = {
    executionId: id.execution(`execution:${runIds[0]}`),
    runIds,
  };
  const output = {
    answerId: id.answer("shared-answer"),
    citations: [],
    dependencies: { sourceIds: [], toolIds: [] },
    ...execution,
    runId: runIds[0],
    text: "One answer to both inputs",
  };
  const batch = {
    runId: runIds[0],
    type: "projected-batch",
    updates: [
      { execution, type: "execution" },
      { output, type: "canonical-output" },
      {
        run: { completedAt: now, runId: runIds[0], state: "completed" },
        type: "run",
      },
      {
        run: { completedAt: now, runId: runIds[1], state: "completed" },
        type: "run",
      },
    ],
  } satisfies HandoffTransition;
  const revision = fake.getRevision();
  const before = await Effect.runPromise(
    fake.service.recover(seed.address, future)
  );
  const invalid = {
    ...batch,
    updates: [
      batch.updates[0],
      { output: { ...output, runIds: [runIds[0]] }, type: "canonical-output" },
    ],
  } satisfies HandoffTransition;
  assert.equal(
    (
      await failureTag(
        fake.service.commit(seed.address, revision, invalid, future)
      )
    )._tag,
    "Unavailable"
  );
  assert.equal(fake.getRevision(), revision);
  assert.deepEqual(
    await Effect.runPromise(fake.service.recover(seed.address, future)),
    before
  );
  await Effect.runPromise(
    fake.service.commit(seed.address, revision, batch, future)
  );
  const snapshot = await Effect.runPromise(
    fake.service.snapshot(seed.address, allowedContext, future)
  );
  assert.equal(snapshot.revision, revision + batch.updates.length);
  assert.deepEqual(snapshot.outputs, [output]);
  const handoffs = await Effect.runPromise(
    fake.service.recover(seed.address, future)
  );
  assert.ok(handoffs.every((value) => value.run.state === "completed"));
  assert.ok(
    handoffs.every((value) => value.projectedRevision === snapshot.revision)
  );
  await Effect.runPromise(
    fake.service.commit(seed.address, snapshot.revision, batch, future)
  );
  assert.equal(fake.getRevision(), snapshot.revision);
  const changed = {
    ...batch,
    updates: [
      {
        output: { ...output, text: "Changed final answer" },
        type: "canonical-output",
      },
    ],
  } satisfies HandoffTransition;
  assert.equal(
    (
      await failureTag(
        fake.service.commit(seed.address, snapshot.revision, changed, future)
      )
    )._tag,
    "Conflict"
  );
  assert.equal(fake.getRevision(), snapshot.revision);
});

test("fresh inspect and attachment restore full authorized state without submitting or reusing caller objects", async () => {
  const { Stream } = await import("effect");
  const { createSessionFake, createStoreFake } =
    await import("../../packages/contracts/src/testing/session-fakes.ts");
  const snapshot = decodeReloadSnapshot(reloadSnapshot());
  const session = createSessionFake(snapshot);
  const store = createStoreFake(snapshot);
  const expected = structuredClone(snapshot);
  Reflect.set(snapshot.userMessages[0], "text", "Mutated caller input");
  const future = { deadlineAt: Date.now() + 60_000 };
  for (const service of [session.service, store.service]) {
    const restored =
      "inspect" in service
        ? await Effect.runPromise(
            service.inspect(expected.address, allowedContext, future)
          )
        : await Effect.runPromise(
            service.snapshot(expected.address, allowedContext, future)
          );
    assert.deepEqual(restored, expected);
    const observation =
      "stream" in service
        ? service.stream(
            expected.address,
            allowedContext,
            { accessGeneration: 2 },
            future
          )
        : service.attach(
            expected.address,
            allowedContext,
            { accessGeneration: 2 },
            future
          );
    const frames = await Effect.runPromise(
      Effect.scoped(Stream.runCollect(observation))
    );
    assert.equal(frames.length, 1);
    const frame = Schema.decodeUnknownSync(Observation)(frames[0]);
    assert.equal(frame.type, "snapshot");
    if (frame.type === "snapshot") {
      assert.deepEqual(frame.snapshot, expected);
    }
  }
  assert.equal(session.counts.submit, 0);
  await Effect.runPromise(
    session.service.approve(
      {
        address: expected.address,
        approvalId: expected.approvals[0].approvalId,
        context: allowedContext,
        decision: "allow",
        runId: invocation.runId,
        type: "approve",
      },
      { ...options, ...future }
    )
  );
  const resolved = await Effect.runPromise(
    session.service.inspect(expected.address, allowedContext, future)
  );
  assert.equal(resolved.approvals[0].state, "allowed");
  assert.equal(resolved.tools[0].state, "requested");
  const reloaded = createSessionFake(decodeReloadSnapshot(resolved));
  assert.deepEqual(
    await Effect.runPromise(
      reloaded.service.inspect(expected.address, allowedContext, future)
    ),
    resolved
  );
  assert.equal(session.counts.submit, 0);
  assert.equal(reloaded.counts.submit, 0);
});

test("Effect scope releases resources; native cancellation withdraws active work and queued inputs", async () => {
  const { createEngineFake } =
    await import("../../packages/contracts/src/testing/session-fakes.ts");
  const fake = createEngineFake();
  const future = { deadlineAt: Date.now() + 60_000 };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* verifyScope() {
        const conversation = yield* fake.service.open(
          userEvent,
          authorityRequest.pinnedAgent,
          future
        );
        const submit = (
          name: string,
          mode: "follow-up" | "steer" = "follow-up"
        ) =>
          conversation.submit(
            {
              event: { ...userEvent, eventId: id.event(name) },
              inputDigest: userEvent.payloadDigest,
              mode,
              requestId: id.event(name),
              runId: id.run(name),
            },
            future
          );
        yield* submit("run-A");
        yield* submit("run-B");
        yield* submit("run-C", "steer");
        const initial = yield* conversation.inspect(future);
        assert.deepEqual(
          initial.map((run) => run.state),
          ["running", "queued", "running"]
        );
        yield* conversation.cancel(id.run("run-B"), future);
        const afterQueuedCancel = yield* conversation.inspect(future);
        assert.deepEqual(
          afterQueuedCancel.map((run) => run.state),
          ["running", "cancelled", "running"]
        );
        yield* submit("run-D");
        yield* conversation.cancel(id.run("run-A"), future);
        const stopped = yield* conversation.inspect(future);
        assert.ok(stopped.every((run) => run.state === "cancelled"));
        yield* submit("run-E");
        assert.equal((yield* conversation.stop(future)).length, 1);
      })
    )
  );
  assert.equal(fake.counts.release, 1);
  assert.equal(fake.counts.stop, 1);
});

test("handoff acknowledgment requires Pi acceptance for queued work; observer close submits nothing", async () => {
  const { createStoreFake, createSessionFake } =
    await import("../../packages/contracts/src/testing/session-fakes.ts");
  const { Stream } = await import("effect");
  const snapshot = {
    address: userEvent,
    agentVersion: 1,
    approvals: [],
    executions: [],
    outputs: [],
    revision: 0,
    runs: [],
    tools: [],
    userMessages: [],
  };
  const fake = createStoreFake(snapshot);
  const future = { ...options, deadlineAt: Date.now() + 60_000 };
  const handoff = await Effect.runPromise(
    fake.service.admit(
      { event: userEvent, type: "submit" },
      authorityRequest.pinnedAgent,
      future
    )
  );
  const acknowledge = {
    runId: handoff.submission.runId,
    type: "acknowledged",
  } as const;
  assert.equal(
    (
      await failureTag(
        fake.service.commit(userEvent, fake.getRevision(), acknowledge, future)
      )
    )._tag,
    "Conflict"
  );
  await Effect.runPromise(
    fake.service.commit(
      userEvent,
      fake.getRevision(),
      {
        runId: handoff.submission.runId,
        type: "engine-accepted",
      },
      future
    )
  );
  assert.equal(
    (
      await Effect.runPromise(
        fake.service.commit(userEvent, fake.getRevision(), acknowledge, future)
      )
    ).acknowledged,
    true
  );
  const recovered = await Effect.runPromise(
    fake.service.recover(userEvent, future)
  );
  assert.equal(recovered[0].engineAccepted, true);
  assert.equal(recovered[0].run.state, "queued");
  const session = createSessionFake(snapshot);
  await Effect.runPromise(
    Effect.scoped(
      Stream.runCollect(
        session.service.stream(
          userEvent,
          allowedContext,
          { accessGeneration: 1 },
          future
        )
      )
    )
  );
  assert.equal(
    (
      await Effect.runPromise(
        session.service.inspect(userEvent, allowedContext, future)
      )
    ).runs.length,
    0
  );
});

test("replacement cancels previous pending work once; replay preserves later requests and mode changes conflict", async () => {
  const { createSessionFake } =
    await import("../../packages/contracts/src/testing/session-fakes.ts");
  const fake = createSessionFake({
    address: userEvent,
    agentVersion: 1,
    approvals: [],
    executions: [],
    outputs: [],
    revision: 0,
    runs: [],
    tools: [],
    userMessages: [],
  });
  const future = { ...options, deadlineAt: Date.now() + 60_000 };
  await Effect.runPromise(fake.service.submit(submitCommand("A"), future));
  await Effect.runPromise(fake.service.submit(submitCommand("B"), future));
  const replacement = { ...submitCommand("C"), mode: "replace" } as const;
  await Effect.runPromise(fake.service.submit(replacement, future));
  await Effect.runPromise(fake.service.submit(submitCommand("D"), future));
  const beforeReplay = await Effect.runPromise(
    fake.service.inspect(userEvent, allowedContext, future)
  );
  assert.deepEqual(
    beforeReplay.runs.map((run) => run.state),
    ["cancelled", "cancelled", "running", "queued"]
  );
  assert.deepEqual(
    beforeReplay.userMessages.map((message) => message.eventId),
    ["A", "B", "C", "D"]
  );
  assert.deepEqual(
    beforeReplay.userMessages.map((message) => message.mode),
    ["follow-up", "follow-up", "replace", "follow-up"]
  );
  assert.equal(
    (await Effect.runPromise(fake.service.submit(replacement, future)))
      .replayed,
    true
  );
  assert.deepEqual(
    await Effect.runPromise(
      fake.service.inspect(userEvent, allowedContext, future)
    ),
    beforeReplay
  );
  assert.equal(fake.counts.submit, 4);
  assert.equal(
    (
      await failureTag(
        fake.service.submit({ ...replacement, mode: "steer" }, future)
      )
    )._tag,
    "Conflict"
  );
});

test("replacement intent records mode and stop before engine acceptance; changed input or mode conflicts", async () => {
  const { createStoreFake } =
    await import("../../packages/contracts/src/testing/session-fakes.ts");
  const fake = createStoreFake({
    address: userEvent,
    agentVersion: 1,
    approvals: [],
    executions: [],
    outputs: [],
    revision: 0,
    runs: [],
    tools: [],
    userMessages: [],
  });
  const future = { ...options, deadlineAt: Date.now() + 60_000 };
  const command = {
    event: userEvent,
    mode: "replace",
    type: "submit",
  } as const;
  const handoff = await Effect.runPromise(
    fake.service.admit(command, authorityRequest.pinnedAgent, future)
  );
  const accepted = {
    runId: handoff.submission.runId,
    type: "engine-accepted",
  } as const;
  assert.equal(
    (
      await failureTag(
        fake.service.commit(userEvent, fake.getRevision(), accepted, future)
      )
    )._tag,
    "Conflict"
  );
  await Effect.runPromise(
    fake.service.commit(
      userEvent,
      fake.getRevision(),
      { runId: handoff.submission.runId, type: "replace-stopped" },
      future
    )
  );
  await Effect.runPromise(
    fake.service.commit(userEvent, fake.getRevision(), accepted, future)
  );
  assert.equal(
    (
      await failureTag(
        fake.service.commit(
          userEvent,
          fake.getRevision(),
          { runId: handoff.submission.runId, type: "replace-stopped" },
          future
        )
      )
    )._tag,
    "Conflict"
  );
  assert.equal(
    (
      await Effect.runPromise(
        fake.service.admit(command, authorityRequest.pinnedAgent, future)
      )
    ).engineAccepted,
    true
  );
  assert.equal(
    (
      await failureTag(
        fake.service.admit(
          { ...command, mode: "steer" },
          authorityRequest.pinnedAgent,
          future
        )
      )
    )._tag,
    "Conflict"
  );
  assert.equal(
    (
      await failureTag(
        fake.service.admit(
          {
            ...command,
            event: { ...userEvent, payloadDigest: id.digest("changed") },
          },
          authorityRequest.pinnedAgent,
          future
        )
      )
    )._tag,
    "Conflict"
  );
});
