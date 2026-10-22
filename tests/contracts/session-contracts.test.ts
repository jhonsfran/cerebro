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
import {
  ChatSnapshot,
  ChatDecisionReceipt,
  ChatObservation,
  ChatReceipt,
} from "../../packages/contracts/src/session-service.ts";
import {
  boundApprovalMatches,
  connectorFingerprint,
} from "../../packages/contracts/src/tool-service.ts";
import type {
  BoundApproval,
  BoundInvocation,
} from "../../packages/contracts/src/tool-service.ts";
import { createAuthorityFake } from "../support/effect-fakes.ts";
import {
  allowedContext,
  allowedUser,
  unknownOutcomeInvocation,
  userEvent,
} from "../support/fixtures.ts";

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
test("native chat snapshots retain message and approval binding across JSON transport", () => {
  const snapshot = {
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
        arguments: { value: "approved" },
        callId: "call-A",
        expiresAt: now + 1000,
        operationId: "write-A",
        state: "pending",
        taskId: "task-A",
        toolId: "fixture-write",
      },
    ],
    busy: true,
    messages: [
      {
        id: "entry-A",
        role: "user",
        state: "complete",
        text: "Apply the change.",
      },
      {
        id: "partial-A",
        role: "assistant",
        state: "streaming",
        text: "Checking",
        thinking: "Visible reasoning",
      },
      {
        id: "entry-B",
        role: "tool",
        state: "complete",
        text: "Allowed",
        toolName: "fixture-write",
      },
    ],
    queuedInputs: [
      { mode: "followUp", submissionId: "input-B", text: "Check it again." },
    ],
    tools: [
      {
        arguments: { value: "approved" },
        callId: "call-A",
        id: "entry-A:0:0",
        messageId: "entry-A",
        output: "Allowed",
        resultMessageId: "entry-B",
        state: "succeeded",
        toolName: "fixture-write",
      },
    ],
  };
  const encoded = JSON.stringify(snapshot);
  const parsed = Schema.decodeUnknownSync(ChatSnapshot)(JSON.parse(encoded));
  assert.deepEqual(parsed, snapshot);
  assert.deepEqual(
    Schema.decodeUnknownSync(ChatObservation)({ snapshot, type: "snapshot" }),
    { snapshot, type: "snapshot" }
  );
  for (const change of [
    { agentVersion: 0 },
    { busy: "running" },
    {
      messages: [
        { id: "entry", role: "system", state: "complete", text: "Invalid" },
      ],
    },
    {
      messages: [
        { id: "entry", role: "assistant", state: "running", text: "Invalid" },
      ],
    },
    { approvals: [{ ...snapshot.approvals[0], arguments: { invalid: 1n } }] },
    { approvals: [{ ...snapshot.approvals[0], callId: "" }] },
    { queuedInputs: [{ ...snapshot.queuedInputs[0], mode: "write" }] },
    { queuedInputs: undefined },
    { tools: [{ ...snapshot.tools[0], arguments: { invalid: 1n } }] },
    { tools: [{ ...snapshot.tools[0], state: "done" }] },
    { tools: [{ ...snapshot.tools[0], resultMessageId: "" }] },
    { tools: undefined },
  ]) {
    assert.throws(() =>
      Schema.decodeUnknownSync(ChatSnapshot)({ ...snapshot, ...change })
    );
  }
});
test("native receipt and access denial reject malformed transport and preserve unknown-outcome meaning", () => {
  const receipt = {
    accepted: true,
    operationId: "input-A",
    session: "native-session-A",
  };
  assert.deepEqual(
    Schema.decodeUnknownSync(ChatDecisionReceipt)({
      approvalId: "approval-A",
      state: "denied",
    }),
    { approvalId: "approval-A", state: "denied" }
  );
  assert.deepEqual(Schema.decodeUnknownSync(ChatReceipt)(receipt), receipt);
  assert.throws(() =>
    Schema.decodeUnknownSync(ChatReceipt)({ ...receipt, accepted: "true" })
  );
  assert.deepEqual(
    Schema.decodeUnknownSync(ChatObservation)({
      reason: "revoked",
      type: "access-denied",
    }),
    { reason: "revoked", type: "access-denied" }
  );
  assert.throws(() =>
    Schema.decodeUnknownSync(ChatObservation)({
      reason: "EOF",
      type: "access-denied",
    })
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
