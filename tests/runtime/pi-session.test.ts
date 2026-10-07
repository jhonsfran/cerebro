/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Each assertion inspects its preceding durable transition. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect, Exit, Result, Schema, Scope, Stream } from "effect";

import type { SessionStore } from "../../packages/contracts/src/execution.ts";
import {
  Denied,
  Unavailable,
  UnknownOutcome,
} from "../../packages/contracts/src/failures.ts";
import type { ContractFailure } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import type { RunId } from "../../packages/contracts/src/identity.ts";
import type { ReadOptions } from "../../packages/contracts/src/port.ts";
import { Observation } from "../../packages/contracts/src/session-service.ts";
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
import {
  Type,
  fauxProvider,
  fauxAssistantMessage,
  createAssistantMessageEventStream,
  normalizeContext,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import type {
  AgentEvent,
  AgentEventStream,
  SubmissionRecord,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { createSessionStore } from "../../packages/runtime/src/celld-session-store.ts";
import {
  createPiExecutionEngine,
  modelAuthority,
  piContext,
} from "../../packages/runtime/src/pi-harness.ts";
import type { PiEngineConfiguration } from "../../packages/runtime/src/pi-harness.ts";
import { createControlledProvider } from "../../packages/runtime/src/pi-provider.ts";
import { createPiTools } from "../../packages/runtime/src/pi-tools.ts";
import { createSessionService } from "../../packages/runtime/src/session-service.ts";

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
  outputs: [],
  revision: 0,
  runs: [],
  tools: [],
  userMessages: [],
};
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

const setup = async (useContractStore = false) => {
  let beforeRead:
    | ((
        dependencies: ContentDependencies
      ) => Effect.Effect<void, ContractFailure>)
    | undefined;
  const scope = Scope.makeUnsafe();
  const authority = createAuthorityFake(Date.now);
  const engine = createEngineFake();
  const database = new DatabaseSync(":memory:");
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
    observerCapacity: 2,
  };
  const store = createSessionStore(persistence, storeConfiguration);
  const contractStore = createStoreFake(emptySnapshot);
  const selected = useContractStore ? contractStore.service : store.service;
  const dependencies = {
    address,
    agent,
    authority: authority.service,
    engine: engine.service,
    store: selected,
  };
  const runtime = await Effect.runPromise(
    Scope.provide(scope)(createSessionService(dependencies))
  );
  return {
    ...runtime,
    authority,
    close: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      database.close();
    },
    dependencies,
    engine,
    persistence,
    reopen: () => createSessionStore(persistence, storeConfiguration),
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
  return { ...fixture, controlled, invoke, receipts, tools };
};

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
    for (let index = 0; index < 5; index += 1) {
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
      assert.equal(next.value.snapshot.tools.length, 5);
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

test("native steering fails closed until shared answer identity is frozen", async () => {
  const fixture = await setup();
  try {
    assert.equal(
      (
        await failure(
          fixture.service.submit(
            { event: event(), mode: "steer", type: "submit" },
            options()
          )
        )
      )._tag,
      "Unavailable"
    );
    assert.equal(fixture.engine.counts.submit, 0);
  } finally {
    await fixture.close();
  }
});

test("caller deadline stops waiting while the admitted handoff completes in the host scope", async () => {
  const fixture = await setup();
  const scope = Scope.makeUnsafe();
  try {
    const engine = {
      open: (...args: Parameters<typeof fixture.engine.service.open>) =>
        Effect.map(fixture.engine.service.open(...args), (conversation) => ({
          ...conversation,
          submit: (...submitted: Parameters<typeof conversation.submit>) =>
            Effect.flatMap(Effect.sleep(80), () =>
              conversation.submit(...submitted)
            ),
        })),
    };
    const runtime = await Effect.runPromise(
      Scope.provide(scope)(
        createSessionService({ ...fixture.dependencies, engine })
      )
    );
    const result = await failure(
      runtime.service.submit(
        { event: event(), type: "submit" },
        { ...options(), deadlineAt: Date.now() + 20 }
      )
    );
    assert.equal(result._tag, "Unavailable");
    await Effect.runPromise(Effect.sleep(120));
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
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await fixture.close();
  }
});

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
              runId: receipt.runId,
              text: "protected answer",
            },
            type: "canonical-output",
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
    const next = await iterator.next();
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
        runId: receipt.runId,
        text: "one answer",
      },
      type: "canonical-output" as const,
    };
    await Effect.runPromise(fixture.project(update));
    const { revision } = fixture.store.domain();
    const outbox = fixture.store.outbox();
    await Effect.runPromise(fixture.project(update));
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
        pi: () => Promise.resolve({ root: () => Promise.resolve({ id: 1 }) }),
        session: () => session,
      } as unknown as PiEngineConfiguration["harness"],
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
    const canonical = await iterator.next();
    assert.equal(canonical.value?.type, "canonical-output");
    await iterator.next();
    await iterator.next();
    assert.ok(listener);
    await listener([
      {
        changes: [
          { contentIndex: 0, delta: "A delayed text", type: "text_delta" },
        ],
        type: "message_update",
        usage: fauxAssistantMessage("").usage,
      },
    ]);
    const delta = await iterator.next();
    assert.equal(delta.value?.type, "provisional-text");
    assert.ok(delta.value && delta.value.type === "provisional-text");
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
