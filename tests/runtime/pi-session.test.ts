/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Each assertion inspects its preceding durable transition. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

const setup = async (useContractStore = false, persistent = false) => {
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
      {
        changes: [
          { contentIndex: 0, delta: "A delayed text", type: "text_delta" },
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
        execute: () => {
          toolCalls += 1;
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
const joinedAdapterFixture = async () => {
  const native = await nativeSteeringFixture();
  const fixture = await setup(false, true);
  let submissions = 0;
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
    events: (context: Parameters<typeof watchEvents>[2]) =>
      watchEvents(native.pi, native.root.id, context),
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
      snapshot: fixture.store.domain,
      storage: () => native.storage,
    });
    return await Effect.runPromise(
      Scope.provide(hostScope)(
        createSessionService({
          ...fixture.dependencies,
          engine: engine.service,
        })
      )
    );
  };
  let runtime = await makeRuntime();
  return {
    ...fixture,
    close: async () => {
      await Effect.runPromise(Scope.close(hostScope, Exit.void));
      await native.close();
      await fixture.close();
    },
    crashProjection: async () => {
      await Effect.runPromise(Scope.close(hostScope, Exit.void));
    },
    native,
    restartProjection: async (recover = true) => {
      await Effect.runPromise(Scope.close(hostScope, Exit.void));
      fixture.reopenDatabase();
      hostScope = Scope.makeUnsafe();
      runtime = await makeRuntime();
      if (recover) {
        await Effect.runPromise(runtime.recover());
      }
    },
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
