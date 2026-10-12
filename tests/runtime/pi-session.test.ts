/* oxlint-disable no-await-in-loop -- Each input size is verified with its own provider. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect } from "effect";

import { Denied } from "../../packages/contracts/src/failures.ts";
import {
  fauxProvider,
  fauxAssistantMessage,
  createAssistantMessageEventStream,
  normalizeContext,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { createControlledProvider } from "../../packages/runtime/src/pi-provider.ts";

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

test(
  "a native abort settles the result and iterator when the vendor stream does not finish",
  { timeout: 1000 },
  async () => {
    const faux = fauxProvider();
    const model = faux.getModel();
    const started = Promise.withResolvers<"started">();
    const vendor = createAssistantMessageEventStream();
    const controller = new AbortController();
    const guarded = createControlledProvider({
      authorize: () => Effect.void,
      deadlineMs: 10_000,
      maxInputBytes: 4096,
      model,
      provider: {
        ...faux.provider,
        streamSimple: () => {
          started.resolve("started");
          return vendor;
        },
      },
    });
    const stream = guarded.streamSimple(
      model,
      normalizeContext({ messages: [] }),
      { signal: controller.signal }
    );
    const iterator = stream[Symbol.asyncIterator]();
    const next = iterator.next();
    await started.promise;
    controller.abort();
    const [result, event] = await Promise.all([stream.result(), next]);
    assert.equal(result.stopReason, "aborted");
    assert.ok(!event.done);
    assert.equal(event.value.type, "error");
    if (event.value.type === "error") {
      assert.equal(event.value.reason, "aborted");
    }
    assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  }
);

test("rejected source preparation prevents physical fetch and current permission permits it", async () => {
  const faux = fauxProvider();
  const model = faux.getModel();
  let permitted = false;
  const payloads: string[] = [];
  const guarded = createControlledProvider({
    authorize: () => Effect.void,
    deadlineMs: 1000,
    fetch: (_input, init) => {
      payloads.push(String(init?.body));
      return Promise.resolve(new Response("fixture"));
    },
    maxInputBytes: 4096,
    model,
    prepareContext: (context) =>
      permitted
        ? Effect.succeed(context)
        : Effect.fail(
            new Denied({
              code: "revoked",
              reason: "The source grant was revoked.",
            })
          ),
    provider: {
      ...faux.provider,
      streamSimple: (_model, _context, options) => {
        const stream = createAssistantMessageEventStream();
        const dispatch = async () => {
          try {
            assert.ok(options?.fetch);
            await options.fetch("https://fixture.invalid/model", {
              body: "authorized input",
              method: "POST",
              signal: options.signal,
            });
            stream.end(fauxAssistantMessage("Allowed source answer."));
          } catch {
            stream.end(fauxAssistantMessage("", { stopReason: "error" }));
          }
        };
        void dispatch();
        return stream;
      },
    },
  });
  const denied = await guarded
    .streamSimple(model, normalizeContext({ messages: [] }))
    .result();
  assert.equal(denied.stopReason, "error");
  assert.deepEqual(payloads, []);
  permitted = true;
  const allowed = await guarded
    .streamSimple(model, normalizeContext({ messages: [] }))
    .result();
  assert.equal(allowed.stopReason, "stop");
  assert.deepEqual(allowed.content, [
    { text: "Allowed source answer.", type: "text" },
  ]);
  assert.deepEqual(payloads, ["authorized input"]);
});
