/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Each assertion follows its preceding durable transition. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Effect } from "effect";
import { z } from "zod";

import type { DurableHandoff } from "../../packages/contracts/src/execution.ts";
import { Denied, InvalidInput } from "../../packages/contracts/src/failures.ts";
import type { ContractFailure } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import type {
  EffectIntent,
  ReceiptOutcome,
} from "../../packages/contracts/src/receipt-service.ts";
import { createAuthorityFake } from "../../packages/contracts/src/testing/effect-fakes.ts";
import {
  allowedContext,
  userEvent,
} from "../../packages/contracts/src/testing/fixtures.ts";
import type { BoundApproval } from "../../packages/contracts/src/tool-service.ts";
import { digestToolArguments } from "../../packages/contracts/src/tools.ts";
import { Type } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { createCelldToolReceiptStore } from "../../packages/runtime/src/celld-tool-receipts.ts";
import type { ToolReceiptSqliteStorage } from "../../packages/runtime/src/celld-tool-receipts.ts";
import { piContext } from "../../packages/runtime/src/pi-harness.ts";
import { createPiTools } from "../../packages/runtime/src/pi-tools.ts";
import { createControlledToolExecutor } from "../../packages/tools/src/broker.ts";
import {
  bindRegisteredTool,
  createToolRegistry,
} from "../../packages/tools/src/registry.ts";

const clock = () => 1_800_000_000_000;
const readOptions = () => ({ deadlineAt: clock() + 10_000 });
const optionsFor = (intent: EffectIntent) => ({
  ...readOptions(),
  operationId: intent.invocation.operationId,
  requestDigest: intent.invocation.argumentDigest,
});
const outcome: ReceiptOutcome = {
  execution: { output: { text: "confirmed" }, providerReceipt: "provider-1" },
  state: "succeeded",
};
const fixture = async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "cerebro-tool-receipts-"));
  const filename = path.join(directory, "receipts.sqlite");
  let database = new DatabaseSync(filename);
  let allowed = true;
  const authorizations: string[] = [];
  const storage: ToolReceiptSqliteStorage = {
    sql: {
      exec<Row extends Record<string, string | number | null>>(
        query: string,
        ...bindings: (string | number | null)[]
      ) {
        const statement = database.prepare(query);
        if (statement.columns().length === 0) {
          statement.run(...bindings);
          return { toArray: (): Row[] => [] };
        }
        return { toArray: () => statement.all(...bindings) as Row[] };
      },
    },
    transactionSync: <A>(run: () => A): A => {
      database.exec("BEGIN");
      try {
        const result = run();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const makeStore = () =>
    createCelldToolReceiptStore(storage, {
      address: userEvent,
      authorize: (receipt) => {
        authorizations.push(receipt.state);
        return allowed
          ? Effect.void
          : Effect.fail(
              new Denied({
                code: "revoked",
                reason: "Current content access revoked",
              })
            );
      },
      now: clock,
    });
  const argumentsValue = { ticket: "ticket-1" };
  const intent: EffectIntent = {
    invocation: {
      agentId: userEvent.agentId,
      argumentDigest: await digestToolArguments(argumentsValue),
      arguments: argumentsValue,
      context: allowedContext,
      operationId: id.operation("operation-1"),
      organizationId: userEvent.organizationId,
      runId: id.run("run-1"),
      state: "requested",
      tool: {
        connectorFingerprint: await digestToolArguments({
          connector: "connector-1",
          version: 1,
        }),
        connectorId: "connector-1",
        effect: "write",
        id: id.tool("tool-1"),
        version: "1",
      },
    },
    policyVersion: "policy-1",
  };
  const approval: BoundApproval = {
    actorPrincipalId: allowedContext.actor.id,
    agentId: intent.invocation.agentId,
    approverId: allowedContext.actor.id,
    argumentDigest: intent.invocation.argumentDigest,
    connectorFingerprint: intent.invocation.tool.connectorFingerprint,
    connectorId: intent.invocation.tool.connectorId,
    effect: "write",
    expiresAt: clock() + 10_000,
    id: "approval-1",
    operationId: intent.invocation.operationId,
    organizationId: intent.invocation.organizationId,
    policyVersion: intent.policyVersion,
    principalId: allowedContext.actor.id,
    runId: intent.invocation.runId,
    toolId: intent.invocation.tool.id,
    toolVersion: intent.invocation.tool.version,
  };
  return {
    approval,
    authorizations,
    close: () => {
      database.close();
      rmSync(directory, { recursive: true });
    },
    intent,
    key: {
      operationId: intent.invocation.operationId,
      organizationId: intent.invocation.organizationId,
    },
    reopen: () => {
      database.close();
      database = new DatabaseSync(filename);
      return makeStore().service;
    },
    service: makeStore().service,
    setAllowed: (value: boolean) => {
      allowed = value;
    },
    storage,
  };
};
const failure = async <A>(
  program: Effect.Effect<A, ContractFailure>
): Promise<ContractFailure> => {
  const result = await Effect.runPromise(Effect.result(program));
  assert.equal(result._tag, "Failure");
  if (result._tag !== "Failure") {
    throw new Error("Expected a typed failure");
  }
  return result.failure;
};

test("SQLite claims compare full immutable intent and simultaneous dispatch has one winner", async () => {
  const f = await fixture();
  try {
    const options = optionsFor(f.intent);
    const claims = await Effect.runPromise(
      Effect.all(
        Array.from({ length: 8 }, () => f.service.claim(f.intent, options)),
        { concurrency: "unbounded" }
      )
    );
    assert.equal(claims.filter((claim) => !claim.replayed).length, 1);
    assert.equal(
      (
        await failure(
          f.service.claim({ ...f.intent, policyVersion: "policy-2" }, options)
        )
      )._tag,
      "Conflict"
    );
    assert.equal(
      (await failure(f.service.dispatch(f.key, 99, f.approval, options)))._tag,
      "Conflict"
    );
    const results = await Effect.runPromise(
      Effect.all(
        Array.from({ length: 8 }, () =>
          f.service.dispatch(f.key, 1, f.approval, options)
        ),
        { concurrency: "unbounded" }
      )
    );
    assert.equal(results.filter((result) => result.dispatch).length, 1);
    assert.ok(
      results.every(
        (result) =>
          result.receipt.state === "dispatched" && result.receipt.revision === 2
      )
    );
    assert.equal(
      (
        await f
          .reopen()
          .read(f.key, allowedContext, readOptions())
          .pipe(Effect.runPromise)
      ).state,
      "dispatched"
    );
  } finally {
    f.close();
  }
});

test("stalled receipt authorization obeys cancellation and caller deadline", async () => {
  const f = await fixture();
  try {
    await Effect.runPromise(f.service.claim(f.intent, optionsFor(f.intent)));
    const started = Promise.withResolvers<boolean>();
    const protectedStore = createCelldToolReceiptStore(f.storage, {
      address: userEvent,
      authorize: () =>
        Effect.callback(() => {
          started.resolve(true);
          return Effect.void;
        }),
    }).service;
    const controller = new AbortController();
    const cancelled = failure(
      protectedStore.read(f.key, allowedContext, {
        deadlineAt: Date.now() + 1000,
        signal: controller.signal,
      })
    );
    await started.promise;
    controller.abort();
    assert.equal((await cancelled)._tag, "Unavailable");
    assert.equal(
      (
        await failure(
          protectedStore.read(f.key, allowedContext, {
            deadlineAt: Date.now() + 20,
          })
        )
      )._tag,
      "Unavailable"
    );
    assert.equal(
      (
        await Effect.runPromise(
          f.service.read(f.key, allowedContext, readOptions())
        )
      ).state,
      "claimed"
    );
  } finally {
    f.close();
  }
});

test("SQLite validates every approval binding before write dispatch", async () => {
  const f = await fixture();
  try {
    const options = optionsFor(f.intent);
    await Effect.runPromise(f.service.claim(f.intent, options));
    const changes: Partial<BoundApproval>[] = [
      { runId: id.run("other-run") },
      { connectorFingerprint: id.digest("other-fingerprint") },
      { operationId: id.operation("other-operation") },
      { argumentDigest: id.digest("other-digest") },
      { organizationId: id.organization("other-company") },
      { actorPrincipalId: id.principal("other-actor") },
      { principalId: id.principal("other-principal") },
      { delegationId: id.delegation("other-delegation") },
      { agentId: id.agent("other-agent") },
      { toolId: id.tool("other-tool") },
      { toolVersion: "2" },
      { connectorId: "other-connector" },
      { policyVersion: "policy-2" },
      { expiresAt: clock() },
    ];
    for (const change of changes) {
      assert.equal(
        (
          await failure(
            f.service.dispatch(f.key, 1, { ...f.approval, ...change }, options)
          )
        )._tag,
        "Denied"
      );
    }
    assert.equal(
      (await failure(f.service.dispatch(f.key, 1, undefined, options)))._tag,
      "Denied"
    );
    assert.equal(
      (
        await Effect.runPromise(
          f.service.read(f.key, allowedContext, readOptions())
        )
      ).state,
      "claimed"
    );
  } finally {
    f.close();
  }
});

test("SQLite unknown writes fence new occurrences and policy changes across reopen until confirmed evidence", async () => {
  const f = await fixture();
  try {
    const options = optionsFor(f.intent);
    await Effect.runPromise(f.service.claim(f.intent, options));
    await Effect.runPromise(f.service.dispatch(f.key, 1, f.approval, options));
    const next: EffectIntent = {
      ...f.intent,
      invocation: {
        ...f.intent.invocation,
        operationId: id.operation("operation-2"),
      },
      policyVersion: "policy-2",
    };
    assert.equal(
      (await failure(f.service.claim(next, optionsFor(next))))._tag,
      "UnknownOutcome"
    );
    await Effect.runPromise(
      f.service.unknown(f.key, "Lost after dispatch", "provider-1", options)
    );
    const reopened = f.reopen();
    assert.equal(
      (await failure(reopened.claim(next, optionsFor(next))))._tag,
      "UnknownOutcome"
    );
    assert.equal(
      (await failure(reopened.complete(f.key, options)))._tag,
      "Conflict"
    );
    const saved = await Effect.runPromise(
      reopened.recordOutcome(f.key, outcome, options)
    );
    assert.equal(saved.state, "outcome");
    const completed = await Effect.runPromise(
      reopened.complete(f.key, options)
    );
    assert.equal(completed.state, "completed");
    assert.equal(
      (await Effect.runPromise(reopened.claim(next, optionsFor(next))))
        .replayed,
      false
    );
    assert.equal(
      (await Effect.runPromise(reopened.complete(f.key, options))).revision,
      completed.revision
    );
    assert.equal(
      (
        await failure(
          reopened.recordOutcome(
            f.key,
            { execution: { output: "changed" }, state: "succeeded" },
            options
          )
        )
      )._tag,
      "Conflict"
    );
    assert.equal(
      (
        await failure(
          reopened.unknown(f.key, "Cannot overwrite", undefined, options)
        )
      )._tag,
      "Conflict"
    );
  } finally {
    f.close();
  }
});

test("SQLite protected receipt replay requires current content access and exact caller ownership", async () => {
  const f = await fixture();
  try {
    const options = optionsFor(f.intent);
    await Effect.runPromise(f.service.claim(f.intent, options));
    await Effect.runPromise(f.service.dispatch(f.key, 1, f.approval, options));
    f.setAllowed(false);
    await Effect.runPromise(f.service.recordOutcome(f.key, outcome, options));
    await Effect.runPromise(f.service.complete(f.key, options));
    assert.equal(
      (await failure(f.service.read(f.key, allowedContext, readOptions())))
        ._tag,
      "Denied"
    );
    assert.equal(
      (await failure(f.service.claim(f.intent, options)))._tag,
      "Denied"
    );
    f.setAllowed(true);
    const foreign = {
      actor: { ...allowedContext.actor, id: id.principal("other-human") },
    };
    assert.equal(
      (await failure(f.service.read(f.key, foreign, readOptions())))._tag,
      "Denied"
    );
    assert.equal(
      (
        await failure(
          f.service.read(
            { ...f.key, organizationId: id.organization("other-company") },
            allowedContext,
            readOptions()
          )
        )
      )._tag,
      "Denied"
    );
    const otherSession = createCelldToolReceiptStore(f.storage, {
      address: { ...userEvent, sessionId: id.session("other-session") },
      authorize: () => Effect.void,
      now: clock,
    }).service;
    assert.equal(
      (await failure(otherSession.read(f.key, allowedContext, readOptions())))
        ._tag,
      "Denied"
    );
    const receipt = await Effect.runPromise(
      f.service.read(f.key, allowedContext, readOptions())
    );
    assert.equal(receipt.state, "completed");
    assert.ok(f.authorizations.includes("completed"));
  } finally {
    f.close();
  }
});

test("Pi prepares arguments before receipt binding and read approvals reach the real controlled executor", async () => {
  const f = await fixture();
  try {
    const registry = createToolRegistry(
      [
        {
          definition: {
            connectorId: "connector-1",
            effect: "read",
            id: id.tool("tool-1"),
            version: "1",
          },
          description: "Approved read",
          input: z.strictObject({ ticket: z.string() }),
          maxInputBytes: 1024,
          maxOutputBytes: 1024,
          normalize: (input) => {
            const parsed = z.strictObject({ ticket: z.string() }).parse(input);
            return { ticket: parsed.ticket.trim() };
          },
          output: z.strictObject({ ticket: z.string() }),
          requiresApproval: true,
          retryMode: "idempotent",
          target: {
            kind: "mcp-read",
            method: "search",
            url: "https://fixture.invalid/mcp",
          },
        },
      ],
      "fixture"
    );
    const entry = registry.get(id.tool("tool-1"));
    assert.ok(entry);
    const tool = await Effect.runPromise(bindRegisteredTool(entry));
    const agent = {
      agentId: userEvent.agentId,
      enabledToolIds: [tool.id],
      grants: [],
      instructions: "Fixture",
      model: "fixture-model",
      organizationId: userEvent.organizationId,
      version: 1,
    };
    const handoff: DurableHandoff = {
      acknowledged: true,
      address: userEvent,
      admittedRevision: 1,
      agentVersion: 1,
      approvals: [],
      engineAccepted: true,
      mode: "follow-up",
      projectedRevision: 1,
      replaceStopped: false,
      revision: 1,
      run: { runId: f.intent.invocation.runId, state: "running" },
      submission: {
        event: userEvent,
        inputDigest: userEvent.payloadDigest,
        mode: "follow-up",
        requestId: userEvent.eventId,
        runId: f.intent.invocation.runId,
      },
    };
    const receipts = createCelldToolReceiptStore(f.storage, {
      address: userEvent,
      authorize: () => Effect.void,
    }).service;
    const authority = createAuthorityFake(Date.now).service;
    let approved: BoundApproval | undefined;
    let dispatches = 0;
    let preparations = 0;
    let approvalRequests = 0;
    const publishedArguments: unknown[] = [];
    const executor = createControlledToolExecutor({
      address: userEvent,
      approval: () => Effect.succeed(approved),
      authority,
      checkApprover: () => Effect.void,
      driver: {
        execute: (call) =>
          Effect.sync(() => {
            dispatches += 1;
            assert.deepEqual(call.arguments, { ticket: "ticket-1" });
            return { output: call.arguments };
          }),
        reconcile: () =>
          Effect.fail(
            new InvalidInput({ reason: "No reconciliation expected" })
          ),
      },
      pinnedAgent: agent,
      receipts,
      registry,
    });
    const [registration] = createPiTools({
      agent,
      approval: (_invocation, approval) =>
        Effect.sync(() => {
          approvalRequests += 1;
          approved = approval;
          return approval;
        }),
      authority,
      deadlineMs: 10_000,
      dependencies: () => Effect.succeed({ sourceIds: [], toolIds: [tool.id] }),
      executor,
      publish: (_run, update) =>
        Effect.sync(() => {
          if (update.type === "tool") {
            publishedArguments.push(update.arguments);
          }
        }),
      receipts,
      resolve: () => Effect.succeed(handoff),
      tools: [
        {
          definition: tool,
          description: "Approved read",
          parameters: Type.Object({ ticket: Type.String() }),
          prepare: (args) =>
            Effect.try({
              catch: () =>
                new InvalidInput({ reason: "Invalid fixture arguments" }),
              try: () => {
                preparations += 1;
                return entry.prepareArguments(args);
              },
            }),
          requiresApproval: true,
        },
      ],
    });
    assert.ok(registration);
    const api = {
      callId: "call-1",
      memo: (_name: string, value?: unknown) =>
        Promise.resolve(
          typeof value === "string" ? value : handoff.submission.runId
        ),
      taskId: 1,
    } as unknown as Parameters<typeof registration.execute>[1];
    await registration.execute({ ticket: " ticket-1 " }, api, piContext());
    assert.equal(preparations, 1);
    assert.equal(approvalRequests, 1);
    assert.equal(dispatches, 1);
    assert.ok(
      publishedArguments.every(
        (args) =>
          JSON.stringify(args) === JSON.stringify({ ticket: "ticket-1" })
      )
    );
    await registration.execute({ ticket: " ticket-1 " }, api, piContext());
    assert.equal(approvalRequests, 1);
    assert.equal(dispatches, 1);
  } finally {
    f.close();
  }
});

test("SQLite rolls back failed persistence and rejects invalid outcome or mutation identity", async () => {
  const f = await fixture();
  try {
    const options = optionsFor(f.intent);
    await Effect.runPromise(f.service.claim(f.intent, options));
    await Effect.runPromise(f.service.dispatch(f.key, 1, f.approval, options));
    f.storage.sql.exec(
      "CREATE TRIGGER reject_outcome BEFORE UPDATE ON cerebro_pi_tool_receipts WHEN NEW.state='outcome' BEGIN SELECT RAISE(ABORT, 'injected save failure'); END"
    );
    assert.equal(
      (await failure(f.service.recordOutcome(f.key, outcome, options)))._tag,
      "Unavailable"
    );
    assert.equal(
      (
        await Effect.runPromise(
          f.service.read(f.key, allowedContext, readOptions())
        )
      ).state,
      "dispatched"
    );
    f.storage.sql.exec("DROP TRIGGER reject_outcome");
    assert.equal(
      (
        await failure(
          f.service.recordOutcome(
            f.key,
            { execution: { output: Number.NaN }, state: "succeeded" },
            options
          )
        )
      )._tag,
      "InvalidInput"
    );
    assert.equal(
      (
        await failure(
          f.service.recordOutcome(f.key, outcome, {
            ...options,
            requestDigest: id.digest("different"),
          })
        )
      )._tag,
      "Conflict"
    );
    assert.equal(
      (
        await failure(
          f.service.complete(f.key, { ...options, deadlineAt: clock() })
        )
      )._tag,
      "Unavailable"
    );
    await Effect.runPromise(f.service.recordOutcome(f.key, outcome, options));
    const reopened = f.reopen();
    assert.equal(
      (
        await Effect.runPromise(
          reopened.read(f.key, allowedContext, readOptions())
        )
      ).state,
      "outcome"
    );
    assert.equal(
      (await Effect.runPromise(reopened.complete(f.key, options))).state,
      "completed"
    );
  } finally {
    f.close();
  }
});
