/* oxlint-disable no-await-in-loop -- Inputs, native compactions, and replay follow durable submission order. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Effect, Schema } from "effect";

import { Denied } from "../../packages/contracts/src/failures.ts";
import { openAICompletionsApi } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js";
import {
  createModels,
  normalizeContext,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import type { Model } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { createProvider } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/models.js";
import { isContextOverflow } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/utils/overflow.js";
import {
  CompactionEntry,
  Harness,
  createRegistry,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { openNodeSqliteStorage } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js";
import { piContext } from "../../packages/runtime/src/pi-harness.ts";
import { createControlledProvider } from "../../packages/runtime/src/pi-provider.ts";

const context = piContext();
const inputByteLimit = 131_072;
const model = {
  api: "openai-completions",
  baseUrl: "https://fixture.invalid/v1",
  contextWindow: inputByteLimit,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  id: "bounded-context",
  input: ["text"],
  maxTokens: 16_384,
  name: "Context fixture",
  provider: "context-fixture",
  reasoning: false,
} satisfies Model<"openai-completions">;
const RequestBody = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      content: Schema.Union([
        Schema.String,
        Schema.Array(
          Schema.Struct({ text: Schema.String, type: Schema.Literal("text") })
        ),
      ]),
    })
  ),
});

const input = (number: number) => ({
  content:
    `Report ${number}: compare the task status, owner, due date, and conflict rules before the next edit. `
      .repeat(200)
      .slice(0, 16_000),
  requestId: `report-${number}`,
  type: "input" as const,
});

const setup = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-byte-compaction-"));
  const filename = path.join(directory, "native.sqlite");
  const physicalBodies: string[] = [];
  let reservations = 0;
  let revokeAt = Number.POSITIVE_INFINITY;
  let allowed = true;
  let failNetwork = false;
  const source = createProvider({
    api: openAICompletionsApi(),
    auth: {
      apiKey: {
        name: "fixture",
        resolve: () =>
          Promise.resolve({ auth: { apiKey: "synthetic-local-only" } }),
      },
    },
    baseUrl: model.baseUrl,
    id: model.provider,
    models: [model],
  });
  const provider = createControlledProvider({
    authorize: () =>
      allowed
        ? Effect.void
        : Effect.fail(
            new Denied({ code: "revoked", reason: "Current access revoked." })
          ),
    beforeFetch: () =>
      Effect.sync(() => {
        reservations += 1;
        if (reservations === revokeAt) {
          allowed = false;
        }
      }),
    deadlineMs: 5000,
    fetch: (_url, init) => {
      const body = Schema.decodeUnknownSync(Schema.String)(init?.body);
      physicalBodies.push(body);
      if (failNetwork) {
        throw new Error("Fixture connection failed.");
      }
      const request = Schema.decodeUnknownSync(RequestBody)(JSON.parse(body));
      const characters = request.messages.reduce(
        (sum, message) =>
          sum +
          (typeof message.content === "string"
            ? message.content.length
            : message.content.reduce(
                (count, part) => count + part.text.length,
                0
              )),
        0
      );
      // Synthetic English usage follows the installed SDK estimator, not a production byte/token conversion.
      const promptTokens = Math.ceil(characters / 3.5);
      const chunk = {
        created: 1,
        id: `fixture-${physicalBodies.length}`,
        model: model.id,
        object: "chat.completion.chunk",
      };
      const first = {
        ...chunk,
        choices: [
          {
            delta: { content: "Task report recorded.", role: "assistant" },
            finish_reason: null,
            index: 0,
          },
        ],
      };
      const last = {
        ...chunk,
        choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
        usage: {
          completion_tokens: 10,
          prompt_tokens: promptTokens,
          total_tokens: promptTokens + 10,
        },
      };
      return Promise.resolve(
        new Response(
          `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`,
          { headers: { "Content-Type": "text/event-stream" } }
        )
      );
    },
    maxInputBytes: inputByteLimit,
    maxResponseBytes: 1_048_576,
    model,
    provider: source,
  });
  const models = createModels();
  models.setProvider(provider);
  const open = async () =>
    Harness.open(
      await openNodeSqliteStorage(filename),
      { models, registry: createRegistry(), settings: { extensions: [] } },
      context
    );
  let pi = await open();
  let conversation = await pi.createConversation(
    {
      agent: {
        instructions:
          "Read each bounded task report and acknowledge it briefly.",
        model: { modelId: model.id, provider: model.provider },
      },
      ownership: { kind: "ownerless" },
    },
    context
  );
  return {
    conversation: () => conversation,
    physicalBodies,
    provider,
    revokeOnReservation: (number: number) => {
      revokeAt = number;
    },
    failNetwork: () => {
      failNetwork = true;
    },
    entries: async () => {
      const page = await conversation.entries(
        { order: "ascending" },
        256,
        undefined,
        context
      );
      assert.equal(page.next, undefined);
      return page.items;
    },
    reopen: async () => {
      const { id } = conversation;
      await pi.close(context);
      pi = await open();
      const restored = await pi.conversation(id, context);
      assert.ok(restored);
      conversation = restored;
    },
    close: async () => {
      await pi.close(context);
      await rm(directory, { recursive: true });
    },
  };
};

test("the OpenAI adapter preserves the local byte overflow signal without a physical request", async () => {
  const subject = await setup();
  try {
    const result = await subject.provider
      .streamSimple(
        model,
        normalizeContext({
          messages: [
            {
              content: "x".repeat(inputByteLimit),
              role: "user",
              timestamp: Date.now(),
            },
          ],
        }),
        { apiKey: "synthetic-local-only" }
      )
      .result();
    assert.equal(result.stopReason, "error");
    assert.match(
      result.errorMessage ?? "",
      /Model input exceeds the configured byte limit/u
    );
    assert.equal(isContextOverflow(result), true);
    assert.deepEqual(subject.physicalBodies, []);
  } finally {
    await subject.close();
  }
});

test("bounded conversation inputs survive repeated native compaction, exact replay, and cold reopen", async () => {
  const subject = await setup();
  try {
    for (let number = 1; number <= 14; number += 1) {
      const submission = await subject
        .conversation()
        .submit(input(number), context);
      const result = await submission.wait(context);
      assert.equal(result.status, "done", JSON.stringify(result));
    }
    const before = await subject.entries();
    assert.ok(before.filter((entry) => CompactionEntry.is(entry)).length >= 2);
    const original = await subject.conversation().submit(input(9), context);
    const originalResult = await original.wait(context);
    const callsBeforeReopen = subject.physicalBodies.length;
    await subject.reopen();
    assert.deepEqual(await subject.entries(), before);
    const replay = await subject.conversation().submit(input(9), context);
    assert.equal(replay.id, original.id);
    assert.deepEqual(await replay.wait(context), originalResult);
    assert.equal(subject.physicalBodies.length, callsBeforeReopen);
    for (let number = 15; number <= 19; number += 1) {
      const submission = await subject
        .conversation()
        .submit(input(number), context);
      const result = await submission.wait(context);
      assert.equal(result.status, "done", JSON.stringify(result));
    }
    const entries = await subject.entries();
    const compactions = entries.filter((entry) => CompactionEntry.is(entry));
    assert.ok(compactions.length >= 3);
    assert.ok(compactions.every((entry) => entry.data.reason === "overflow"));
    assert.deepEqual(
      entries.flatMap((entry) =>
        entry.kind === "pi.user"
          ? (entry.model ?? []).flatMap((message) =>
              message.role === "user" ? [message.content] : []
            )
          : []
      ),
      Array.from({ length: 19 }, (_, index) => input(index + 1).content)
    );
    assert.equal(subject.physicalBodies.length, 19 + compactions.length);
    assert.ok(
      subject.physicalBodies.every(
        (body) => new TextEncoder().encode(body).byteLength <= inputByteLimit
      )
    );
  } finally {
    await subject.close();
  }
});

for (const phase of ["summary", "resumed generation"] as const) {
  test(`current authority is checked before the native ${phase} physical request`, async () => {
    const subject = await setup();
    try {
      for (let number = 1; number <= 8; number += 1) {
        const submission = await subject
          .conversation()
          .submit(input(number), context);
        const result = await submission.wait(context);
        assert.equal(result.status, "done");
      }
      const allowedCalls = phase === "summary" ? 8 : 9;
      subject.revokeOnReservation(allowedCalls + 1);
      const submission = await subject.conversation().submit(input(9), context);
      const result = await submission.wait(context);
      assert.equal(result.status, "unanswered");
      assert.equal(subject.physicalBodies.length, allowedCalls);
      const entries = await subject.entries();
      assert.equal(
        entries.filter((entry) => CompactionEntry.is(entry)).length,
        phase === "summary" ? 0 : 1
      );
    } finally {
      await subject.close();
    }
  });
}

test("ordinary network failure keeps its connection error and is not context overflow", async () => {
  const subject = await setup();
  try {
    subject.failNetwork();
    const result = await subject.provider
      .streamSimple(model, normalizeContext({ messages: [] }), {
        apiKey: "synthetic-local-only",
      })
      .result();
    assert.equal(result.stopReason, "error");
    assert.equal(result.errorMessage, "Connection error.");
    assert.equal(isContextOverflow(result), false);
    assert.equal(subject.physicalBodies.length, 1);
  } finally {
    await subject.close();
  }
});
