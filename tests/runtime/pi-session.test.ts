/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Each assertion inspects its preceding durable transition. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  Context,
  Effect,
  Exit,
  Layer,
  Queue,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect";

import type { SessionStore } from "../../packages/contracts/src/execution.ts";
import { ExecutionEngine } from "../../packages/contracts/src/execution.ts";
import {
  Denied,
  InvalidInput,
  Unavailable,
  UnknownOutcome,
} from "../../packages/contracts/src/failures.ts";
import type { ContractFailure } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import type { RunId } from "../../packages/contracts/src/identity.ts";
import type { ReadOptions } from "../../packages/contracts/src/port.ts";
import {
  Observation,
  SessionService,
} from "../../packages/contracts/src/session-service.ts";
import type {
  DomainUpdate,
  DomainSnapshot,
} from "../../packages/contracts/src/session-service.ts";
import type { ContentDependencies } from "../../packages/contracts/src/session.ts";
import {
  createAuthorityFake,
  createReceiptFake,
  createToolFake,
} from "../../packages/contracts/src/testing/effect-fakes.ts";
import {
  allowedContext,
  userEvent,
  unknownOutcomeInvocation,
  unknownOutcomeCapability,
} from "../../packages/contracts/src/testing/fixtures.ts";
import {
  createEngineFake,
  createStoreFake,
} from "../../packages/contracts/src/testing/session-fakes.ts";
import type {
  BoundApproval,
  ToolExecutor,
} from "../../packages/contracts/src/tool-service.ts";
import { canonicalToolArguments } from "../../packages/contracts/src/tools.ts";
import {
  Type,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  createAssistantMessageEventStream,
  normalizeContext,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { createModels } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/models.js";
import {
  Harness,
  LiveDoc,
  MemoryStorage,
  createRegistry,
  watchEvents,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import type {
  AgentEvent,
  AgentEventStream,
  SubmissionRecord,
  ToolRegistration,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import {
  auditProjection,
  drainAuditProjection,
} from "../../packages/runtime/src/audit-projection.ts";
import type { AuditProjection } from "../../packages/runtime/src/audit-projection.ts";
import { createSessionStore } from "../../packages/runtime/src/celld-session-store.ts";
import {
  createPiExecutionEngine,
  modelAuthority,
  piContext,
} from "../../packages/runtime/src/pi-harness.ts";
import type { PiEngineConfiguration } from "../../packages/runtime/src/pi-harness.ts";
import { createControlledProvider } from "../../packages/runtime/src/pi-provider.ts";
import { createPiTools } from "../../packages/runtime/src/pi-tools.ts";
import type { HostCheckpoint } from "../../packages/runtime/src/runtime-ports.ts";
import {
  createSessionService,
  SessionCoordinator,
  sessionServiceLayer,
} from "../../packages/runtime/src/session-service.ts";
import type { SessionCoordinatorRuntime } from "../../packages/runtime/src/session-service.ts";

const address = {
  agentId: userEvent.agentId,
  conversationId: userEvent.conversationId,
  organizationId: userEvent.organizationId,
  sessionId: userEvent.sessionId,
};
const agent = {
  agentId: address.agentId,
  enabledToolIds: [unknownOutcomeInvocation.tool.id],
  grants: [],
  instructions: "Use only registered Cerebro tools",
  model: "fixture-model",
  organizationId: address.organizationId,
  version: 1,
};
const emptySnapshot: DomainSnapshot = {
  address,
  agentVersion: 1,
  approvals: [],
  executions: [],
  outputs: [],
  revision: 0,
  runs: [],
  tools: [],
  userMessages: [],
};
const answerIdentity = (
  runId: RunId,
  runIds: readonly [RunId, ...RunId[]] = [runId]
) => ({
  answerId: id.answer(`answer:${runId}`),
  executionId: id.execution(`execution:${runId}`),
  runIds,
});
const event = (name = "A") => ({ ...userEvent, eventId: id.event(name) });
const options = () => ({
  deadlineAt: Date.now() + 10_000,
  operationId: id.operation("request"),
  requestDigest: userEvent.payloadDigest,
});
const failure = async <E>(effect: Effect.Effect<unknown, E>) => {
  const result = await Effect.runPromise(Effect.result(effect));
  assert.ok(Result.isFailure(result));
  return result.failure;
};
const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    assert.ok(
      Date.now() < deadline,
      "Projection did not settle within two seconds"
    );
    await Effect.runPromise(Effect.sleep(5));
  }
};

const setup = async (
  useContractStore = false,
  persistent = false,
  checkpoint?: HostCheckpoint,
  retainDurableWork?: (completion: Promise<void>) => void
) => {
  let beforeRead:
    | ((
        dependencies: ContentDependencies
      ) => Effect.Effect<void, ContractFailure>)
    | undefined;
  const scope = Scope.makeUnsafe();
  const authority = createAuthorityFake(Date.now);
  const engine = createEngineFake();
  const directory = persistent
    ? mkdtempSync(path.join(tmpdir(), "cerebro-joined-"))
    : undefined;
  const databasePath = directory
    ? path.join(directory, "state.sqlite")
    : ":memory:";
  let database = new DatabaseSync(databasePath);
  database.exec(
    "CREATE TABLE state (id INTEGER PRIMARY KEY, json TEXT NOT NULL)"
  );
  const persistence = {
    load: () =>
      (
        database.prepare("SELECT json FROM state WHERE id=1").get() as
          | { json: string }
          | undefined
      )?.json,
    save: (json: string) => {
      database
        .prepare(
          "INSERT INTO state VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json=excluded.json"
        )
        .run(json);
    },
    transaction: <A>(run: () => A) => {
      database.exec("BEGIN");
      try {
        const value = run();
        database.exec("COMMIT");
        return value;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const storeConfiguration = {
    accessIntervalMs: 10,
    address,
    agent,
    authorize: (
      context: typeof allowedContext,
      contentDependencies: ContentDependencies,
      readOptions: ReadOptions
    ) =>
      Effect.gen(function* authorizeFixtureRead() {
        yield* authority.service.require(
          {
            action: "read",
            address,
            context,
            pinnedAgent: agent,
            resource: {
              id: address.agentId,
              kind: "agent",
              organizationId: address.organizationId,
            },
          },
          readOptions
        );
        if (beforeRead) {
          yield* beforeRead(contentDependencies);
        }
      }),
    observerCapacity: 8,
  };
  const store = createSessionStore(persistence, storeConfiguration);
  const contractStore = createStoreFake(emptySnapshot);
  const selected = useContractStore ? contractStore.service : store.service;
  const dependencies = {
    address,
    agent,
    authority: authority.service,
    checkpoint,
    engine: engine.service,
    retainDurableWork,
    store: selected,
  };
  const services = await Effect.runPromise(
    Layer.buildWithScope(
      sessionServiceLayer({
        address,
        agent,
        checkpoint,
        retainDurableWork,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            authority.layer,
            engine.layer,
            useContractStore ? contractStore.layer : store.layer
          )
        )
      ),
      scope
    )
  );
  const runtime = Context.get(services, SessionCoordinator);
  return {
    ...runtime,
    authority,
    close: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      database.close();
      if (directory) {
        rmSync(directory, { recursive: true });
      }
    },
    dependencies,
    engine,
    persistence,
    reopen: () => createSessionStore(persistence, storeConfiguration),
    reopenDatabase: () => {
      database.close();
      database = new DatabaseSync(databasePath);
    },
    setReadHook: (
      hook: (
        dependencies: ContentDependencies
      ) => Effect.Effect<void, ContractFailure>
    ) => {
      beforeRead = hook;
    },
    store,
    storeConfiguration,
  };
};
const submit = async (
  fixture: Awaited<ReturnType<typeof setup>>,
  name = "A",
  mode?: "replace" | "steer"
) =>
  await Effect.runPromise(
    fixture.service.submit(
      { event: event(name), mode, type: "submit" },
      options()
    )
  );

test("coordinator deduplicates concurrent commands using the frozen engine and store fakes", async () => {
  const fixture = await setup(true);
  try {
    const receipts = await Promise.all(
      Array.from({ length: 8 }, () => submit(fixture))
    );
    assert.equal(new Set(receipts.map((receipt) => receipt.runId)).size, 1);
    assert.equal(fixture.engine.counts.submit, 1);
    assert.equal(receipts.filter((receipt) => !receipt.replayed).length, 1);
    assert.equal(fixture.engine.counts.open, 1);
  } finally {
    await fixture.close();
  }
  assert.equal(fixture.engine.counts.release, 1);
});

test("immutable admission compares text, identity and submission mode, including after acknowledgment", async () => {
  const fixture = await setup();
  try {
    await submit(fixture);
    const changed = {
      ...event(),
      event: { payload: { text: "changed" }, type: "user.message" as const },
    };
    assert.equal(
      (
        await failure(
          fixture.service.submit({ event: changed, type: "submit" }, options())
        )
      )._tag,
      "Conflict"
    );
    assert.equal(
      (
        await failure(
          fixture.service.submit(
            { event: event(), mode: "replace", type: "submit" },
            options()
          )
        )
      )._tag,
      "Conflict"
    );
    assert.equal(fixture.engine.counts.submit, 1);
    assert.equal(fixture.engine.counts.stop, 0);
  } finally {
    await fixture.close();
  }
});

test("acknowledgment requires Pi acceptance; interrupted marker recording repairs the same operation", async () => {
  const fixture = await setup();
  try {
    let failCommit = true;
    const wrapped: SessionStore = {
      ...fixture.store.service,
      commit: (...args) =>
        args[2].type === "engine-accepted" && failCommit
          ? Effect.fail(
              new Unavailable({ reason: "Injected crash after Pi acceptance" })
            )
          : fixture.store.service.commit(...args),
    };
    const scope = Scope.makeUnsafe();
    try {
      const runtime = await Effect.runPromise(
        Scope.provide(scope)(
          createSessionService({ ...fixture.dependencies, store: wrapped })
        )
      );
      assert.equal(
        (
          await failure(
            runtime.service.submit(
              { event: event(), type: "submit" },
              options()
            )
          )
        )._tag,
        "Unavailable"
      );
      assert.equal(fixture.engine.counts.submit, 1);
      assert.equal(
        (
          await failure(
            fixture.store.service.receipt(
              address,
              event().eventId,
              allowedContext,
              options()
            )
          )
        )._tag,
        "Unavailable"
      );
      failCommit = false;
      await Effect.runPromise(runtime.recover());
      await Effect.runPromise(
        runtime.service.submit({ event: event(), type: "submit" }, options())
      );
      assert.equal(fixture.engine.counts.submit, 1);
      const [handoff] = await Effect.runPromise(
        fixture.store.service.recover(address, options())
      );
      assert.ok(handoff?.engineAccepted && handoff.acknowledged);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  } finally {
    await fixture.close();
  }
});

test("replacement Stop is ordered before submit and replay preserves later work", async () => {
  const fixture = await setup();
  try {
    await submit(fixture, "A");
    await submit(fixture, "B");
    const replacement = await submit(fixture, "R", "replace");
    await submit(fixture, "C");
    assert.deepEqual(await submit(fixture, "R", "replace"), {
      ...replacement,
      replayed: true,
    });
    assert.equal(fixture.engine.counts.stop, 1);
    assert.equal(fixture.engine.counts.submit, 4);
    const states = await Effect.runPromise(
      fixture.engine.conversation.inspect(options())
    );
    assert.equal(
      states.find((run) => run.runId === id.run("run:C"))?.state,
      "queued"
    );
    assert.equal(
      states.find((run) => run.runId === id.run("run:A"))?.state,
      "cancelled"
    );
  } finally {
    await fixture.close();
  }
});

test("replacement acceptance before its marker repairs without another Stop", async () => {
  const fixture = await setup();
  try {
    await submit(fixture, "A");
    let inject = true;
    const scope = Scope.makeUnsafe();
    const store: SessionStore = {
      ...fixture.store.service,
      commit: (...args) =>
        args[2].type === "engine-accepted" && inject
          ? Effect.fail(
              new Unavailable({ reason: "Injected acceptance marker crash" })
            )
          : fixture.store.service.commit(...args),
    };
    try {
      const runtime = await Effect.runPromise(
        Scope.provide(scope)(
          createSessionService({ ...fixture.dependencies, store })
        )
      );
      await failure(
        runtime.service.submit(
          { event: event("R"), mode: "replace", type: "submit" },
          options()
        )
      );
      inject = false;
      await Effect.runPromise(runtime.recover());
      assert.equal(fixture.engine.counts.stop, 1);
      assert.equal(fixture.engine.counts.submit, 2);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  } finally {
    await fixture.close();
  }
});

test("queued cancellation withdraws only that input; native active Stop withdraws pending inputs", async () => {
  const fixture = await setup();
  try {
    const first = await submit(fixture, "A");
    const queued = await submit(fixture, "B");
    assert.equal(
      fixture.store.domain().runs.find((run) => run.runId === queued.runId)
        ?.state,
      "queued"
    );
    await Effect.runPromise(
      fixture.service.cancel(
        {
          address,
          context: allowedContext,
          runId: queued.runId,
          type: "cancel",
        },
        options()
      )
    );
    assert.equal(
      (
        await Effect.runPromise(
          fixture.service.inspect(address, allowedContext, options())
        )
      ).runs.find((run) => run.runId === first.runId)?.state,
      "running"
    );
    const third = await submit(fixture, "C");
    await Effect.runPromise(
      fixture.service.cancel(
        {
          address,
          context: allowedContext,
          runId: first.runId,
          type: "cancel",
        },
        options()
      )
    );
    const states = (
      await Effect.runPromise(
        fixture.service.inspect(address, allowedContext, options())
      )
    ).runs;
    assert.equal(
      states.find((run) => run.runId === third.runId)?.state,
      "cancelled"
    );
    assert.equal(
      states.find((run) => run.runId === first.runId)?.state,
      "cancelled"
    );
  } finally {
    await fixture.close();
  }
});

test("terminal success requires durable canonical output and confirmed tools, preserved on reopen", async () => {
  const fixture = await setup();
  try {
    const receipt = await submit(fixture);
    const completed = {
      run: {
        completedAt: Date.now(),
        runId: receipt.runId,
        state: "completed" as const,
      },
      type: "run" as const,
    };
    assert.equal((await failure(fixture.project(completed)))._tag, "Conflict");
    const tool: DomainUpdate = {
      arguments: {},
      dependencies: { sourceIds: [], toolIds: ["fixture"] },
      effect: "write",
      operationId: id.operation("tool-A"),
      output: null,
      runId: receipt.runId,
      state: "running",
      toolId: id.tool("fixture"),
      toolVersion: "1",
      type: "tool",
    };
    await Effect.runPromise(fixture.project(tool));
    const output = {
      output: {
        citations: [],
        dependencies: { sourceIds: [], toolIds: ["fixture"] },
        ...answerIdentity(receipt.runId),
        runId: receipt.runId,
        text: "canonical answer",
      },
      type: "canonical-output" as const,
    };
    await Effect.runPromise(fixture.project(output));
    assert.equal((await failure(fixture.project(completed)))._tag, "Conflict");
    await Effect.runPromise(
      fixture.project({ ...tool, output: "confirmed", state: "succeeded" })
    );
    await Effect.runPromise(fixture.project(completed));
    const reopened = fixture.reopen();
    const snapshot = await Effect.runPromise(
      reopened.service.snapshot(address, allowedContext, options())
    );
    assert.equal(snapshot.runs[0]?.state, "completed");
    assert.equal(snapshot.outputs[0]?.text, "canonical answer");
    assert.equal(snapshot.tools[0]?.output, "confirmed");
    assert.equal(snapshot.userMessages.length, 1);
    assert.ok(
      reopened
        .outbox()
        .some(
          (record) =>
            record.update.type === "run" &&
            record.update.run.state === "completed"
        )
    );
    assert.equal(fixture.engine.counts.submit, 1);
  } finally {
    await fixture.close();
  }
});

test("observation subscribes before snapshot; detach leaves the durable run running", async () => {
  const fixture = await setup();
  try {
    await submit(fixture);
    const iterator = Stream.toAsyncIterable(
      Stream.scoped(
        fixture.service.stream(
          address,
          allowedContext,
          { accessGeneration: 3 },
          options()
        )
      )
    )[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.value?.type, "snapshot");
    assert.ok(Schema.is(Observation)(first.value));
    assert.equal(first.value?.accessGeneration, 3);
    assert.equal(fixture.store.observerCount(), 1);
    await iterator.return?.();
    assert.equal(fixture.store.observerCount(), 0);
    assert.equal(fixture.engine.counts.cancel, 0);
    assert.equal(fixture.engine.counts.submit, 1);
    assert.equal(
      (
        await Effect.runPromise(fixture.engine.conversation.inspect(options()))
      )[0]?.state,
      "running"
    );
  } finally {
    await fixture.close();
  }
});

test("detach releases an idle native observer while its next frame is pending", async () => {
  const fixture = await setup();
  try {
    await submit(fixture);
    const iterator = Stream.toAsyncIterable(
      Stream.scoped(
        fixture.service.stream(
          address,
          allowedContext,
          { accessGeneration: 1 },
          options()
        )
      )
    )[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, "snapshot");
    const pending = iterator.next();
    const closed = iterator.return?.();
    await Effect.runPromise(
      Effect.tryPromise({
        catch: (error) => error,
        try: () => Promise.all([pending, closed]),
      }).pipe(Effect.timeout(500))
    );
    assert.equal(fixture.store.observerCount(), 0);
    assert.equal(fixture.engine.counts.cancel, 0);
  } finally {
    await fixture.close();
  }
});

test("provisional text bypasses storage sync while durable transitions await it", async () => {
  const fixture = await setup();
  const gate = Promise.withResolvers<boolean>();
  let flushCalls = 0;
  try {
    const receipt = await submit(fixture);
    await until(() => fixture.store.domain().runs[0]?.state === "running");
    const { executionId } = answerIdentity(receipt.runId);
    await Effect.runPromise(
      fixture.project({
        execution: { executionId, runIds: [receipt.runId] },
        type: "execution",
      })
    );
    const store = createSessionStore(
      {
        ...fixture.persistence,
        flush: async () => {
          flushCalls += 1;
          await gate.promise;
        },
      },
      fixture.storeConfiguration
    );
    const before = fixture.persistence.load();
    const { revision } = store.domain();
    await Effect.runPromise(
      store.service
        .commit(
          address,
          revision,
          {
            runId: receipt.runId,
            type: "projected",
            update: {
              executionId,
              runId: receipt.runId,
              text: "First text",
              type: "provisional-text",
            },
          },
          options()
        )
        .pipe(Effect.timeout(250))
    );
    assert.equal(flushCalls, 0);
    assert.equal(fixture.persistence.load(), before);
    let acknowledged = false;
    const durable = Effect.runPromise(
      store.service.commit(
        address,
        revision,
        {
          runId: receipt.runId,
          type: "projected",
          update: {
            run: {
              endedAt: Date.now(),
              runId: receipt.runId,
              state: "cancelled",
            },
            type: "run",
          },
        },
        options()
      )
    );
    const completion = (async () => {
      await durable;
      acknowledged = true;
    })();
    await until(() => flushCalls === 1);
    assert.equal(acknowledged, false);
    gate.resolve(true);
    await completion;
    assert.equal(acknowledged, true);
    assert.equal(store.domain().runs[0].state, "cancelled");
  } finally {
    gate.resolve(true);
    await fixture.close();
  }
});

const approvalFor = (runId: RunId): BoundApproval => ({
  actorPrincipalId: allowedContext.actor.id,
  agentId: agent.agentId,
  approverId: allowedContext.actor.id,
  argumentDigest: unknownOutcomeCapability.argumentDigest,
  connectorFingerprint: id.digest("registered-connector"),
  connectorId: unknownOutcomeInvocation.tool.connectorId,
  effect: "write",
  expiresAt: Date.now() + 10_000,
  id: "approval-A",
  operationId: unknownOutcomeInvocation.operationId,
  organizationId: address.organizationId,
  policyVersion: "fixture-v1",
  principalId: allowedContext.actor.id,
  runId,
  toolId: unknownOutcomeInvocation.tool.id,
  toolVersion: "1",
});

const persistPendingApproval = async (
  fixture: Awaited<ReturnType<typeof setup>>,
  approval: BoundApproval
) => {
  const handoffs = await Effect.runPromise(
    fixture.store.service.recover(address, options())
  );
  await Effect.runPromise(
    fixture.store.service.commit(
      address,
      Math.max(...handoffs.map((item) => item.revision)),
      { approval, runId: approval.runId, type: "approval" },
      options()
    )
  );
  await Effect.runPromise(
    fixture.project({
      approvalId: approval.id,
      expiresAt: approval.expiresAt,
      operationId: approval.operationId,
      runId: approval.runId,
      state: "pending",
      type: "approval",
    })
  );
};

const noHeldDecision = () => Effect.void;
for (const change of ["revocation", "policy", "expiry"] as const) {
  test(`approval rechecks ${change} after a held decision, before binding or dispatch`, async () => {
    let hold: () => Effect.Effect<void, ContractFailure> = noHeldDecision;
    const fixture = await setup(false, false, (boundary) =>
      boundary === "before-approval" ? hold() : Effect.void
    );
    try {
      const receipt = await submit(fixture);
      const approval = {
        ...approvalFor(receipt.runId),
        approverId: undefined,
        expiresAt: Date.now() + (change === "expiry" ? 200 : 10_000),
      };
      await persistPendingApproval(fixture, approval);
      hold = () =>
        change === "expiry"
          ? Effect.sleep(250)
          : Effect.sync(() => {
              fixture.authority.setDecision(
                change === "revocation"
                  ? {
                      decision: "deny",
                      policyVersion: "fixture-v2",
                      reason: "Approval access was revoked",
                    }
                  : { decision: "allow", policyVersion: "fixture-v2" }
              );
            });
      assert.equal(
        (
          await failure(
            fixture.service.approve(
              {
                address,
                approvalId: approval.id,
                context: allowedContext,
                decision: "allow",
                runId: receipt.runId,
                type: "approve",
              },
              options()
            )
          )
        )._tag,
        "Denied"
      );
      assert.equal(fixture.store.domain().approvals[0]?.state, "pending");
      const persisted = await Effect.runPromise(
        fixture.store.service.recover(address, options())
      );
      assert.equal(persisted[0]?.approvals[0]?.approverId, undefined);
      assert.equal(fixture.engine.counts.approve, 0);
      assert.equal(fixture.store.domain().outputs.length, 0);
    } finally {
      await fixture.close();
    }
  });
}

test("queued withdrawal preserves an active approval; active Stop settles its pending controls atomically", async () => {
  const fixture = await setup();
  try {
    const active = await submit(fixture, "approval-owner");
    const queued = await submit(fixture, "queued-input");
    const approval = approvalFor(active.runId);
    await persistPendingApproval(fixture, approval);
    const cancel = (runId: RunId) =>
      fixture.service.cancel(
        { address, context: allowedContext, runId, type: "cancel" },
        options()
      );
    await Effect.runPromise(cancel(queued.runId));
    assert.equal(fixture.store.domain().approvals[0]?.state, "pending");
    await Effect.runPromise(cancel(active.runId));
    const snapshot = fixture.reopen().domain();
    assert.equal(snapshot.approvals[0]?.state, "cancelled");
    assert.equal(
      snapshot.runs.find((run) => run.runId === active.runId)?.state,
      "cancelled"
    );
    assert.ok(
      fixture
        .reopen()
        .outbox()
        .some(
          (record) =>
            record.update.type === "approval" &&
            record.update.approvalId === approval.id &&
            record.update.state === "cancelled"
        )
    );
    assert.equal(
      (
        await failure(
          fixture.service.approve(
            {
              address,
              approvalId: approval.id,
              context: allowedContext,
              decision: "allow",
              runId: active.runId,
              type: "approve",
            },
            options()
          )
        )
      )._tag,
      "Conflict"
    );
    assert.equal(fixture.engine.counts.approve, 0);
    assert.equal(snapshot.outputs.length, 0);
  } finally {
    await fixture.close();
  }
});

test("durable approval waits bind run and policy; duplicate decisions do not redispatch", async () => {
  const fixture = await setup();
  const controlled = createToolFake(Date.now);
  try {
    const receipt = await submit(fixture);
    const approval = approvalFor(receipt.runId);
    const handoffs = await Effect.runPromise(
      fixture.store.service.recover(address, options())
    );
    await Effect.runPromise(
      fixture.store.service.commit(
        address,
        Math.max(...handoffs.map((item) => item.revision)),
        { approval, runId: receipt.runId, type: "approval" },
        options()
      )
    );
    await Effect.runPromise(
      fixture.project({
        approvalId: approval.id,
        expiresAt: approval.expiresAt,
        operationId: approval.operationId,
        runId: receipt.runId,
        state: "pending",
        type: "approval",
      })
    );
    await Effect.runPromise(
      fixture.project({
        run: { runId: receipt.runId, state: "waiting-for-approval" },
        type: "run",
      })
    );
    assert.equal(fixture.reopen().domain().approvals[0]?.state, "pending");
    const command = {
      address,
      approvalId: approval.id,
      context: allowedContext,
      decision: "allow" as const,
      runId: receipt.runId,
      type: "approve" as const,
    };
    assert.equal(
      (
        await failure(
          fixture.service.approve(
            { ...command, runId: id.run("wrong-run") },
            options()
          )
        )
      )._tag,
      "NotFound"
    );
    await Effect.runPromise(fixture.service.approve(command, options()));
    await Effect.runPromise(fixture.service.approve(command, options()));
    assert.equal(fixture.reopen().domain().approvals[0]?.state, "allowed");
    assert.equal(
      (
        await failure(
          fixture.service.approve({ ...command, decision: "deny" }, options())
        )
      )._tag,
      "Conflict"
    );
    assert.equal(controlled.counts.dispatch, 0);
  } finally {
    await fixture.close();
  }
});

const toolFixture = async (uncertain = false) => {
  const fixture = await setup();
  const receipt = await submit(fixture);
  const receipts = createReceiptFake(Date.now);
  const controlled = createToolFake(Date.now);
  let approved: BoundApproval | undefined;
  const definition = {
    ...unknownOutcomeInvocation.tool,
    connectorFingerprint: id.digest("registered-connector"),
  };
  const executor: ToolExecutor = {
    ...controlled.service,
    execute: (call, capability, effectOptions) =>
      Effect.gen(function* confirmedExecution() {
        // Signed gateway payloads must contain only JSON values for human callers.
        canonicalToolArguments(capability);
        const key = {
          operationId: capability.operationId,
          organizationId: call.organizationId,
        };
        const stored = yield* receipts.service.read(
          key,
          call.context,
          effectOptions
        );
        const dispatched = yield* receipts.service.dispatch(
          key,
          stored.revision,
          approved,
          effectOptions
        );
        assert.equal(dispatched.dispatch, true);
        const execution = yield* controlled.service.execute(
          call,
          capability,
          effectOptions
        );
        if (uncertain) {
          yield* receipts.service.unknown(
            key,
            "Injected loss after dispatch",
            undefined,
            effectOptions
          );
          return yield* Effect.fail(
            new UnknownOutcome({
              operationId: capability.operationId,
              reason: "Injected loss after dispatch",
            })
          );
        }
        yield* receipts.service.recordOutcome(
          key,
          { execution, state: "succeeded" },
          effectOptions
        );
        yield* receipts.service.complete(key, effectOptions);
        return execution;
      }),
  };
  const tools = createPiTools({
    agent,
    approval: (_invocation, approval) =>
      Effect.sync(() => {
        approved = approval;
        return approval;
      }),
    authority: fixture.authority.service,
    deadlineMs: 10_000,
    dependencies: () =>
      Effect.succeed({ sourceIds: [], toolIds: [definition.id] }),
    executor,
    publish: fixture.store.publish,
    receipts: receipts.service,
    resolve: () =>
      Effect.gen(function* resolveFixture() {
        const handoffs = yield* fixture.store.service.recover(
          address,
          options()
        );
        const selected = handoffs.find(
          (item) => item.submission.runId === receipt.runId
        );
        assert.ok(selected);
        return selected;
      }),
    tools: [
      {
        definition,
        description: "Controlled fixture",
        parameters: Type.Object({ ticket: Type.String() }),
      },
    ],
  });
  const [tool] = tools;
  assert.ok(tool);
  const invoke = async (taskId = 1, signal?: AbortSignal) => {
    let memo: unknown;
    const api = {
      callId: "fixture-call",
      memo: (_name: string, candidate: unknown) => {
        if (typeof candidate === "string") {
          memo ??= candidate;
        }
        return Promise.resolve(memo);
      },
      taskId,
    } as unknown as Parameters<typeof tool.execute>[1];
    return await tool.execute({ ticket: "support-1" }, api, piContext(signal));
  };
  return { ...fixture, controlled, executor, invoke, receipt, receipts, tools };
};

test(
  "stalled argument preparation expires before memo, receipt, approval or dispatch",
  { timeout: 1000 },
  async () => {
    const fixture = await setup();
    const receipts = createReceiptFake(Date.now);
    const controlled = createToolFake(Date.now);
    const controller = new AbortController();
    const counts = { approval: 0, claim: 0, memo: 0, prepared: 0 };
    const [registration] = createPiTools({
      agent,
      approval: (_invocation, approval) =>
        Effect.sync(() => {
          counts.approval += 1;
          return approval;
        }),
      authority: fixture.authority.service,
      deadlineMs: 10,
      dependencies: () => Effect.succeed({ sourceIds: [], toolIds: [] }),
      executor: controlled.service,
      publish: fixture.store.publish,
      receipts: {
        ...receipts.service,
        claim: (...args) => {
          counts.claim += 1;
          return receipts.service.claim(...args);
        },
      },
      resolve: () =>
        Effect.fail(
          new InvalidInput({ reason: "Preparation must finish before binding" })
        ),
      tools: [
        {
          definition: {
            ...unknownOutcomeInvocation.tool,
            connectorFingerprint: id.digest("fixture-connector"),
          },
          description: "Stalled preparation",
          parameters: Type.Object({}),
          prepare: () =>
            Effect.sync(() => {
              counts.prepared += 1;
            }).pipe(Effect.andThen(Effect.never)),
        },
      ],
    });
    assert.ok(registration);
    const api = {
      memo: () => {
        counts.memo += 1;
        return Promise.resolve();
      },
    } as unknown as Parameters<typeof registration.execute>[1];
    const invocation = registration.execute(
      {},
      api,
      piContext(controller.signal)
    );
    try {
      const result = await Promise.race([
        invocation.then(
          () => "resolved",
          () => "rejected"
        ),
        Effect.runPromise(Effect.sleep(100)).then(() => "pending"),
      ]);
      assert.equal(result, "rejected");
      assert.deepEqual(counts, { approval: 0, claim: 0, memo: 0, prepared: 1 });
      assert.equal(controlled.counts.dispatch, 0);
      assert.equal(fixture.store.domain().tools.length, 0);
    } finally {
      controller.abort();
      await invocation.catch(() => {});
      await fixture.close();
    }
  }
);

test("Pi registry exposes registered tools only; replay returns a confirmed receipt", async () => {
  const fixture = await toolFixture();
  try {
    assert.deepEqual(
      fixture.tools.map((tool) => tool.name),
      [unknownOutcomeInvocation.tool.id]
    );
    const first = await fixture.invoke();
    const replay = await fixture.invoke();
    assert.deepEqual(first.content, replay.content);
    assert.equal(fixture.controlled.counts.dispatch, 1);
    const { tools } = fixture.store.domain();
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.state, "succeeded");
    assert.deepEqual(tools[0]?.dependencies.toolIds, [
      unknownOutcomeInvocation.tool.id,
    ]);
  } finally {
    await fixture.close();
  }
});

test("uncertain write blocks a new Pi task with the same unresolved intent", async () => {
  const fixture = await toolFixture(true);
  try {
    const first = await fixture.invoke(1);
    const retry = await fixture.invoke(2);
    assert.equal(first.control?.terminate, true);
    assert.equal(retry.control?.terminate, true);
    assert.equal(fixture.controlled.counts.dispatch, 1);
    assert.equal(fixture.store.domain().runs[0]?.state, "unknown-outcome");
    assert.equal(fixture.controlled.counts.reconcile, 0);
  } finally {
    await fixture.close();
  }
});

const confirmedReceiptExecutor = (
  fixture: Awaited<ReturnType<typeof toolFixture>>
): ToolExecutor => ({
  ...fixture.executor,
  reconcile: (operationId, _context, read) =>
    Effect.gen(function* reconcileFixture() {
      const key = { operationId, organizationId: address.organizationId };
      const stored = yield* fixture.receipts.service.read(
        key,
        allowedContext,
        read
      );
      const effect = {
        ...read,
        operationId,
        requestDigest: stored.intent.invocation.argumentDigest,
      };
      const execution = {
        output: "confirmed fixture output",
        providerReceipt: "confirmed-provider-receipt",
      };
      yield* fixture.receipts.service.recordOutcome(
        key,
        { execution, state: "succeeded" },
        effect
      );
      yield* fixture.receipts.service.complete(key, effect);
      return execution;
    }),
});

test("product reconciliation uses confirmed receipts and never redispatches", async () => {
  const fixture = await toolFixture(true);
  const scope = Scope.makeUnsafe();
  const executor = confirmedReceiptExecutor(fixture);
  try {
    await fixture.invoke();
    const [unknown] = fixture.store.domain().tools;
    assert.ok(unknown);
    assert.equal(unknown.state, "unknown-outcome");
    const runtime = await Effect.runPromise(
      Scope.provide(scope)(
        createSessionService({
          ...fixture.dependencies,
          executor,
          receipts: fixture.receipts.service,
        })
      )
    );
    const command = {
      address,
      context: allowedContext,
      operationId: unknown.operationId,
      runId: unknown.runId,
    };
    const resolved = await Effect.runPromise(
      runtime.service.reconcile(command, options())
    );
    assert.equal(resolved.state, "succeeded");
    assert.equal(resolved.output, "confirmed fixture output");
    assert.equal(
      fixture
        .reopen()
        .domain()
        .runs.find((run) => run.runId === unknown.runId)?.state,
      "running"
    );
    assert.deepEqual(
      await Effect.runPromise(runtime.service.reconcile(command, options())),
      resolved
    );
    assert.equal(fixture.controlled.counts.dispatch, 1);
    fixture.authority.setDecision({
      decision: "deny",
      policyVersion: "v2",
      reason: "revoked",
    });
    assert.equal(
      (await failure(runtime.service.reconcile(command, options())))._tag,
      "Denied"
    );
    assert.equal(fixture.controlled.counts.dispatch, 1);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await fixture.close();
  }
});

test("reconciliation completes the run through the repair job after a transient projection failure", async () => {
  const fixture = await toolFixture(true);
  const scope = Scope.makeUnsafe();
  const executor = confirmedReceiptExecutor(fixture);
  try {
    await fixture.invoke();
    const [unknown] = fixture.store.domain().tools;
    assert.ok(unknown);
    const runtime = await Effect.runPromise(
      Scope.provide(scope)(
        createSessionService({
          ...fixture.dependencies,
          executor,
          receipts: fixture.receipts.service,
        })
      )
    );
    const command = {
      address,
      context: allowedContext,
      operationId: unknown.operationId,
      runId: unknown.runId,
    };
    fixture.engine.failProject(
      new Unavailable({ reason: "Content read timed out" })
    );
    const resolved = await Effect.runPromise(
      runtime.service.reconcile(command, options())
    );
    assert.equal(resolved.state, "succeeded");
    const stateOf = () =>
      fixture
        .reopen()
        .domain()
        .runs.find((run) => run.runId === unknown.runId)?.state;
    assert.equal(stateOf(), "running");
    fixture.engine.completeRun(unknown.runId);
    assert.equal(
      await Effect.runPromise(runtime.repairProjection(options())),
      true
    );
    assert.equal(stateOf(), "completed");
    assert.equal(fixture.engine.counts.submit, 1);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await fixture.close();
  }
});

test("reconciliation CAS cannot resume while another tool outcome is unknown", async () => {
  const fixture = await toolFixture(true);
  const scope = Scope.makeUnsafe();
  let injected = false;
  try {
    await fixture.invoke();
    const [unknown] = fixture.store.domain().tools;
    assert.ok(unknown);
    const other = { ...unknown, operationId: "concurrent-uncertain-operation" };
    const store = {
      ...fixture.dependencies.store,
      commit: (...args: Parameters<typeof fixture.dependencies.store.commit>) =>
        Effect.gen(function* injectConcurrentProjection() {
          if (args[2].type === "projected-batch" && !injected) {
            injected = true;
            yield* fixture.store.publish(other.runId, {
              ...other,
              type: "tool",
            });
          }
          return yield* fixture.dependencies.store.commit(...args);
        }),
    };
    const runtime = await Effect.runPromise(
      Scope.provide(scope)(
        createSessionService({
          ...fixture.dependencies,
          executor: confirmedReceiptExecutor(fixture),
          receipts: fixture.receipts.service,
          store,
        })
      )
    );
    const command = {
      address,
      context: allowedContext,
      operationId: unknown.operationId,
      runId: unknown.runId,
    };
    assert.equal(
      (await failure(runtime.service.reconcile(command, options())))._tag,
      "Conflict"
    );
    const resolved = await Effect.runPromise(
      runtime.service.reconcile(command, options())
    );
    assert.equal(resolved.state, "succeeded");
    const snapshot = fixture.reopen().domain();
    assert.equal(snapshot.runs[0]?.state, "unknown-outcome");
    assert.equal(
      snapshot.tools.find((tool) => tool.operationId === other.operationId)
        ?.state,
      "unknown-outcome"
    );
    assert.equal(fixture.controlled.counts.dispatch, 1);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await fixture.close();
  }
});

test("revoked tool authority and aborted invocation dispatch zero effects", async () => {
  const fixture = await toolFixture();
  try {
    fixture.authority.setDecision({
      decision: "deny",
      policyVersion: "v2",
      reason: "revoked",
    });
    await assert.rejects(fixture.invoke());
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(fixture.invoke(2, abort.signal));
    assert.equal(fixture.controlled.counts.dispatch, 0);
  } finally {
    await fixture.close();
  }
});

test("provider guard checks every physical HTTP call, including retries, before dispatch", async () => {
  const faux = fauxProvider();
  const model = faux.getModel();
  let allowed = true;
  let physicalCalls = 0;
  const provider = {
    ...faux.provider,
    streamSimple: (
      _model: typeof model,
      _transcript: unknown,
      readOptions?: { fetch?: typeof fetch; signal?: AbortSignal }
    ) => {
      const stream = createAssistantMessageEventStream();
      const execute = async () => {
        try {
          assert.ok(readOptions?.fetch);
          await readOptions.fetch("https://fixture.invalid/model", {
            signal: readOptions.signal,
          });
          allowed = false;
          await readOptions.fetch("https://fixture.invalid/model", {
            signal: readOptions.signal,
          });
        } catch {
          const error = fauxAssistantMessage("", { stopReason: "error" });
          stream.push({ error, reason: "error", type: "error" });
          stream.end(error);
        }
      };
      void execute();
      return stream;
    },
  };
  const guarded = createControlledProvider({
    authorize: () =>
      allowed
        ? Effect.void
        : Effect.fail(new Denied({ code: "revoked", reason: "Model revoked" })),
    deadlineMs: 1000,
    fetch: () => {
      physicalCalls += 1;
      return Promise.resolve(new Response("fixture"));
    },
    maxInputBytes: 131_072,
    model,
    provider,
  });
  const result = await guarded
    .streamSimple(model, normalizeContext({ messages: [] }))
    .result();
  assert.equal(result.stopReason, "error");
  assert.equal(physicalCalls, 1);
  const denied = await guarded
    .streamSimple(model, normalizeContext({ messages: [] }))
    .result();
  assert.equal(denied.stopReason, "error");
  assert.equal(physicalCalls, 1);
});

test("provider input limit counts UTF-8 bytes before physical dispatch", async () => {
  const faux = fauxProvider();
  const model = faux.getModel();
  for (const body of ["é", "éé"] as const) {
    let physicalCalls = 0;
    const provider = {
      ...faux.provider,
      streamSimple: (
        _model: typeof model,
        _context: unknown,
        readOptions?: { fetch?: typeof fetch; signal?: AbortSignal }
      ) => {
        const stream = createAssistantMessageEventStream();
        const dispatch = async () => {
          try {
            assert.ok(readOptions?.fetch);
            await readOptions.fetch("https://fixture.invalid/model", {
              body,
              method: "POST",
              signal: readOptions.signal,
            });
            stream.end(fauxAssistantMessage("Accepted"));
          } catch {
            stream.end(fauxAssistantMessage("", { stopReason: "error" }));
          }
        };
        void dispatch();
        return stream;
      },
    };
    const guarded = createControlledProvider({
      authorize: () => Effect.void,
      deadlineMs: 1000,
      fetch: () => {
        physicalCalls += 1;
        return Promise.resolve(new Response("fixture"));
      },
      maxInputBytes: 2,
      model,
      provider,
    });
    const result = await guarded
      .streamSimple(model, normalizeContext({ messages: [] }))
      .result();
    assert.equal(physicalCalls, body === "é" ? 1 : 0);
    assert.equal(result.stopReason, body === "é" ? "stop" : "error");
  }
});

test("observer overflow creates a fresh epoch and complete canonical snapshot", async () => {
  const fixture = await setup();
  try {
    const receipt = await submit(fixture);
    const iterator = Stream.toAsyncIterable(
      Stream.scoped(
        fixture.service.stream(
          address,
          allowedContext,
          { accessGeneration: 1 },
          options()
        )
      )
    )[Symbol.asyncIterator]();
    const attached = await iterator.next();
    for (let index = 0; index < 9; index += 1) {
      await Effect.runPromise(
        fixture.project({
          arguments: {},
          dependencies: { sourceIds: [], toolIds: [] },
          effect: "read",
          operationId: id.operation(`tool-${index}`),
          output: index,
          runId: receipt.runId,
          state: "succeeded",
          toolId: id.tool("fixture"),
          toolVersion: "1",
          type: "tool",
        })
      );
    }
    const next = await iterator.next();
    assert.equal(next.value?.type, "snapshot");
    if (next.value?.type === "snapshot") {
      assert.equal(next.value.reason, "overflow");
      assert.equal(next.value.sequence, 0);
      assert.notEqual(next.value.epoch, attached.value?.epoch);
      assert.equal(next.value.snapshot.tools.length, 9);
    }
    await iterator.return?.();
  } finally {
    await fixture.close();
  }
});

test("idle access revocation emits denial, closes observation, and denies protected history", async () => {
  const fixture = await setup();
  try {
    await submit(fixture);
    const iterator = Stream.toAsyncIterable(
      Stream.scoped(
        fixture.service.stream(
          address,
          allowedContext,
          { accessGeneration: 1 },
          options()
        )
      )
    )[Symbol.asyncIterator]();
    await iterator.next();
    fixture.authority.setDecision({
      decision: "deny",
      policyVersion: "v2",
      reason: "revoked",
    });
    const denied = await iterator.next();
    assert.equal(denied.value?.type, "access-denied");
    assert.equal((await iterator.next()).done, true);
    assert.equal(
      (
        await failure(
          fixture.service.inspect(address, allowedContext, options())
        )
      )._tag,
      "Denied"
    );
    assert.equal(fixture.engine.counts.submit, 1);
  } finally {
    await fixture.close();
  }
});

test("current authority denies model attempts and command dispatch without calling the engine", async () => {
  const fixture = await setup();
  try {
    fixture.authority.setAvailable(false);
    assert.equal(
      (
        await failure(
          fixture.service.submit({ event: event(), type: "submit" }, options())
        )
      )._tag,
      "Unavailable"
    );
    assert.equal(fixture.engine.counts.submit, 0);
    const admitted = await Effect.runPromise(
      fixture.store.service.admit(
        { event: event(), type: "submit" },
        agent,
        options()
      )
    );
    assert.equal(
      (
        await failure(
          modelAuthority(
            fixture.authority.service,
            address,
            agent,
            [admitted],
            options()
          )
        )
      )._tag,
      "Unavailable"
    );
    fixture.authority.setAvailable(true);
    fixture.authority.setDecision({
      decision: "deny",
      policyVersion: "v2",
      reason: "model revoked",
    });
    assert.equal(
      (
        await failure(
          modelAuthority(
            fixture.authority.service,
            address,
            agent,
            [admitted],
            options()
          )
        )
      )._tag,
      "Denied"
    );
  } finally {
    await fixture.close();
  }
});

test("unknown effects cannot become successful Stop or replacement", async () => {
  const fixture = await setup();
  try {
    const receipt = await submit(fixture);
    await Effect.runPromise(
      fixture.project({
        run: {
          operationId: id.operation("uncertain"),
          runId: receipt.runId,
          state: "unknown-outcome",
        },
        type: "run",
      })
    );
    assert.equal(
      (
        await failure(
          fixture.service.cancel(
            {
              address,
              context: allowedContext,
              runId: receipt.runId,
              type: "cancel",
            },
            options()
          )
        )
      )._tag,
      "UnknownOutcome"
    );
    assert.equal(
      (
        await failure(
          fixture.service.submit(
            { event: event("R"), mode: "replace", type: "submit" },
            options()
          )
        )
      )._tag,
      "UnknownOutcome"
    );
    assert.equal(fixture.engine.counts.stop, 0);
    assert.equal(fixture.engine.counts.cancel, 0);
    assert.equal(fixture.engine.counts.submit, 1);
  } finally {
    await fixture.close();
  }
});

test("coordinator admits native steering through the frozen engine port", async () => {
  const fixture = await setup();
  try {
    const first = await submit(fixture);
    const steered = await submit(fixture, "B", "steer");
    assert.notEqual(first.runId, steered.runId);
    assert.equal((await submit(fixture, "B", "steer")).replayed, true);
    assert.equal(fixture.engine.counts.submit, 2);
  } finally {
    await fixture.close();
  }
});

test("host Layer preserves admission and projection after the request scope closes", async () => {
  const fixture = await setup();
  const scope = Scope.makeUnsafe();
  try {
    let emit: ((update: DomainUpdate) => void) | undefined;
    let retained: Promise<void> | undefined;
    let commandFinished = false;
    const engine = {
      open: (...args: Parameters<typeof fixture.engine.service.open>) =>
        Effect.map(fixture.engine.service.open(...args), (conversation) => ({
          ...conversation,
          observe: () =>
            Stream.callback<DomainUpdate, ContractFailure>((queue) =>
              Effect.sync(() => {
                emit = (update) => {
                  Queue.offerUnsafe(queue, update);
                };
              })
            ),
          submit: (...submitted: Parameters<typeof conversation.submit>) =>
            Effect.flatMap(Effect.sleep(80), () =>
              conversation.submit(...submitted)
            ),
        })),
    };
    const services = await Effect.runPromise(
      Layer.buildWithScope(
        sessionServiceLayer({
          address,
          agent,
          retainDurableWork: (completion) => {
            retained = (async () => {
              await completion;
              commandFinished = true;
            })();
          },
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ExecutionEngine, engine),
              fixture.store.layer,
              fixture.authority.layer
            )
          )
        ),
        scope
      )
    );
    const runtime = Context.get(services, SessionCoordinator);
    assert.equal(Context.get(services, SessionService), runtime.service);
    const result = await failure(
      Effect.scoped(
        runtime.service.submit(
          { event: event(), type: "submit" },
          { ...options(), deadlineAt: Date.now() + 20 }
        )
      )
    );
    assert.equal(result._tag, "Unavailable");
    assert.ok(retained);
    assert.equal(commandFinished, false);
    await retained;
    assert.equal(commandFinished, true);
    const receipt = await Effect.runPromise(
      fixture.store.service.receipt(
        address,
        event().eventId,
        allowedContext,
        options()
      )
    );
    assert.equal(receipt.runId, id.run("run:A"));
    assert.equal(fixture.engine.counts.submit, 1);
    assert.equal(fixture.engine.counts.release, 0);
    assert.ok(emit);
    emit({
      output: {
        ...answerIdentity(receipt.runId),
        citations: [],
        dependencies: { sourceIds: [], toolIds: [] },
        runId: receipt.runId,
        text: "answer after request scope close",
      },
      type: "canonical-output",
    });
    emit({
      run: {
        completedAt: Date.now(),
        runId: receipt.runId,
        state: "completed",
      },
      type: "run",
    });
    await until(() => fixture.store.domain().runs[0]?.state === "completed");
    assert.equal(
      fixture.store.domain().outputs[0]?.text,
      "answer after request scope close"
    );
    assert.equal(runtime.backgroundFailure(), undefined);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await fixture.close();
  }
});

for (const boundary of ["before-admission", "after-admission"] as const) {
  test(`host lifetime observes command failure at ${boundary} without a caller success`, async () => {
    let retained: Promise<void> | undefined;
    const fixture = await setup(
      false,
      false,
      (current) =>
        current === boundary
          ? Effect.fail(
              new Unavailable({ reason: "Fixture checkpoint failed" })
            )
          : Effect.void,
      (completion) => {
        retained = completion;
      }
    );
    try {
      assert.equal(
        (
          await failure(
            fixture.service.submit(
              { event: event(), type: "submit" },
              options()
            )
          )
        )._tag,
        "Unavailable"
      );
      assert.ok(retained);
      await retained;
      const admitted = boundary === "after-admission" ? 1 : 0;
      assert.equal(fixture.engine.counts.submit, admitted);
      assert.equal(fixture.engine.counts.open, 1);
      assert.equal(
        (
          await Effect.runPromise(
            fixture.store.service.recover(address, options())
          )
        ).length,
        admitted
      );
      if (admitted) {
        const receipt = await Effect.runPromise(
          fixture.store.service.receipt(
            address,
            event().eventId,
            allowedContext,
            options()
          )
        );
        assert.equal(receipt.runId, id.run("run:A"));
      }
    } finally {
      await fixture.close();
    }
  });
}

test("completion during snapshot authorization appears in the snapshot or following committed updates", async () => {
  const fixture = await setup();
  try {
    const receipt = await submit(fixture);
    let reads = 0;
    fixture.setReadHook(() =>
      Effect.gen(function* completeWhileAttaching() {
        reads += 1;
        if (reads === 2) {
          yield* fixture.project({
            output: {
              citations: [],
              dependencies: { sourceIds: [], toolIds: [] },
              ...answerIdentity(receipt.runId),
              runId: receipt.runId,
              text: "answer during attach",
            },
            type: "canonical-output",
          });
          yield* fixture.project({
            run: {
              completedAt: Date.now(),
              runId: receipt.runId,
              state: "completed",
            },
            type: "run",
          });
        }
      })
    );
    const iterator = Stream.toAsyncIterable(
      Stream.scoped(
        fixture.store.service.attach(
          address,
          allowedContext,
          { accessGeneration: 1 },
          options()
        )
      )
    )[Symbol.asyncIterator]();
    const frames = [
      await iterator.next(),
      await iterator.next(),
      await iterator.next(),
      await iterator.next(),
    ];
    assert.ok(
      frames.some(
        (frame) =>
          frame.value?.type === "update" &&
          frame.value.update.type === "run" &&
          frame.value.update.run.state === "completed"
      )
    );
    assert.equal(fixture.engine.counts.submit, 1);
    await iterator.return?.();
  } finally {
    await fixture.close();
  }
});

test("a protected commit during authorization is rechecked before emitting its update", async () => {
  const fixture = await setup();
  try {
    const receipt = await submit(fixture);
    let reads = 0;
    fixture.setReadHook((dependencies) =>
      Effect.gen(function* checkProtectedUpdate() {
        reads += 1;
        if (dependencies.sourceIds.includes(id.source("forbidden"))) {
          return yield* Effect.fail(
            new Denied({ code: "revoked", reason: "Source access revoked" })
          );
        }
        if (reads === 3) {
          yield* fixture.project({
            output: {
              citations: [],
              dependencies: {
                sourceIds: [id.source("forbidden")],
                toolIds: [],
              },
              ...answerIdentity(receipt.runId),
              runId: receipt.runId,
              text: "protected answer",
            },
            type: "canonical-output",
          });
          yield* fixture.project({
            run: {
              completedAt: Date.now(),
              runId: receipt.runId,
              state: "completed",
            },
            type: "run",
          });
        }
      })
    );
    const iterator = Stream.toAsyncIterable(
      Stream.scoped(
        fixture.store.service.attach(
          address,
          allowedContext,
          { accessGeneration: 5 },
          options()
        )
      )
    )[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value?.type, "snapshot");
    let next = await iterator.next();
    if (next.value?.type === "update") {
      assert.equal(next.value.update.type, "execution");
      next = await iterator.next();
    }
    assert.equal(next.value?.type, "access-denied");
    assert.equal((await iterator.next()).done, true);
    assert.equal(fixture.store.observerCount(), 0);
  } finally {
    await fixture.close();
  }
});

test("repeated canonical projection preserves domain revision and outbox identity", async () => {
  const fixture = await setup();
  try {
    const receipt = await submit(fixture);
    const update = {
      output: {
        citations: [],
        dependencies: { sourceIds: [], toolIds: [] },
        ...answerIdentity(receipt.runId),
        runId: receipt.runId,
        text: "one answer",
      },
      type: "canonical-output" as const,
    };
    await Effect.runPromise(fixture.project(update));
    const terminal: DomainUpdate = {
      run: {
        completedAt: Date.now(),
        runId: receipt.runId,
        state: "completed",
      },
      type: "run",
    };
    await Effect.runPromise(fixture.project(terminal));
    const { revision } = fixture.store.domain();
    const outbox = fixture.store.outbox();
    await Effect.runPromise(fixture.project(update));
    await Effect.runPromise(fixture.project(terminal));
    assert.equal(fixture.store.domain().revision, revision);
    assert.deepEqual(fixture.store.outbox(), outbox);
  } finally {
    await fixture.close();
  }
});

test("Pi observer binds delayed text to native run inputs and detaches without Stop", async () => {
  const fixture = await setup();
  const scope = Scope.makeUnsafe();
  try {
    const first = await submit(fixture, "A");
    const second = await submit(fixture, "B");
    const handoffs = await Effect.runPromise(
      fixture.store.service.recover(address, options())
    );
    const [a, b] = handoffs;
    assert.ok(a && b);
    // Public Pi protocol fixture: storage is already ahead of the delayed A batch.
    const records = [
      {
        answer: 3,
        conversationId: 1,
        entry: 1,
        id: 1,
        requestId: "A",
        status: "done",
        type: "input",
      },
      {
        conversationId: 1,
        entry: 2,
        id: 2,
        requestId: "B",
        status: "placed",
        type: "input",
      },
    ] as unknown as readonly SubmissionRecord[];
    let listener:
      | ((events: readonly AgentEvent[]) => Promise<void>)
      | undefined;
    let stopped = 0;
    let aborted = 0;
    const closed = Promise.withResolvers<{ reason: "stopped" }>();
    const native = {
      closed: closed.promise,
      snapshot: { run: { inputs: [1] } },
      // oxlint-disable-next-line promise/prefer-await-to-callbacks -- Pi's published start(listener) API registers the delivery callback.
      start: (callback: (events: readonly AgentEvent[]) => Promise<void>) => {
        listener = callback;
      },
      stop: () => {
        stopped += 1;
        closed.resolve({ reason: "stopped" });
        return closed.promise;
      },
    } as unknown as AgentEventStream;
    const session = {
      abort: () => {
        aborted += 1;
        return Promise.resolve(true);
      },
      events: () => Promise.resolve(native),
      wait: () => Promise.resolve({ status: "done", text: "A canonical" }),
    };
    const engine = createPiExecutionEngine({
      address,
      agent,
      content: () =>
        Effect.succeed({
          citations: [],
          dependencies: { sourceIds: [], toolIds: [] },
        }),
      handoffs: () => Effect.succeed(handoffs),
      harness: {
        pi: () =>
          Promise.resolve({
            root: () => Promise.resolve({ id: 1 }),
            snapshot: () => Promise.resolve({ run: { inputs: [2] } }),
          }),
        session: () => session,
      } as unknown as PiEngineConfiguration["harness"],
      snapshot: fixture.store.domain,
      storage: () => ({
        submissionByRequest: (_conversationId: number, requestId: string) =>
          Promise.resolve(
            records.find((record) => record.requestId === requestId)
          ),
      }),
    });
    const conversation = await Effect.runPromise(
      Scope.provide(scope)(engine.service.open(address, agent, options()))
    );
    const iterator = Stream.toAsyncIterable(
      Stream.scoped(
        conversation.observe({ deadlineAt: Number.MAX_SAFE_INTEGER })
      )
    )[Symbol.asyncIterator]();
    const initial = [];
    for (let index = 0; index < 5; index += 1) {
      initial.push((await iterator.next()).value);
    }
    assert.ok(initial.some((value) => value?.type === "canonical-output"));
    assert.ok(listener);
    await listener([
      { message: fauxAssistantMessage("A"), type: "message_start" },
    ]);
    let firstText = await iterator.next();
    while (firstText.value && firstText.value.type !== "provisional-text") {
      firstText = await iterator.next();
    }
    assert.ok(firstText.value?.type === "provisional-text");
    assert.equal(firstText.value.text, "A");
    assert.equal(firstText.value.runId, first.runId);
    await listener([
      {
        changes: [
          { contentIndex: 0, delta: " delayed text", type: "text_delta" },
        ],
        type: "message_update",
        usage: fauxAssistantMessage("").usage,
      },
    ]);
    let delta = await iterator.next();
    while (delta.value && delta.value.type !== "provisional-text") {
      delta = await iterator.next();
    }
    assert.equal(delta.value?.type, "provisional-text");
    assert.ok(delta.value && delta.value.type === "provisional-text");
    assert.equal(delta.value.text, " delayed text");
    assert.equal(delta.value.runId, first.runId);
    assert.notEqual(delta.value.runId, second.runId);
    await iterator.return?.();
    assert.equal(stopped, 1);
    assert.equal(aborted, 0);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await fixture.close();
  }
});

const nativeSteeringFixture = async () => {
  let controlledExecution: ToolRegistration["execute"] | undefined;
  const context = piContext();
  const firstStarted = Promise.withResolvers<boolean>();
  const secondStarted = Promise.withResolvers<boolean>();
  const firstGate = Promise.withResolvers<boolean>();
  const secondGate = Promise.withResolvers<boolean>();
  const provider = fauxProvider({ tokensPerSecond: 1_000_000 });
  let modelCalls = 0;
  let toolCalls = 0;
  let steeredInputPresent = false;
  provider.setResponses([
    async (_transcript, callOptions) => {
      modelCalls += 1;
      firstStarted.resolve(true);
      callOptions?.signal?.addEventListener(
        "abort",
        () => firstGate.resolve(true),
        { once: true }
      );
      await firstGate.promise;
      return fauxAssistantMessage(
        fauxToolCall("mapping_round", {}, { id: "mapping-tool-call" }),
        { stopReason: "toolUse" }
      );
    },
    async (transcript, callOptions) => {
      modelCalls += 1;
      steeredInputPresent = transcript.messages.some(
        (message) =>
          message.role === "user" && message.content === "steered instructions"
      );
      secondStarted.resolve(true);
      callOptions?.signal?.addEventListener(
        "abort",
        () => secondGate.resolve(true),
        { once: true }
      );
      await secondGate.promise;
      return fauxAssistantMessage("one native answer");
    },
  ]);
  const registry = createRegistry();
  registry.install({
    name: "native-mapping-fixture",
    tools: [
      {
        description: "Harmless gated native steering mapping probe",
        execute: (args, api, toolContext) => {
          toolCalls += 1;
          if (controlledExecution) {
            return controlledExecution(args, api, toolContext);
          }
          return Promise.resolve({
            content: [{ text: "mapping tool result", type: "text" as const }],
          });
        },
        name: "mapping_round",
        parameters: Type.Object({}),
        replay: "safe",
      },
    ],
  });
  const models = createModels();
  models.setProvider(provider.provider);
  const storage = new MemoryStorage();
  const pi = await Harness.open(
    storage,
    { models, registry, settings: { followUpMode: "one-at-a-time" } },
    context
  );
  const model = provider.getModel();
  const root = await pi.root(context, {
    agent: { model: { modelId: model.id, provider: model.provider } },
  });
  return {
    close: async () => {
      firstGate.resolve(true);
      secondGate.resolve(true);
      await pi.close(context);
    },
    context,
    firstGate,
    firstStarted,
    modelCalls: () => modelCalls,
    pi,
    root,
    secondGate,
    secondStarted,
    setToolExecution: (execute: typeof controlledExecution) => {
      controlledExecution = execute;
    },
    steeredInputPresent: () => steeredInputPresent,
    storage,
    toolCalls: () => toolCalls,
  };
};

test(
  "native Pi identity evidence: steer transitions queued to placed and shares one answer EntryId",
  { timeout: 5000 },
  async (context) => {
    const fixture = await nativeSteeringFixture();
    const { pi, root, storage } = fixture;
    let events: AgentEvent[] = [];
    const stream = await watchEvents(pi, root.id, fixture.context);
    stream.start((batch) => {
      events = [...events, ...batch];
      return Promise.resolve();
    });
    try {
      const first = await root.submit(
        { content: "initial instructions", requestId: "A", type: "input" },
        fixture.context
      );
      await fixture.firstStarted.promise;
      const initial = await pi.snapshot(LiveDoc, root.id, fixture.context);
      assert.ok(initial?.run);
      const firstPlaced = await first.status(fixture.context);
      assert.equal(firstPlaced.status, "placed");
      const steered = await root.submit(
        {
          content: "steered instructions",
          requestId: "B",
          type: "input",
          whenBusy: "steer",
        },
        fixture.context
      );
      const queued = await steered.status(fixture.context);
      assert.equal(queued.status, "queued");
      assert.equal(queued.entry, undefined);
      assert.equal(queued.answer, undefined);
      fixture.firstGate.resolve(true);
      await fixture.secondStarted.promise;
      const joined = await pi.snapshot(LiveDoc, root.id, fixture.context);
      assert.ok(joined?.run);
      assert.deepEqual(joined.run.inputs, [first.id, steered.id]);
      assert.notEqual(joined.run.taskId, initial.run.taskId);
      const steeredPlaced = await steered.status(fixture.context);
      assert.equal(steeredPlaced.status, "placed");
      assert.equal(steeredPlaced.id, queued.id);
      assert.ok(
        firstPlaced.type === "input" && firstPlaced.status === "placed"
      );
      assert.ok(
        steeredPlaced.type === "input" && steeredPlaced.status === "placed"
      );
      assert.notEqual(firstPlaced.entry, steeredPlaced.entry);
      fixture.secondGate.resolve(true);
      const [doneA, doneB] = await Promise.all([
        first.wait(fixture.context),
        steered.wait(fixture.context),
      ]);
      assert.ok(doneA.type === "input" && doneA.status === "done");
      assert.ok(doneB.type === "input" && doneB.status === "done");
      assert.equal(doneA.answer, doneB.answer);
      assert.equal(doneA.id, first.id);
      assert.equal(doneB.id, steered.id);
      assert.equal(doneA.entry, firstPlaced.entry);
      assert.equal(doneB.entry, steeredPlaced.entry);
      const answer = await storage.entry(
        root.id,
        doneA.answer,
        fixture.context
      );
      assert.equal(answer?.entry.model?.[0]?.role, "assistant");
      await root.waitForIdle(fixture.context);
      const reconnect = await watchEvents(pi, root.id, fixture.context);
      await reconnect.stop();
      const readBack = await storage.submissionByRequest(
        root.id,
        "B",
        fixture.context
      );
      assert.deepEqual(readBack, doneB);
      assert.equal(fixture.modelCalls(), 2);
      assert.equal(fixture.toolCalls(), 1);
      assert.equal(fixture.steeredInputPresent(), true);
      assert.equal(
        events.filter((nativeEvent) => nativeEvent.type === "run_start").length,
        1
      );
      assert.ok(
        events.some(
          (nativeEvent) =>
            nativeEvent.type === "submission" &&
            nativeEvent.record.id === steered.id &&
            nativeEvent.record.status === "placed"
        )
      );
      context.diagnostic(
        JSON.stringify({
          done: [doneA, doneB],
          evidence: "native Pi public API identity mapping",
          initialRun: initial.run,
          joinedRun: joined.run,
          modelCalls: fixture.modelCalls(),
          nativeRunStarts: events.filter(
            (nativeEvent) => nativeEvent.type === "run_start"
          ).length,
          placed: [firstPlaced, steeredPlaced],
          queuedB: queued,
          reconnectModelCalls: fixture.modelCalls(),
          toolCalls: fixture.toolCalls(),
        })
      );
    } finally {
      await stream.stop();
      await fixture.close();
    }
  }
);

test(
  "native Pi Stop identity evidence: placed steer stops every joined request and queued follow-up",
  { timeout: 5000 },
  async (context) => {
    const fixture = await nativeSteeringFixture();
    const { pi, root } = fixture;
    try {
      const first = await root.submit(
        { content: "initial instructions", requestId: "A", type: "input" },
        fixture.context
      );
      await fixture.firstStarted.promise;
      const steered = await root.submit(
        {
          content: "steered instructions",
          requestId: "B",
          type: "input",
          whenBusy: "steer",
        },
        fixture.context
      );
      fixture.firstGate.resolve(true);
      await fixture.secondStarted.promise;
      const joined = await pi.snapshot(LiveDoc, root.id, fixture.context);
      const queued = await root.submit(
        {
          content: "queued follow-up",
          requestId: "C",
          type: "input",
          whenBusy: "followUp",
        },
        fixture.context
      );
      assert.equal((await queued.status(fixture.context)).status, "queued");
      // This is the published PiSession.abort(operationId) sequence for a placed input.
      const withdrawal = await pi.abortSubmission(
        steered.id,
        fixture.context,
        root.id
      );
      assert.equal(withdrawal, "already_placed");
      await root.abort(fixture.context);
      const stopped = await Promise.all([
        first.wait(fixture.context),
        steered.wait(fixture.context),
        queued.wait(fixture.context),
      ]);
      for (const record of stopped) {
        assert.equal(record.status, "unanswered");
        assert.equal(record.reason, "aborted");
        assert.equal(record.answer, undefined);
      }
      assert.deepEqual(
        stopped.map((record) => record.requestId),
        ["A", "B", "C"]
      );
      assert.deepEqual(
        stopped.map((record) => record.id),
        [first.id, steered.id, queued.id]
      );
      assert.equal(
        (await pi.snapshot(LiveDoc, root.id, fixture.context))?.run,
        undefined
      );
      assert.equal(fixture.modelCalls(), 2);
      assert.equal(fixture.toolCalls(), 1);
      assert.equal(fixture.steeredInputPresent(), true);
      context.diagnostic(
        JSON.stringify({
          affected: stopped,
          evidence: "native Pi public API Stop mapping",
          joinedRun: joined?.run,
          modelCalls: fixture.modelCalls(),
          stopTarget: steered.id,
          toolCalls: fixture.toolCalls(),
        })
      );
    } finally {
      await fixture.close();
    }
  }
);

test("contract-fake admission adapter timing is measured separately from host performance", async (context) => {
  const fixture = await setup();
  try {
    const samples: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const started = performance.now();
      await submit(fixture, `timing-${index}`);
      samples.push(performance.now() - started);
    }
    const ordered = samples.toSorted((left, right) => left - right);
    context.diagnostic(
      JSON.stringify({
        engineSubmissions: fixture.engine.counts.submit,
        mode: "SQLite adapter with frozen engine fake",
        p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1],
        samplesMs: samples,
      })
    );
    assert.equal(fixture.engine.counts.submit, 20);
  } finally {
    await fixture.close();
  }
});

// Public PiSession protocol delegates to the installed Harness APIs. Lifecycle
// and celld alarm/eviction behavior remain separate host qualification checks.
const joinedAdapterFixture = async (
  prepareInput?: PiEngineConfiguration["prepareInput"]
) => {
  const native = await nativeSteeringFixture();
  const fixture = await setup(false, true);
  let submissions = 0;
  let aborts = 0;
  let observers = 0;
  let maximumObservers = 0;
  let retainedProjections = 0;
  const projectionFailures: ContractFailure[] = [];
  const projectionRepairs: Result.Result<boolean, ContractFailure>[] = [];
  let automaticProjection = false;
  let repairCopies = 1;
  let onProjectionFailure: ((failure: ContractFailure) => void) | undefined;
  const enqueue = async (
    text: string,
    operationId: string,
    whenBusy: "followUp" | "steer"
  ) => {
    submissions += 1;
    const prior = await native.storage.submissionByRequest(
      native.root.id,
      operationId,
      native.context
    );
    await native.root.submit(
      { content: text, requestId: operationId, type: "input", whenBusy },
      native.context
    );
    return { accepted: !prior, operationId, session: String(native.root.id) };
  };
  const session = {
    abort: async (requestId?: string) => {
      aborts += 1;
      if (!requestId) {
        await native.root.abort(native.context);
        return true;
      }
      const record = await native.storage.submissionByRequest(
        native.root.id,
        requestId,
        native.context
      );
      if (!record) {
        return false;
      }
      const result = await native.pi.abortSubmission(
        record.id,
        native.context,
        native.root.id
      );
      if (result === "already_placed") {
        await native.root.abort(native.context);
      }
      return result !== "settled" && result !== "not_found";
    },
    events: async (context: Parameters<typeof watchEvents>[2]) => {
      const stream = await watchEvents(native.pi, native.root.id, context);
      observers += 1;
      maximumObservers = Math.max(maximumObservers, observers);
      const { stop } = stream;
      stream.stop = async () => {
        observers -= 1;
        return await stop.call(stream);
      };
      return stream;
    },
    steer: (text: string, input: { operationId: string }) =>
      enqueue(text, input.operationId, "steer"),
    submit: (text: string, input: { operationId: string }) =>
      enqueue(text, input.operationId, "followUp"),
    wait: async (requestId: string, signal?: AbortSignal) => {
      const context = piContext(signal);
      const record = await native.storage.submissionByRequest(
        native.root.id,
        requestId,
        context
      );
      assert.ok(record);
      const handle = await native.pi.submission(record.id, context);
      assert.ok(handle);
      const done = await handle.wait(context);
      assert.ok(done.type === "input" && done.status === "done");
      const entry = await native.storage.entry(
        native.root.id,
        done.answer,
        context
      );
      const text = (entry?.entry.model ?? [])
        .flatMap((message) =>
          message.role === "assistant"
            ? message.content.flatMap((part) =>
                part.type === "text" ? [part.text] : []
              )
            : []
        )
        .join("");
      return {
        operationId: requestId,
        session: String(native.root.id),
        status: "done" as const,
        text,
      };
    },
  };
  let hostScope = Scope.makeUnsafe();
  let runtime: SessionCoordinatorRuntime;
  const makeRuntime = async () => {
    const engine = createPiExecutionEngine({
      address,
      agent,
      content: () =>
        Effect.succeed({
          citations: [],
          dependencies: { sourceIds: [], toolIds: [] },
        }),
      handoffs: () => fixture.store.service.recover(address, options()),
      harness: {
        pi: () => Promise.resolve(native.pi),
        session: () => session,
      } as unknown as PiEngineConfiguration["harness"],
      prepareInput,
      snapshot: fixture.store.domain,
      storage: () => native.storage,
    });
    const services = await Effect.runPromise(
      Layer.buildWithScope(
        sessionServiceLayer({
          address,
          agent,
          onProjectionFailure: (error) =>
            Effect.gen(function* triggerAutomaticProjection() {
              projectionFailures.push(error);
              onProjectionFailure?.(error);
              if (automaticProjection && error._tag === "Unavailable") {
                const repair = Effect.gen(function* repairWithoutCommand() {
                  yield* Effect.sleep(10);
                  projectionRepairs.push(
                    yield* Effect.result(runtime.repairProjection(options()))
                  );
                });
                for (let copy = 0; copy < repairCopies; copy += 1) {
                  yield* Effect.forkIn(hostScope)(repair);
                }
              }
            }),
          retainProjection: () =>
            Effect.sync(() => {
              retainedProjections += 1;
            }),
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              engine.layer,
              fixture.store.layer,
              fixture.authority.layer
            )
          )
        ),
        hostScope
      )
    );
    return Context.get(services, SessionCoordinator);
  };
  runtime = await makeRuntime();
  return {
    ...fixture,
    aborts: () => aborts,
    close: async () => {
      await Effect.runPromise(Scope.close(hostScope, Exit.void));
      await native.close();
      await fixture.close();
    },
    crashProjection: async () => {
      await Effect.runPromise(Scope.close(hostScope, Exit.void));
    },
    enableAutomaticProjection: (
      onFailure?: typeof onProjectionFailure,
      copies = 1
    ) => {
      automaticProjection = true;
      onProjectionFailure = onFailure;
      repairCopies = copies;
    },
    maximumObservers: () => maximumObservers,
    native,
    projectionFailures,
    projectionRepairs,
    restartProjection: async (recover = true) => {
      await Effect.runPromise(Scope.close(hostScope, Exit.void));
      fixture.reopenDatabase();
      hostScope = Scope.makeUnsafe();
      runtime = await makeRuntime();
      if (recover) {
        await Effect.runPromise(runtime.recover());
      }
    },
    retainedProjections: () => retainedProjections,
    runtime: () => runtime,
    submissions: () => submissions,
    submitNative: async (name: string, text: string, mode?: "steer") =>
      await Effect.runPromise(
        runtime.service.submit(
          {
            event: {
              ...event(name),
              event: { payload: { text }, type: "user.message" },
            },
            mode,
            type: "submit",
          },
          options()
        )
      ),
  };
};
for (const scenario of [
  "denied approval",
  "expired approval",
  "cancelled approval",
  "no dispatch",
  "confirmed failed receipt",
  "uncertain dispatch",
] as const) {
  test(
    `native ${scenario} settles product tools from confirmed dispatch evidence`,
    { timeout: 5000 },
    async () => {
      const fixture = await joinedAdapterFixture();
      const receipts = createReceiptFake(Date.now);
      const tool = {
        connectorFingerprint: id.digest("fixture-digest"),
        connectorId: "fixture-connector",
        effect: "read" as const,
        id: id.tool("mapping_round"),
        version: "1",
      };
      let physicalDispatches = 0;
      const executor: ToolExecutor = {
        execute: (call, capability, effectOptions) =>
          Effect.gen(function* failControlledTool() {
            if (scenario === "no dispatch") {
              return yield* Effect.fail(
                new Unavailable({ reason: "Failed before dispatch" })
              );
            }
            const key = {
              operationId: capability.operationId,
              organizationId: call.organizationId,
            };
            const receipt = yield* receipts.service.read(
              key,
              call.context,
              effectOptions
            );
            const claimed = yield* receipts.service.dispatch(
              key,
              receipt.revision,
              undefined,
              effectOptions
            );
            assert.equal(claimed.dispatch, true);
            physicalDispatches += 1;
            if (scenario === "uncertain dispatch") {
              return yield* Effect.fail(
                new Unavailable({ reason: "Lost after dispatch" })
              );
            }
            yield* receipts.service.recordOutcome(
              key,
              { reason: "Provider confirmed failure", state: "failed" },
              effectOptions
            );
            yield* receipts.service.complete(key, effectOptions);
            return yield* Effect.fail(
              new Denied({
                code: "unauthorized",
                reason: "Provider confirmed failure",
              })
            );
          }),
        reconcile: (operationId) =>
          Effect.fail(
            new UnknownOutcome({ operationId, reason: "No provider evidence" })
          ),
      };
      const [registration] = createPiTools({
        agent: { ...agent, enabledToolIds: [tool.id] },
        approval: (_invocation, approval) => {
          if (scenario === "cancelled approval") {
            return Effect.never;
          }
          return scenario === "denied approval"
            ? Effect.fail(
                new Denied({ code: "revoked", reason: "Approval denied" })
              )
            : Effect.succeed({ ...approval, expiresAt: Date.now() - 1 });
        },
        authority: fixture.authority.service,
        deadlineMs: 1000,
        dependencies: () =>
          Effect.succeed({ sourceIds: [], toolIds: [tool.id] }),
        executor,
        publish: fixture.store.publish,
        receipts: receipts.service,
        resolve: () =>
          fixture.store.service
            .recover(address, options())
            .pipe(
              Effect.flatMap((values) =>
                values[0]
                  ? Effect.succeed(values[0])
                  : Effect.fail(
                      new InvalidInput({ reason: "Missing test input" })
                    )
              )
            ),
        tools: [
          {
            definition: tool,
            description: "Failure settlement",
            parameters: Type.Object({}),
            requiresApproval: scenario.includes("approval"),
          },
        ],
      });
      assert.ok(registration);
      fixture.native.setToolExecution(registration.execute);
      try {
        const submitted = await fixture.submitNative(
          "A",
          "initial instructions"
        );
        await fixture.native.firstStarted.promise;
        fixture.native.firstGate.resolve(true);
        fixture.native.secondGate.resolve(true);
        if (scenario === "cancelled approval") {
          await until(
            () =>
              fixture.store.domain().tools[0]?.state === "waiting-for-approval"
          );
          await Effect.runPromise(
            fixture.runtime().service.cancel(
              {
                address,
                context: allowedContext,
                runId: submitted.runId,
                type: "cancel",
              },
              options()
            )
          );
        }
        await fixture.native.root.waitForIdle(fixture.native.context);
        const uncertain = scenario === "uncertain dispatch";
        await until(
          () =>
            fixture.store.domain().tools[0]?.state ===
            (uncertain ? "unknown-outcome" : "failed")
        );
        const cancelled = scenario === "cancelled approval";
        if (!uncertain && !cancelled) {
          await until(() => fixture.store.domain().outputs.length === 1);
        }
        const native = await fixture.native.storage.submissionByRequest(
          fixture.native.root.id,
          "A",
          fixture.native.context
        );
        let expectedRunState = "completed";
        if (uncertain) {
          expectedRunState = "unknown-outcome";
        } else if (cancelled) {
          expectedRunState = "cancelled";
        }
        assert.equal(
          fixture.store
            .domain()
            .runs.find((run) => run.runId === submitted.runId)?.state,
          expectedRunState
        );
        assert.equal(
          fixture.store.domain().outputs.length,
          uncertain || cancelled ? 0 : 1
        );
        assert.equal(
          physicalDispatches,
          scenario === "confirmed failed receipt" || uncertain ? 1 : 0
        );
        assert.equal(
          fixture.reopen().domain().tools[0]?.state,
          uncertain ? "unknown-outcome" : "failed"
        );
        assert.equal(fixture.runtime().backgroundFailure(), undefined);
        if (!uncertain && !cancelled) {
          assert.equal(native?.status, "done");
        }
      } finally {
        await fixture.close();
      }
    }
  );
}

const placeJoined = async (
  fixture: Awaited<ReturnType<typeof joinedAdapterFixture>>
) => {
  const first = await fixture.submitNative("A", "initial instructions");
  await fixture.native.firstStarted.promise;
  const initial = await fixture.native.pi.snapshot(
    LiveDoc,
    fixture.native.root.id,
    fixture.native.context
  );
  const second = await fixture.submitNative(
    "B",
    "steered instructions",
    "steer"
  );
  await until(() => fixture.store.domain().executions[0]?.runIds.length === 1);
  fixture.native.firstGate.resolve(true);
  await fixture.native.secondStarted.promise;
  await until(() => fixture.store.domain().executions[0]?.runIds.length === 2);
  const joined = await fixture.native.pi.snapshot(
    LiveDoc,
    fixture.native.root.id,
    fixture.native.context
  );
  assert.notEqual(initial?.run?.taskId, joined?.run?.taskId);
  assert.deepEqual(fixture.store.domain().executions, [
    {
      executionId: id.execution(`execution:${first.runId}`),
      runIds: [first.runId, second.runId],
    },
  ]);
  return [first, second] as const;
};

test(
  "prepared input reaches native submit and steer before acceptance",
  { timeout: 5000 },
  async () => {
    const prepared: string[] = [];
    const fixture = await joinedAdapterFixture((handoff) => {
      const text = handoff.submission.event.event;
      assert.equal(text.type, "user.message");
      if (text.type !== "user.message") {
        return Effect.fail(
          new InvalidInput({ reason: "Expected user message" })
        );
      }
      prepared.push(text.payload.text);
      return Effect.succeed(`${text.payload.text}\nProtected source evidence`);
    });
    try {
      const first = await fixture.submitNative("A", "initial instructions");
      await fixture.native.firstStarted.promise;
      const second = await fixture.submitNative(
        "B",
        "steered instructions",
        "steer"
      );
      fixture.native.firstGate.resolve(true);
      await fixture.native.secondStarted.promise;
      for (const [runId, original] of [
        [first.runId, "initial instructions"],
        [second.runId, "steered instructions"],
      ] as const) {
        const handoff = (
          await Effect.runPromise(
            fixture.store.service.recover(address, options())
          )
        ).find((value) => value.submission.runId === runId);
        assert.ok(handoff);
        const record = await fixture.native.storage.submissionByRequest(
          fixture.native.root.id,
          handoff.submission.requestId,
          fixture.native.context
        );
        assert.ok(record?.type === "input" && record.entry);
        const entry = await fixture.native.storage.entry(
          fixture.native.root.id,
          record.entry,
          fixture.native.context
        );
        assert.equal(
          entry?.entry.model?.[0]?.content,
          `${original}\nProtected source evidence`
        );
      }
      fixture.native.secondGate.resolve(true);
      await until(() => fixture.store.domain().outputs.length === 1);
      await fixture.submitNative("B", "steered instructions", "steer");
      assert.deepEqual(prepared, [
        "initial instructions",
        "steered instructions",
      ]);
      assert.equal(fixture.submissions(), 2);
      assert.deepEqual(
        fixture.store.domain().userMessages.map((message) => message.text),
        prepared
      );
    } finally {
      await fixture.close();
    }
  }
);

test(
  "public Pi adapter joins steering into one SQLite answer; retry and reconnect submit zero work",
  { timeout: 5000 },
  async (context) => {
    const fixture = await joinedAdapterFixture();
    try {
      const [first, second] = await placeJoined(fixture);
      fixture.native.secondGate.resolve(true);
      await until(() =>
        fixture.store.domain().runs.every((run) => run.state === "completed")
      );
      const snapshot = fixture.store.domain();
      assert.equal(snapshot.outputs.length, 1);
      assert.equal(snapshot.outputs[0]?.text, "one native answer");
      assert.deepEqual(snapshot.outputs[0]?.runIds, [
        first.runId,
        second.runId,
      ]);
      assert.equal(snapshot.outputs[0]?.runId, first.runId);
      assert.equal(snapshot.userMessages.length, 2);
      const answerRecords = fixture.store
        .outbox()
        .filter((record) => record.update.type === "canonical-output");
      assert.equal(answerRecords.length, 1);
      const terminalRecords = fixture.store
        .outbox()
        .filter(
          (record) =>
            record.update.type === "run" &&
            record.update.run.state === "completed"
        );
      assert.equal(terminalRecords.length, 2);
      assert.equal(
        terminalRecords[0]?.revision,
        (answerRecords[0]?.revision ?? 0) + 1
      );
      assert.equal(
        terminalRecords[1]?.revision,
        (answerRecords[0]?.revision ?? 0) + 2
      );
      const { revision } = snapshot;
      assert.equal(
        (await fixture.submitNative("B", "steered instructions", "steer"))
          .replayed,
        true
      );
      await Effect.runPromise(fixture.runtime().recover());
      const iterator = Stream.toAsyncIterable(
        Stream.scoped(
          fixture
            .runtime()
            .service.stream(
              address,
              allowedContext,
              { accessGeneration: 2, afterRevision: revision },
              options()
            )
        )
      )[Symbol.asyncIterator]();
      const attached = await iterator.next();
      assert.equal(attached.value?.type, "snapshot");
      if (attached.value?.type === "snapshot") {
        assert.deepEqual(attached.value.snapshot.outputs, snapshot.outputs);
      }
      await iterator.return?.();
      assert.equal(fixture.store.domain().revision, revision);
      assert.equal(fixture.submissions(), 2);
      assert.equal(fixture.native.modelCalls(), 2);
      assert.equal(fixture.native.toolCalls(), 1);
      assert.equal(fixture.native.steeredInputPresent(), true);
      context.diagnostic(
        JSON.stringify({
          answer: snapshot.outputs[0],
          evidence: "public Pi adapter with SQLite projection",
          logicalRuns: snapshot.runs,
          modelCalls: fixture.native.modelCalls(),
          reconnectResubmissions: 0,
          submissions: fixture.submissions(),
        })
      );
    } finally {
      await fixture.close();
    }
  }
);

test(
  "placed steering Stop projects every joined run and the withdrawn queued input",
  { timeout: 5000 },
  async () => {
    const fixture = await joinedAdapterFixture();
    try {
      const [first, second] = await placeJoined(fixture);
      const queued = await fixture.submitNative("C", "queued follow-up");
      const stopped = await Effect.runPromise(
        fixture.runtime().service.cancel(
          {
            address,
            context: allowedContext,
            runId: second.runId,
            type: "cancel",
          },
          options()
        )
      );
      assert.equal(stopped.state, "cancelled");
      const snapshot = fixture.store.domain();
      assert.deepEqual(
        snapshot.runs.map((run) => run.runId).toSorted(),
        [first.runId, second.runId, queued.runId].toSorted()
      );
      assert.ok(snapshot.runs.every((run) => run.state === "cancelled"));
      assert.deepEqual(snapshot.executions[0]?.runIds, [
        first.runId,
        second.runId,
      ]);
      assert.equal(snapshot.outputs.length, 0);
      assert.equal(fixture.submissions(), 3);
    } finally {
      await fixture.close();
    }
  }
);

test(
  "native completion repairs SQLite projection after scope loss and database reopen without resubmission",
  { timeout: 5000 },
  async () => {
    const fixture = await joinedAdapterFixture();
    try {
      const first = await fixture.submitNative("A", "initial instructions");
      await fixture.native.firstStarted.promise;
      const second = await fixture.submitNative(
        "B",
        "steered instructions",
        "steer"
      );
      await until(
        () => fixture.store.domain().executions[0]?.runIds.length === 1
      );
      await fixture.crashProjection();
      fixture.native.firstGate.resolve(true);
      await fixture.native.secondStarted.promise;
      fixture.native.secondGate.resolve(true);
      await fixture.native.root.waitForIdle(fixture.native.context);
      assert.equal(fixture.store.domain().outputs.length, 0);
      assert.equal(fixture.store.domain().executions[0]?.runIds.length, 1);
      await fixture.restartProjection();
      await until(() =>
        fixture.store.domain().runs.every((run) => run.state === "completed")
      );
      const repaired = fixture.store.domain();
      assert.equal(repaired.outputs.length, 1);
      assert.deepEqual(repaired.outputs[0]?.runIds, [
        first.runId,
        second.runId,
      ]);
      await fixture.restartProjection();
      assert.deepEqual(fixture.store.domain().outputs, repaired.outputs);
      assert.equal(fixture.submissions(), 2);
      assert.equal(fixture.native.modelCalls(), 2);
    } finally {
      await fixture.close();
    }
  }
);

const joinedBatch = (
  first: RunId,
  second: RunId
): readonly [DomainUpdate, ...DomainUpdate[]] => [
  {
    execution: {
      executionId: id.execution(`execution:${first}`),
      runIds: [first, second],
    },
    type: "execution",
  },
  {
    output: {
      ...answerIdentity(first, [first, second]),
      citations: [],
      dependencies: { sourceIds: [], toolIds: [] },
      runId: first,
      text: "atomic joined answer",
    },
    type: "canonical-output",
  },
  { run: { completedAt: 123, runId: first, state: "completed" }, type: "run" },
  { run: { completedAt: 123, runId: second, state: "completed" }, type: "run" },
];

test("SQLite projected batches roll back late validation and save failures; observers see only committed joined state", async () => {
  const fixture = await setup();
  try {
    const first = await submit(fixture);
    const second = await submit(fixture, "B", "steer");
    const updates = joinedBatch(first.runId, second.runId);
    const before = fixture.store.domain();
    const outbox = fixture.store.outbox();
    const commit = (batch: readonly [DomainUpdate, ...DomainUpdate[]]) =>
      fixture.store.service.commit(
        address,
        fixture.store.domain().revision,
        { runId: first.runId, type: "projected-batch", updates: batch },
        options()
      );
    const invalid: readonly [DomainUpdate, ...DomainUpdate[]] = [
      ...updates,
      {
        run: { endedAt: 123, runId: id.run("unadmitted"), state: "cancelled" },
        type: "run",
      },
    ];
    assert.equal((await failure(commit(invalid)))._tag, "NotFound");
    assert.deepEqual(fixture.store.domain(), before);
    assert.deepEqual(fixture.store.outbox(), outbox);
    const iterator = Stream.toAsyncIterable(
      Stream.scoped(
        fixture.store.service.attach(
          address,
          allowedContext,
          { accessGeneration: 1 },
          options()
        )
      )
    )[Symbol.asyncIterator]();
    await iterator.next();
    const { save } = fixture.persistence;
    fixture.persistence.save = (json) => {
      save(json);
      throw new Error("Injected SQLite post-write failure");
    };
    assert.equal((await failure(commit(updates)))._tag, "Unavailable");
    fixture.persistence.save = save;
    assert.deepEqual(fixture.store.domain(), before);
    assert.deepEqual(fixture.store.outbox(), outbox);
    let authorizedFinal = 0;
    fixture.setReadHook(() =>
      Effect.sync(() => {
        const snapshot = fixture.store.domain();
        if (snapshot.outputs.length) {
          assert.ok(snapshot.runs.every((run) => run.state === "completed"));
          authorizedFinal += 1;
        }
      })
    );
    await Effect.runPromise(commit(updates));
    const after = fixture.store.domain();
    assert.equal(after.revision, before.revision + updates.length);
    for (let index = 0; index < updates.length; index += 1) {
      const frame = await iterator.next();
      assert.ok(frame.value?.type === "update");
      assert.equal(frame.value.revision, before.revision + index + 1);
      assert.deepEqual(frame.value.update, updates[index]);
    }
    assert.ok(authorizedFinal >= 4);
    await iterator.return?.();
    const handoffs = await Effect.runPromise(
      fixture.store.service.recover(address, options())
    );
    assert.ok(
      handoffs.every(
        (handoff) =>
          handoff.run.state === "completed" &&
          handoff.projectedRevision === after.revision &&
          handoff.revision === after.revision
      )
    );
    const committedOutbox = fixture.store.outbox();
    await Effect.runPromise(commit(updates));
    assert.deepEqual(fixture.store.domain(), after);
    assert.deepEqual(fixture.store.outbox(), committedOutbox);
    const changed = updates.map((update) =>
      update.type === "canonical-output"
        ? {
            ...update,
            output: { ...update.output, text: "changed final answer" },
          }
        : update
    ) as unknown as readonly [DomainUpdate, ...DomainUpdate[]];
    assert.equal((await failure(commit(changed)))._tag, "Conflict");
    assert.equal(
      (
        await failure(
          commit([
            {
              execution: {
                executionId: id.execution(`execution:${first.runId}`),
                runIds: [first.runId],
              },
              type: "execution",
            },
          ])
        )
      )._tag,
      "Conflict"
    );
    assert.equal(
      (
        await failure(
          commit([
            {
              execution: {
                executionId: id.execution("other-execution"),
                runIds: [second.runId],
              },
              type: "execution",
            },
          ])
        )
      )._tag,
      "Conflict"
    );
    assert.deepEqual(fixture.store.domain(), after);
    assert.deepEqual(fixture.store.outbox(), committedOutbox);
  } finally {
    await fixture.close();
  }
});

test("SQLite rejects incomplete, unknown-tool, and ephemeral joined completion batches without mutation", async () => {
  const fixture = await setup();
  try {
    const first = await submit(fixture);
    const second = await submit(fixture, "B", "steer");
    const updates = joinedBatch(first.runId, second.runId);
    const commit = (batch: readonly [DomainUpdate, ...DomainUpdate[]]) =>
      fixture.store.service.commit(
        address,
        fixture.store.domain().revision,
        { runId: first.runId, type: "projected-batch", updates: batch },
        options()
      );
    const before = fixture.store.domain();
    assert.equal(
      (await failure(commit([updates[0], ...updates.slice(1, 2)])))._tag,
      "Conflict"
    );
    const tool: DomainUpdate = {
      arguments: {},
      dependencies: { sourceIds: [], toolIds: [] },
      effect: "write",
      operationId: id.operation("unknown-joined-write"),
      output: null,
      runId: second.runId,
      state: "unknown-outcome",
      toolId: id.tool("fixture-write"),
      toolVersion: "1",
      type: "tool",
    };
    assert.equal(
      (await failure(commit([updates[0], tool, ...updates.slice(1)])))._tag,
      "Conflict"
    );
    assert.equal((await failure(commit([...updates, tool])))._tag, "Conflict");
    assert.equal(
      (
        await failure(
          commit([
            updates[0],
            {
              executionId: id.execution(`execution:${first.runId}`),
              runId: first.runId,
              text: "ephemeral",
              type: "provisional-text",
            },
          ])
        )
      )._tag,
      "InvalidInput"
    );
    assert.deepEqual(fixture.store.domain(), before);
    // Confirmed tool ownership remains on B while both logical runs complete.
    await Effect.runPromise(
      commit([
        updates[0],
        { ...tool, output: "confirmed", state: "succeeded" },
        ...updates.slice(1),
      ])
    );
    assert.equal(fixture.store.domain().tools[0]?.runId, second.runId);
    assert.ok(
      fixture.store.domain().runs.every((run) => run.state === "completed")
    );
  } finally {
    await fixture.close();
  }
});

test(
  "unknown write on a joined member blocks native answer completion for every logical run",
  { timeout: 5000 },
  async () => {
    const fixture = await joinedAdapterFixture();
    try {
      const [first, second] = await placeJoined(fixture);
      await Effect.runPromise(
        fixture.store.publish(first.runId, {
          run: {
            operationId: id.operation("uncertain-write"),
            runId: first.runId,
            state: "unknown-outcome",
          },
          type: "run",
        })
      );
      fixture.native.secondGate.resolve(true);
      await fixture.native.root.waitForIdle(fixture.native.context);
      await Effect.runPromise(fixture.runtime().recover());
      const snapshot = fixture.store.domain();
      assert.equal(snapshot.outputs.length, 0);
      assert.equal(
        snapshot.runs.find((run) => run.runId === first.runId)?.state,
        "unknown-outcome"
      );
      assert.notEqual(
        snapshot.runs.find((run) => run.runId === second.runId)?.state,
        "completed"
      );
      assert.equal(fixture.submissions(), 2);
      assert.equal(fixture.runtime().backgroundFailure(), undefined);
    } finally {
      await fixture.close();
    }
  }
);

test(
  "withdrawing a queued steer leaves the primary native execution running and never joins that member",
  { timeout: 5000 },
  async () => {
    const fixture = await joinedAdapterFixture();
    try {
      const first = await fixture.submitNative("A", "initial instructions");
      await fixture.native.firstStarted.promise;
      const second = await fixture.submitNative(
        "B",
        "steered instructions",
        "steer"
      );
      await Effect.runPromise(
        fixture.runtime().service.cancel(
          {
            address,
            context: allowedContext,
            runId: second.runId,
            type: "cancel",
          },
          options()
        )
      );
      assert.equal(
        fixture.store.domain().runs.find((run) => run.runId === first.runId)
          ?.state,
        "running"
      );
      assert.equal(
        fixture.store.domain().runs.find((run) => run.runId === second.runId)
          ?.state,
        "cancelled"
      );
      fixture.native.firstGate.resolve(true);
      await fixture.native.secondStarted.promise;
      fixture.native.secondGate.resolve(true);
      await until(() => fixture.store.domain().outputs.length === 1);
      assert.deepEqual(fixture.store.domain().executions[0]?.runIds, [
        first.runId,
      ]);
      assert.deepEqual(fixture.store.domain().outputs[0]?.runIds, [
        first.runId,
      ]);
      assert.equal(fixture.native.steeredInputPresent(), false);
      assert.equal(fixture.submissions(), 2);
    } finally {
      await fixture.close();
    }
  }
);

test("automatic projection failure hook repairs SQLite canonical output without a command or recover", async () => {
  const fixture = await joinedAdapterFixture();
  const { save } = fixture.persistence;
  try {
    const [first, second] = await placeJoined(fixture);
    fixture.enableAutomaticProjection(() => {
      fixture.persistence.save = save;
    });
    fixture.persistence.save = (json: string) => {
      if (JSON.parse(json).snapshot.outputs.length) {
        throw new Error("Injected canonical persistence failure");
      }
      save(json);
    };
    fixture.native.secondGate.resolve(true);
    await until(
      () =>
        fixture.store.domain().outputs.length === 1 &&
        fixture.projectionRepairs.length === 1
    );
    const snapshot = fixture.store.domain();
    assert.deepEqual(snapshot.executions, [
      {
        executionId: id.execution(`execution:${first.runId}`),
        runIds: [first.runId, second.runId],
      },
    ]);
    assert.equal(snapshot.outputs[0]?.text, "one native answer");
    assert.deepEqual(snapshot.outputs[0]?.runIds, [first.runId, second.runId]);
    assert.equal(
      snapshot.outputs[0]?.executionId,
      snapshot.executions[0]?.executionId
    );
    const native = await fixture.native.storage.submissionByRequest(
      fixture.native.root.id,
      event("A").eventId,
      fixture.native.context
    );
    assert.ok(native?.type === "input" && native.status === "done");
    assert.equal(
      snapshot.outputs[0]?.answerId,
      id.answer(
        JSON.stringify([
          address.organizationId,
          address.sessionId,
          native.answer,
        ])
      )
    );
    assert.ok(snapshot.runs.every((run) => run.state === "completed"));
    assert.equal(fixture.projectionFailures[0]?._tag, "Unavailable");
    assert.equal(fixture.runtime().backgroundFailure(), undefined);
    assert.equal(fixture.retainedProjections(), 2);
    assert.equal(fixture.submissions(), 2);
    assert.equal(fixture.aborts(), 0);
    assert.equal(fixture.native.modelCalls(), 2);
    assert.equal(fixture.native.toolCalls(), 1);
    assert.equal(fixture.maximumObservers(), 1);
    const [repairResult] = fixture.projectionRepairs;
    assert.ok(repairResult);
    assert.ok(Result.isSuccess(repairResult));
  } finally {
    fixture.persistence.save = save;
    await fixture.close();
  }
});

test("repeated automatic projection failure and overlapping repair preserve one observer and exact membership", async () => {
  const fixture = await joinedAdapterFixture();
  const { save } = fixture.persistence;
  let failures = 0;
  try {
    const [first, second] = await placeJoined(fixture);
    fixture.enableAutomaticProjection(() => {
      failures += 1;
      if (failures === 2) {
        fixture.persistence.save = save;
      }
    }, 2);
    fixture.persistence.save = (json: string) => {
      if (JSON.parse(json).snapshot.outputs.length) {
        throw new Error("Injected repeated canonical persistence failure");
      }
      save(json);
    };
    fixture.native.secondGate.resolve(true);
    await until(
      () =>
        fixture.store.domain().outputs.length === 1 &&
        fixture.projectionRepairs.length === 4
    );
    assert.equal(failures, 2);
    assert.deepEqual(fixture.store.domain().outputs[0]?.runIds, [
      first.runId,
      second.runId,
    ]);
    assert.deepEqual(fixture.store.domain().executions[0]?.runIds, [
      first.runId,
      second.runId,
    ]);
    assert.ok(
      fixture.store.domain().runs.every((run) => run.state === "completed")
    );
    assert.equal(fixture.maximumObservers(), 1);
    assert.equal(fixture.runtime().backgroundFailure(), undefined);
    assert.equal(fixture.submissions(), 2);
    assert.equal(fixture.aborts(), 0);
    assert.equal(fixture.native.modelCalls(), 2);
    assert.equal(fixture.native.toolCalls(), 1);
  } finally {
    fixture.persistence.save = save;
    await fixture.close();
  }
});

test("pure projection repair bounds a healthy native wait without dispatch or a false failure", async () => {
  const fixture = await joinedAdapterFixture();
  try {
    await fixture.submitNative("A", "initial instructions");
    await fixture.native.firstStarted.promise;
    assert.equal(
      await Effect.runPromise(
        fixture.runtime().repairProjection({ deadlineAt: Date.now() + 30 })
      ),
      false
    );
    assert.equal(fixture.runtime().backgroundFailure(), undefined);
    assert.equal(fixture.submissions(), 1);
    assert.equal(fixture.aborts(), 0);
    assert.equal(fixture.native.modelCalls(), 1);
    assert.equal(fixture.native.toolCalls(), 0);
    assert.equal(fixture.maximumObservers(), 1);
  } finally {
    await fixture.close();
  }
});

test("pure projection repair preserves terminal Denied and does not automatically retry it", async () => {
  const fixture = await joinedAdapterFixture();
  const { save } = fixture.persistence;
  try {
    await placeJoined(fixture);
    fixture.enableAutomaticProjection();
    fixture.persistence.save = (json: string) => {
      if (JSON.parse(json).snapshot.outputs.length) {
        throw new Denied({
          code: "revoked",
          reason: "Injected projection authorization denial",
        });
      }
      save(json);
    };
    fixture.native.secondGate.resolve(true);
    await until(() => Boolean(fixture.runtime().backgroundFailure()));
    const original = fixture.runtime().backgroundFailure();
    assert.equal(
      (await failure(fixture.runtime().repairProjection(options())))._tag,
      "Denied"
    );
    await Effect.runPromise(Effect.sleep(30));
    assert.equal(fixture.runtime().backgroundFailure(), original);
    assert.equal(fixture.projectionRepairs.length, 0);
    assert.equal(fixture.store.domain().outputs.length, 0);
    assert.equal(fixture.submissions(), 2);
    assert.equal(fixture.aborts(), 0);
    assert.equal(fixture.native.modelCalls(), 2);
    assert.equal(fixture.native.toolCalls(), 1);
  } finally {
    fixture.persistence.save = save;
    await fixture.close();
  }
});

test("recovery restarts failed canonical projection on the same host without resubmission", async () => {
  const fixture = await joinedAdapterFixture();
  const { save } = fixture.persistence;
  try {
    await placeJoined(fixture);
    fixture.persistence.save = (json: string) => {
      if (JSON.parse(json).snapshot.outputs.length) {
        throw new Error("Injected canonical persistence failure");
      }
      save(json);
    };
    fixture.native.secondGate.resolve(true);
    await until(() => Boolean(fixture.runtime().backgroundFailure()));
    assert.equal(fixture.store.domain().outputs.length, 0);
    fixture.persistence.save = save;
    await Effect.runPromise(fixture.runtime().recover());
    await until(() => fixture.store.domain().outputs.length === 1);
    assert.equal(fixture.runtime().backgroundFailure(), undefined);
    assert.equal(fixture.submissions(), 2);
    assert.ok(
      fixture.store.domain().runs.every((run) => run.state === "completed")
    );
  } finally {
    fixture.persistence.save = save;
    await fixture.close();
  }
});

test(
  "Stop persists newly placed membership after lost observation before removing Pi's live execution",
  { timeout: 5000 },
  async () => {
    const fixture = await joinedAdapterFixture();
    try {
      const first = await fixture.submitNative("A", "initial instructions");
      await fixture.native.firstStarted.promise;
      const second = await fixture.submitNative(
        "B",
        "steered instructions",
        "steer"
      );
      await until(
        () => fixture.store.domain().executions[0]?.runIds.length === 1
      );
      await fixture.crashProjection();
      fixture.native.firstGate.resolve(true);
      await fixture.native.secondStarted.promise;
      assert.equal(fixture.store.domain().executions[0]?.runIds.length, 1);
      await fixture.restartProjection(false);
      await Effect.runPromise(
        fixture.runtime().service.cancel(
          {
            address,
            context: allowedContext,
            runId: second.runId,
            type: "cancel",
          },
          options()
        )
      );
      assert.deepEqual(fixture.store.domain().executions[0]?.runIds, [
        first.runId,
        second.runId,
      ]);
      assert.ok(
        fixture.store.domain().runs.every((run) => run.state === "cancelled")
      );
      assert.equal(fixture.runtime().backgroundFailure(), undefined);
      assert.equal(fixture.submissions(), 2);
    } finally {
      await fixture.close();
    }
  }
);

test(
  "fast native progress establishes execution identity before projection and completes once",
  { timeout: 5000 },
  async () => {
    const fixture = await joinedAdapterFixture();
    try {
      fixture.native.firstGate.resolve(true);
      fixture.native.secondGate.resolve(true);
      const first = await fixture.submitNative("A", "initial instructions");
      await until(() => fixture.store.domain().outputs.length === 1);
      assert.deepEqual(fixture.store.domain().outputs[0]?.runIds, [
        first.runId,
      ]);
      assert.equal(fixture.store.domain().runs[0]?.state, "completed");
      assert.equal(fixture.runtime().backgroundFailure(), undefined);
      assert.equal(fixture.submissions(), 1);
      assert.equal(fixture.native.modelCalls(), 2);
    } finally {
      await fixture.close();
    }
  }
);

test("durable audit redacts content and retries the same event after sink acknowledgement loss", async () => {
  const fixture = await setup(false, true);
  try {
    const receipt = await submit(fixture);
    await Effect.runPromise(
      fixture.project({
        arguments: { secret: "private-tool-arguments" },
        dependencies: { sourceIds: [], toolIds: ["fixture"] },
        effect: "read",
        operationId: id.operation("audit-tool"),
        output: "private-tool-output",
        runId: receipt.runId,
        state: "succeeded",
        toolId: id.tool("fixture"),
        toolVersion: "1",
        type: "tool",
      })
    );
    await Effect.runPromise(
      fixture.project({
        output: {
          ...answerIdentity(receipt.runId),
          citations: [
            {
              observedAt: Date.now(),
              sourceId: id.source("audit-source"),
              sourceUri: "private-source-uri",
              sourceVersion: "1",
            },
          ],
          dependencies: {
            sourceIds: [id.source("audit-source")],
            toolIds: ["fixture"],
          },
          runId: receipt.runId,
          text: "private-canonical-output",
        },
        type: "canonical-output",
      })
    );
    await Effect.runPromise(
      fixture.project({
        run: {
          completedAt: Date.now(),
          runId: receipt.runId,
          state: "completed",
        },
        type: "run",
      })
    );
    const before = fixture.store.outbox();
    const delivered: AuditProjection[] = [];
    const sink = (value: AuditProjection) =>
      Effect.sync(() => {
        delivered.push(value);
      });
    const lostAck = {
      ...fixture.store,
      acknowledgeOutbox: () =>
        Effect.fail(
          new Unavailable({ reason: "Storage acknowledgement interrupted" })
        ),
    };
    assert.equal(
      (await failure(drainAuditProjection(address, lostAck, sink)))._tag,
      "Unavailable"
    );
    assert.deepEqual(fixture.store.outbox(), before);
    fixture.reopenDatabase();
    const reopened = fixture.reopen();
    assert.deepEqual(reopened.outbox(), before);
    await Effect.runPromise(drainAuditProjection(address, reopened, sink));
    assert.deepEqual(delivered[0], delivered[1]);
    assert.equal(
      new Set(delivered.map((value) => value.eventId)).size,
      before.length
    );
    assert.deepEqual(reopened.outbox(), []);
    for (const secret of [
      "private-tool-arguments",
      "private-tool-output",
      "private-source-uri",
      "private-canonical-output",
      userEvent.event.text,
    ]) {
      assert.equal(JSON.stringify(delivered).includes(secret), false);
    }
    assert.ok(
      delivered.some(
        (value) =>
          value.name === "run" &&
          JSON.stringify(value.payload).includes("completed")
      )
    );
    assert.equal(fixture.engine.counts.submit, 1);
  } finally {
    await fixture.close();
  }
});

test("audit delivery records a denied run independently of transcript permissions", async () => {
  const fixture = await setup();
  try {
    const receipt = await submit(fixture);
    await Effect.runPromise(
      fixture.project({
        run: {
          endedAt: Date.now(),
          runId: receipt.runId,
          state: "failed",
        },
        type: "run",
      })
    );
    fixture.setReadHook(() =>
      Effect.fail(new Denied({ code: "revoked", reason: "Source revoked" }))
    );
    assert.equal(
      (
        await failure(
          fixture.store.service.snapshot(address, allowedContext, options())
        )
      )._tag,
      "Denied"
    );
    const delivered: AuditProjection[] = [];
    await Effect.runPromise(
      drainAuditProjection(address, fixture.store, (value) =>
        Effect.sync(() => {
          delivered.push(value);
        })
      )
    );
    assert.ok(
      delivered.some(
        (value) =>
          value.name === "run" &&
          JSON.stringify(value.payload).includes("failed")
      )
    );
    assert.deepEqual(fixture.store.outbox(), []);
  } finally {
    await fixture.close();
  }
});

test("ephemeral text and unpersisted audit timestamps cannot reach the sink", () => {
  assert.throws(
    () =>
      auditProjection(address, {
        id: "partial",
        occurredAt: Date.now(),
        revision: 1,
        update: {
          ...answerIdentity(id.run("run:audit")),
          runId: id.run("run:audit"),
          text: "private",
          type: "provisional-text",
        },
      }),
    InvalidInput
  );
  assert.throws(
    () =>
      auditProjection(address, {
        id: "missing-time",
        occurredAt: Number.NaN,
        revision: 1,
        update: {
          run: { runId: id.run("run:audit"), state: "running" },
          type: "run",
        },
      }),
    InvalidInput
  );
});

test("source-denied submission leaves no command for later recovery", async () => {
  const fixture = await setup();
  try {
    const first = await submit(fixture);
    await Effect.runPromise(
      fixture.project({
        arguments: {},
        dependencies: { sourceIds: [id.source("revoked-source")], toolIds: [] },
        effect: "read",
        operationId: id.operation("retained-source"),
        output: "protected source",
        runId: first.runId,
        state: "succeeded",
        toolId: id.tool("fixture"),
        toolVersion: "1",
        type: "tool",
      })
    );
    const before = fixture.store.domain();
    const admissions = await Effect.runPromise(
      fixture.store.service.recover(address, options())
    );
    fixture.setReadHook((content) =>
      content.sourceIds.includes(id.source("revoked-source"))
        ? Effect.fail(new Denied({ code: "revoked", reason: "Source revoked" }))
        : Effect.void
    );
    assert.equal(
      (
        await failure(
          fixture.service.submit(
            { event: event("denied-followup"), type: "submit" },
            options()
          )
        )
      )._tag,
      "Denied"
    );
    assert.deepEqual(fixture.store.domain(), before);
    assert.deepEqual(
      await Effect.runPromise(
        fixture.store.service.recover(address, options())
      ),
      admissions
    );
    assert.equal(fixture.engine.counts.submit, 1);
    const receipt = await Effect.runPromise(
      fixture.store.service.receipt(
        address,
        event().eventId,
        allowedContext,
        options()
      )
    );
    assert.equal(receipt.runId, first.runId);
    fixture.setReadHook(() => Effect.void);
    await Effect.runPromise(fixture.recover());
    assert.deepEqual(
      await Effect.runPromise(
        fixture.store.service.recover(address, options())
      ),
      admissions
    );
    assert.equal(fixture.engine.counts.submit, 1);
  } finally {
    await fixture.close();
  }
});

test("an audit job batch leaves remaining events durable for the next wake", async () => {
  const fixture = await setup();
  try {
    await submit(fixture);
    const before = fixture.store.outbox();
    assert.ok(before.length > 1);
    const delivered: AuditProjection[] = [];
    await Effect.runPromise(
      drainAuditProjection(
        address,
        fixture.store,
        (value) =>
          Effect.sync(() => {
            delivered.push(value);
          }),
        1
      )
    );
    assert.equal(delivered.length, 1);
    assert.deepEqual(fixture.store.outbox(), before.slice(1));
    assert.deepEqual(fixture.reopen().outbox(), before.slice(1));
  } finally {
    await fixture.close();
  }
});

test("receipt metadata checks current owner access without exposing revoked content", async () => {
  const fixture = await setup();
  try {
    const submitted = await submit(fixture);
    fixture.setReadHook(() =>
      Effect.fail(
        new Denied({
          code: "revoked",
          reason: "Retained prepared source revoked",
        })
      )
    );
    const store = createSessionStore(fixture.persistence, {
      ...fixture.storeConfiguration,
      authorizeMetadata: (context, read) =>
        fixture.authority.service
          .require(
            {
              action: "read",
              address,
              context,
              pinnedAgent: agent,
              resource: {
                id: address.agentId,
                kind: "agent",
                organizationId: address.organizationId,
              },
            },
            read
          )
          .pipe(Effect.asVoid),
    });
    assert.equal(
      (
        await failure(
          store.service.snapshot(address, allowedContext, options())
        )
      )._tag,
      "Denied"
    );
    assert.deepEqual(
      await Effect.runPromise(
        store.service.receipt(
          address,
          event().eventId,
          allowedContext,
          options()
        )
      ),
      { ...submitted, replayed: true }
    );
    fixture.authority.setAvailable(false);
    assert.equal(
      (
        await failure(
          store.service.receipt(
            address,
            event().eventId,
            allowedContext,
            options()
          )
        )
      )._tag,
      "Unavailable"
    );
    assert.equal(fixture.engine.counts.submit, 1);
  } finally {
    await fixture.close();
  }
});

test("snapshot authorization preserves same-revision deltas that arrive after capture", async () => {
  const fixture = await setup();
  const entered = Promise.withResolvers<null>();
  const release = Promise.withResolvers<null>();
  let iterator: AsyncIterator<Observation> | undefined;
  try {
    const receipt = await submit(fixture);
    await until(() => fixture.store.domain().runs[0]?.state === "running");
    const { executionId } = answerIdentity(receipt.runId);
    await Effect.runPromise(
      fixture.project({
        execution: { executionId, runIds: [receipt.runId] },
        type: "execution",
      })
    );
    const durable = fixture.persistence.load();
    await Effect.runPromise(
      fixture.store.publish(receipt.runId, {
        executionId,
        runId: receipt.runId,
        text: "Prefix",
        type: "provisional-text",
      })
    );
    await Effect.runPromise(
      fixture.store.publish(receipt.runId, {
        executionId,
        runId: receipt.runId,
        text: "Visible",
        type: "provisional-thinking",
      })
    );
    let reads = 0;
    fixture.setReadHook(() =>
      Effect.promise(async () => {
        reads += 1;
        if (reads === 2) {
          entered.resolve(null);
          await release.promise;
        }
      })
    );
    iterator = Stream.toAsyncIterable(
      Stream.scoped(
        fixture.store.service.attach(
          address,
          allowedContext,
          { accessGeneration: 0 },
          options()
        )
      )
    )[Symbol.asyncIterator]();
    const pending = iterator.next();
    await entered.promise;
    await Effect.runPromise(
      fixture.store.publish(receipt.runId, {
        executionId,
        runId: receipt.runId,
        text: " suffix",
        type: "provisional-text",
      })
    );
    release.resolve(null);
    const initial = await pending;
    assert.equal(initial.value?.type, "snapshot");
    assert.ok(initial.value?.type === "snapshot");
    assert.deepEqual(initial.value.partial, [
      {
        executionId,
        runId: receipt.runId,
        text: "Prefix",
        thinking: "Visible",
      },
    ]);
    const delta = await iterator.next();
    assert.equal(delta.value?.type, "update");
    assert.ok(delta.value?.type === "update");
    assert.equal(delta.value.revision, initial.value.snapshot.revision);
    assert.equal(delta.value.update.type, "provisional-text");
    assert.ok(delta.value.update.type === "provisional-text");
    assert.equal(delta.value.update.text, " suffix");
    assert.equal(fixture.persistence.load(), durable);
    assert.equal(fixture.engine.counts.submit, 1);
    assert.equal(fixture.engine.counts.cancel, 0);
  } finally {
    release.resolve(null);
    await iterator?.return?.();
    await fixture.close();
  }
});

for (const type of ["provisional-text", "provisional-thinking"] as const) {
  for (const capacity of [1, 2]) {
    test(`overflow snapshot retains ${type} during authorization with capacity ${capacity}`, async () => {
      const fixture = await setup();
      const entered = Promise.withResolvers<null>();
      const release = Promise.withResolvers<null>();
      let iterator: AsyncIterator<Observation> | undefined;
      try {
        const receipt = await submit(fixture);
        await until(() => fixture.store.domain().runs[0]?.state === "running");
        const { executionId } = answerIdentity(receipt.runId);
        await Effect.runPromise(
          fixture.project({
            execution: { executionId, runIds: [receipt.runId] },
            type: "execution",
          })
        );
        const store = createSessionStore(fixture.persistence, {
          ...fixture.storeConfiguration,
          observerCapacity: capacity,
        });
        const durable = fixture.persistence.load();
        const publish = (text: string) =>
          Effect.runPromise(
            store.publish(receipt.runId, {
              executionId,
              runId: receipt.runId,
              text,
              type,
            })
          );
        iterator = Stream.toAsyncIterable(
          Stream.scoped(
            store.service.attach(
              address,
              allowedContext,
              { accessGeneration: 0 },
              options()
            )
          )
        )[Symbol.asyncIterator]();
        const attached = await iterator.next();
        assert.ok(attached.value?.type === "snapshot");
        await publish("Before1");
        await publish("Before2");
        if (capacity === 2) {
          await publish("Before3");
        }
        let captured = false;
        fixture.setReadHook(() =>
          Effect.promise(async () => {
            if (!captured) {
              captured = true;
              entered.resolve(null);
              await release.promise;
            }
          })
        );
        const pending = iterator.next();
        await entered.promise;
        await publish("During");
        release.resolve(null);
        const snapshot = await pending;
        assert.ok(snapshot.value?.type === "snapshot");
        assert.equal(snapshot.value.reason, "overflow");
        const field = type === "provisional-text" ? "text" : "thinking";
        let observed = snapshot.value.partial?.[0]?.[field] ?? "";
        await publish("After");
        while (!observed.endsWith("After")) {
          const next = await iterator.next();
          assert.ok(next.value?.type === "update");
          assert.equal(next.value.update.type, type);
          assert.ok(
            next.value.update.type === "provisional-text" ||
              next.value.update.type === "provisional-thinking"
          );
          observed += next.value.update.text;
        }
        assert.equal(
          observed,
          capacity === 1
            ? "Before1Before2DuringAfter"
            : "Before1Before2Before3DuringAfter"
        );
        assert.equal(fixture.persistence.load(), durable);
        assert.equal(fixture.engine.counts.submit, 1);
        assert.equal(fixture.engine.counts.cancel, 0);
      } finally {
        release.resolve(null);
        await iterator?.return?.();
        await fixture.close();
      }
    });
  }
}
