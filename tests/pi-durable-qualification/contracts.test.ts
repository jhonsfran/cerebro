/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Serial binding mutations are asserted at their await point. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect, Result, Schema } from "effect";

import {
  AuthorityService,
  enforceDecision,
} from "../../packages/contracts/src/authority-service.ts";
import type { AuthorityRequest } from "../../packages/contracts/src/authority-service.ts";
import {
  Denied,
  failureToHttp,
  UnknownOutcome,
} from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import { Observation } from "../../packages/contracts/src/session-service.ts";
import {
  createAuthorityFake,
  createReceiptFake,
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
const failureTag = async (effect: Effect.Effect<unknown, unknown>) => {
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
test("atomic dispatch claims one write and immutable completion survives duplicate callers", async () => {
  const fake = createReceiptFake(() => now);
  const intent = { invocation, policyVersion: "fixture-v1" };
  const claim = await Effect.runPromise(fake.service.claim(intent, options));
  const results = await Promise.all(
    [1, 2].map(() =>
      Effect.runPromise(
        fake.service.dispatch(claim.receipt.key, 1, approval, options)
      )
    )
  );
  assert.equal(results.filter((result) => result.dispatch).length, 1);
  const outcome = {
    execution: { output: "done", providerReceipt: "confirmed" },
    state: "succeeded",
  } as const;
  await Effect.runPromise(
    fake.service.recordOutcome(claim.receipt.key, outcome, options)
  );
  await Effect.runPromise(fake.service.complete(claim.receipt.key, options));
  assert.equal(
    (await Effect.runPromise(fake.service.claim(intent, options))).receipt
      .state,
    "completed"
  );
  assert.equal(
    (
      await failureTag(
        fake.service.recordOutcome(
          claim.receipt.key,
          { ...outcome, execution: { output: "changed" } },
          options
        )
      )
    )._tag,
    "Conflict"
  );
});
test("changed intent conflicts, uncertain writes cannot dispatch, and revocation denies reads", async () => {
  const fake = createReceiptFake(() => now);
  const claim = await Effect.runPromise(
    fake.service.claim({ invocation, policyVersion: "fixture-v1" }, options)
  );
  assert.equal(
    (
      await failureTag(
        fake.service.claim(
          {
            invocation: { ...invocation, runId: id.run("run-B") },
            policyVersion: "fixture-v1",
          },
          options
        )
      )
    )._tag,
    "Conflict"
  );
  await Effect.runPromise(
    fake.service.dispatch(claim.receipt.key, 1, approval, options)
  );
  await Effect.runPromise(
    fake.service.unknown(
      claim.receipt.key,
      "dispatch interrupted",
      undefined,
      options
    )
  );
  assert.ok(
    (await failureTag(
      fake.service.dispatch(claim.receipt.key, 3, approval, options)
    )) instanceof UnknownOutcome
  );
  const nextOccurrence = id.operation("new-Pi-occurrence");
  const blockedOccurrence = await failureTag(
    fake.service.claim(
      {
        invocation: { ...invocation, operationId: nextOccurrence },
        policyVersion: "fixture-v1",
      },
      { ...options, operationId: nextOccurrence }
    )
  );
  assert.ok(blockedOccurrence instanceof UnknownOutcome);
  assert.equal(blockedOccurrence.operationId, invocation.operationId);
  fake.setAllowed(false);
  assert.ok(
    (await failureTag(
      fake.service.read(claim.receipt.key, allowedContext, options)
    )) instanceof Denied
  );
});
test("denied and revoked approval cause zero fake dispatches; reconcile never executes", async () => {
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
  assert.ok(
    (await failureTag(
      fake.service.reconcile(invocation.operationId, allowedContext, options)
    )) instanceof UnknownOutcome
  );
  assert.equal(fake.counts.dispatch, 0);
  assert.equal(fake.counts.reconcile, 1);
  const receipt = createReceiptFake(() => now);
  const claim = await Effect.runPromise(
    receipt.service.claim({ invocation, policyVersion: "fixture-v1" }, options)
  );
  assert.ok(
    (await failureTag(
      receipt.service.dispatch(claim.receipt.key, 1, undefined, options)
    )) instanceof Denied
  );
  receipt.setAllowed(false);
  assert.ok(
    (await failureTag(
      receipt.service.dispatch(claim.receipt.key, 1, approval, options)
    )) instanceof Denied
  );
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
    outputs: [],
    revision: 0,
    runs: [
      { runId: invocation.runId, state: "queued" },
      { runId: invocation.runId, state: "running" },
      { runId: invocation.runId, state: "waiting-for-approval" },
      { completedAt: now, runId: invocation.runId, state: "completed" },
      { endedAt: now, runId: invocation.runId, state: "failed" },
      { endedAt: now, runId: invocation.runId, state: "cancelled" },
      {
        operationId: invocation.operationId,
        runId: invocation.runId,
        state: "unknown-outcome",
      },
    ],
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
      dependencies: { sourceIds: [], toolIds: [] },
      operationId: invocation.operationId,
      output: { result: [null, true, 1, "ok"] },
      runId: invocation.runId,
      state: "succeeded",
      toolId: invocation.tool.id,
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

test("Effect scope closes engine resources and cancel A preserves queued B in the contract fake", async () => {
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
        yield* conversation.submit(
          {
            event: userEvent,
            inputDigest: userEvent.payloadDigest,
            requestId: userEvent.eventId,
            runId: id.run("run-A"),
          },
          future
        );
        yield* conversation.submit(
          {
            event: { ...userEvent, eventId: id.event("event-B") },
            inputDigest: userEvent.payloadDigest,
            requestId: id.event("event-B"),
            runId: id.run("run-B"),
          },
          future
        );
        yield* conversation.cancel(id.run("run-A"), future);
        const runs = yield* conversation.inspect(future);
        assert.equal(
          runs.find((run) => run.runId === "run-B")?.state,
          "queued"
        );
      })
    )
  );
  assert.equal(fake.counts.release, 1);
});
test("host fake refuses acknowledgement until engine acceptance and persisted wake; observer close submits nothing", async () => {
  const { createStoreFake, createSessionFake } =
    await import("../../packages/contracts/src/testing/session-fakes.ts");
  const { Stream } = await import("effect");
  const snapshot = {
    address: userEvent,
    agentVersion: 1,
    outputs: [],
    revision: 0,
    runs: [],
  };
  const fake = createStoreFake(snapshot);
  const future = { ...options, deadlineAt: Date.now() + 60_000 };
  const handoff = await Effect.runPromise(
    fake.service.admit(userEvent, authorityRequest.pinnedAgent, future)
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
      { runId: handoff.submission.runId, type: "engine-accepted" },
      future
    )
  );
  await Effect.runPromise(
    fake.service.commit(
      userEvent,
      fake.getRevision(),
      {
        runId: handoff.submission.runId,
        type: "wake-registered",
        wakeAt: Date.now() + 1000,
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
