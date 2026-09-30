import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";

import { id } from "../../packages/contracts/src/identity.ts";
import type { PortResult } from "../../packages/contracts/src/port.ts";
import type { WorkOutcome } from "../../packages/policy/src/authorization-gate.ts";
import type { StoredRun } from "../../packages/runtime/src/ledger.ts";
import { createModelHttpPlugin } from "../../packages/runtime/src/model-http-plugin.ts";
import type {
  ModelHttpReceipt,
  RuntimePorts,
} from "../../packages/runtime/src/runtime-ports.ts";

type HookContext = Parameters<
  ReturnType<typeof createModelHttpPlugin>["setup"]
>[0];
interface HttpEvent {
  request: Request;
  response: Response;
}
const encoder = new TextEncoder();
const token = 'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n';
const usage =
  'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n';
const usageFrame = usage.slice(0, usage.indexOf("data: [DONE]"));
const doneFrame = "data: [DONE]\n\n";
const harness = async (
  options: {
    maximum?: number;
    deadline?: number;
    settlement?: Promise<unknown>;
    accountingResult?: PortResult<ModelHttpReceipt>;
  } = {}
) => {
  const database = new DatabaseSync(":memory:");
  database.exec(
    "CREATE TABLE cerebro_operation(id TEXT PRIMARY KEY, result TEXT NOT NULL)"
  );
  const storage = {
    sql: {
      exec(query: string, ...values: (string | number)[]) {
        const statement = database.prepare(query);
        if (!statement.columns().length) {
          statement.run(...values);
          return { toArray: () => [] };
        }
        return { toArray: () => statement.all(...values) };
      },
    },
    sync: () => Promise.resolve(),
    transactionSync: <Value>(work: () => Value) => work(),
  } as unknown as DurableObjectStorage;
  const run: StoredRun = {
    agent: {
      agentId: id.agent("agent-a"),
      enabledToolIds: [],
      instructions: "Answer the message.",
      model: "provider/model",
      organizationId: id.organization("company-a"),
      version: 1,
    },
    context: {
      actor: {
        id: id.principal("user-a"),
        kind: "human",
        organizationId: id.organization("company-a"),
        state: "active",
      },
    },
    createdAt: Date.now(),
    dependencies: { sourceIds: [], toolIds: [] },
    eventId: id.event("event-a"),
    operationId: id.operation("operation-a"),
    prompt: "Hello",
    requestDigest: id.digest("digest-a"),
    runId: id.run("run-a"),
    state: "running",
  };
  let allowed = true;
  const outcomes: WorkOutcome<ModelHttpReceipt>[] = [];
  const receipts: ModelHttpReceipt[] = [];
  const failures: PortResult<unknown>[] = [];
  const failurePhases: (string | undefined)[] = [];
  const ports = {
    checkDependencies: () =>
      Promise.resolve(
        allowed
          ? { status: "ok", value: undefined }
          : { code: "unauthorized", reason: "Access revoked", status: "denied" }
      ),
    model: {
      apiKey: "test-key",
      baseUrl: "https://provider.example/v1",
      deadlineMs: options.deadline ?? 10_000,
      id: "provider/model",
      maxInputBytes: 4096,
      maxOutputTokens: 100,
      maxRequestsPerRun: 10,
      maxResponseBytes: options.maximum ?? 4096,
      model: "model",
      pricing: {
        inputPerToken: 1,
        outputPerToken: 2,
        unit: "credits",
        version: "1",
      },
      provider: "provider",
    },
    paidModel: {
      run: async (
        _request: unknown,
        _options: unknown,
        work: () => Promise<WorkOutcome<ModelHttpReceipt>>
      ) => {
        const outcome = await work();
        outcomes.push(outcome);
        await options.settlement;
        return options.accountingResult ?? outcome.result;
      },
    },
  } as unknown as RuntimePorts;
  const hooks = new Map<string, (event: HttpEvent) => unknown>();
  const plugin = createModelHttpPlugin({
    failed: (result, phase) => {
      failures.push(result);
      failurePhases.push(phase);
    },
    ports,
    recorded: (_operationId, receipt) => receipts.push(receipt),
    run: () => run,
    storage,
  });
  const dispose = await plugin.setup({
    session: {
      hook: (name: string, hook: (event: HttpEvent) => Promise<void>) => {
        hooks.set(name, hook);
      },
    },
  } as unknown as HookContext);
  let source: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = 0;
  const event: HttpEvent = {
    request: new Request("https://provider.example/v1/chat/completions", {
      body: JSON.stringify({ model: "model", stream: true }),
      method: "POST",
    }),
    response: new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled += 1;
        },
        start(controller) {
          source = controller;
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } }
    ),
  };
  const requestHook = hooks.get("http.request");
  const responseHook = hooks.get("http.response");
  assert.ok(requestHook && responseHook);
  await requestHook(event);
  await responseHook(event);
  return {
    cancelled: () => cancelled,
    close: async () => {
      await dispose?.();
      database.close();
    },
    end: () => source.close(),
    error: (error: Error) => source.error(error),
    failurePhases,
    failures,
    outcomes,
    push: (text: string) => source.enqueue(encoder.encode(text)),
    receipts,
    response: event.response,
    revoke: () => {
      allowed = false;
    },
  };
};

test("model tokens arrive before provider EOF and EOF waits for durable accounting", async () => {
  const settlement = Promise.withResolvers<null>();
  const runtime = await harness({ settlement: settlement.promise });
  try {
    const reader = runtime.response.body?.getReader();
    assert.ok(reader);
    runtime.push(token);
    assert.deepEqual(await reader.read(), {
      done: false,
      value: encoder.encode(token),
    });
    assert.deepEqual(runtime.outcomes, []);
    runtime.push(usageFrame);
    assert.deepEqual(await reader.read(), {
      done: false,
      value: encoder.encode(usageFrame),
    });
    runtime.push(doneFrame);
    runtime.end();
    let ended = false;
    const final = reader.read().then((value) => {
      ended = true;
      return value;
    });
    await setImmediate();
    assert.equal(ended, false);
    assert.deepEqual(runtime.receipts, []);
    assert.equal(runtime.outcomes.length, 1);
    settlement.resolve(null);
    assert.deepEqual(await final, {
      done: false,
      value: encoder.encode(doneFrame),
    });
    assert.deepEqual(await reader.read(), { done: true, value: undefined });
    assert.deepEqual(runtime.receipts, [
      {
        body: token + usage,
        headers: { "Content-Type": "text/event-stream" },
        inputTokens: 3,
        outputTokens: 2,
        status: 200,
        unit: "credits",
        units: 7,
      },
    ]);
    assert.deepEqual(runtime.failures, []);
  } finally {
    settlement.resolve(null);
    await runtime.close();
  }
});

test("an OpenCode consumer can cancel after fragmented DONE with a durable known receipt", async () => {
  const settlement = Promise.withResolvers<null>();
  const runtime = await harness({ settlement: settlement.promise });
  try {
    const reader = runtime.response.body?.getReader();
    assert.ok(reader);
    runtime.push(`${token}${usageFrame}data: [DO`);
    const early = await reader.read();
    assert.equal(new TextDecoder().decode(early.value), token + usageFrame);
    runtime.push("NE]\n\n");
    let delivered = false;
    const terminal = reader.read().then((result) => {
      delivered = true;
      return result;
    });
    await setImmediate();
    assert.equal(delivered, false);
    assert.deepEqual(runtime.outcomes, []);
    runtime.end();
    await setImmediate();
    assert.equal(delivered, false);
    assert.equal(runtime.outcomes[0]?.usage.state, "known");
    settlement.resolve(null);
    const done = await terminal;
    assert.equal(new TextDecoder().decode(done.value), doneFrame);
    assert.equal(runtime.receipts.length, 1);
    await reader.cancel();
    assert.equal(runtime.cancelled(), 0);
    assert.equal(runtime.outcomes.length, 1);
    assert.equal(runtime.outcomes[0]?.usage.state, "known");
    assert.deepEqual(runtime.failures, []);
  } finally {
    await runtime.close();
  }
});

test("cancelled model streaming settles unknown once and cancels the provider", async () => {
  const runtime = await harness();
  try {
    const reader = runtime.response.body?.getReader();
    assert.ok(reader);
    runtime.push(token);
    await reader.read();
    await reader.cancel("The user cancelled.");
    assert.equal(runtime.cancelled(), 1);
    assert.equal(runtime.outcomes.length, 1);
    assert.deepEqual(runtime.outcomes[0].usage, { state: "unknown" });
    assert.equal(runtime.outcomes[0].result.status, "unknown-outcome");
    assert.equal(runtime.failures.length, 1);
    assert.deepEqual(runtime.receipts, []);
  } finally {
    await runtime.close();
  }
  assert.equal(runtime.outcomes.length, 1);
});

test("missing provider usage fails the stream and preserves unknown accounting", async () => {
  const runtime = await harness({
    accountingResult: {
      operationId: id.operation("operation-a:model:1"),
      reason: "Paid usage is unknown. Its maximum remains held.",
      status: "unknown-outcome",
    },
  });
  try {
    runtime.push(token);
    runtime.end();
    await assert.rejects(runtime.response.text(), /authoritative usage/u);
    assert.equal(runtime.outcomes.length, 1);
    assert.deepEqual(runtime.outcomes[0].usage, { state: "unknown" });
    assert.deepEqual(runtime.receipts, []);
    assert.deepEqual(runtime.failurePhases, ["usage-validation"]);
    assert.equal(runtime.failures[0]?.status, "unknown-outcome");
  } finally {
    await runtime.close();
  }
});

test("a response byte bound stops delivery before the excess chunk", async () => {
  const runtime = await harness({ maximum: encoder.encode(token).byteLength });
  try {
    const reader = runtime.response.body?.getReader();
    assert.ok(reader);
    runtime.push(token);
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), token);
    runtime.push(usage);
    await assert.rejects(reader.read(), /byte bound/u);
    assert.equal(runtime.outcomes.length, 1);
    assert.deepEqual(runtime.outcomes[0].usage, { state: "unknown" });
    assert.equal(runtime.cancelled(), 1);
  } finally {
    await runtime.close();
  }
});

test("a stalled provider stream fails on the request deadline", async () => {
  const runtime = await harness({ deadline: 50 });
  try {
    await assert.rejects(runtime.response.text(), /deadline expired/u);
    await setImmediate();
    assert.equal(runtime.outcomes.length, 1);
    assert.deepEqual(runtime.outcomes[0].usage, { state: "unknown" });
    assert.equal(runtime.cancelled(), 1);
  } finally {
    await runtime.close();
  }
});

test("provider transport failure settles unknown without recording a reply", async () => {
  const runtime = await harness();
  try {
    runtime.error(new Error("Provider disconnected"));
    await assert.rejects(runtime.response.text(), /Provider disconnected/u);
    assert.equal(runtime.outcomes.length, 1);
    assert.deepEqual(runtime.outcomes[0].usage, { state: "unknown" });
    assert.deepEqual(runtime.receipts, []);
  } finally {
    await runtime.close();
  }
});

test("current content access is checked before each model chunk leaves the adapter", async () => {
  const runtime = await harness();
  try {
    const reader = runtime.response.body?.getReader();
    assert.ok(reader);
    runtime.push(token);
    await reader.read();
    runtime.revoke();
    runtime.push(usage);
    await assert.rejects(reader.read(), /authorization returned denied/u);
    assert.equal(runtime.cancelled(), 1);
    assert.equal(runtime.outcomes.length, 1);
    assert.deepEqual(runtime.outcomes[0].usage, { state: "unknown" });
    assert.deepEqual(runtime.receipts, []);
  } finally {
    await runtime.close();
  }
});

test("a known provider usage receipt cannot finish the stream after accounting fails", async () => {
  const runtime = await harness({
    accountingResult: {
      operationId: id.operation("operation-a:model:1"),
      reason: "Settlement is unavailable",
      status: "unknown-outcome",
    },
  });
  try {
    runtime.push(token + usage);
    runtime.end();
    await assert.rejects(
      runtime.response.text(),
      /accounting returned unknown-outcome/u
    );
    assert.equal(runtime.outcomes.length, 1);
    assert.deepEqual(runtime.outcomes[0].usage, {
      incurred: { unit: "credits", units: 7 },
      state: "known",
    });
    assert.deepEqual(runtime.receipts, []);
    assert.equal(runtime.failures.length, 1);
  } finally {
    await runtime.close();
  }
});

test("closing the OpenCode transport interrupts its active provider stream once", async () => {
  const runtime = await harness();
  const reading = runtime.response.text();
  const rejected = assert.rejects(reading, /transport closed/u);
  await runtime.close();
  await rejected;
  assert.equal(runtime.cancelled(), 1);
  assert.equal(runtime.outcomes.length, 1);
  assert.deepEqual(runtime.outcomes[0].usage, { state: "unknown" });
  assert.deepEqual(runtime.receipts, []);
});

test("provider usage above the reserved bound fails instead of completing", async () => {
  const runtime = await harness();
  try {
    runtime.push(
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":101}}\n\n'
    );
    runtime.end();
    await assert.rejects(runtime.response.text(), /authoritative usage/u);
    assert.equal(runtime.outcomes.length, 1);
    assert.deepEqual(runtime.outcomes[0].usage, { state: "unknown" });
    assert.deepEqual(runtime.receipts, []);
  } finally {
    await runtime.close();
  }
});
