import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect } from "effect";

import { Denied } from "../../packages/contracts/src/failures.ts";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  Harness,
  MemoryStorage,
  createRegistry,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { conversationProvider } from "../../packages/runtime/src/conversation-provider.ts";
import { piContext } from "../../packages/runtime/src/pi-harness.ts";
import { createControlledProvider } from "../../packages/runtime/src/pi-provider.ts";

test("one harness isolates conversation providers, tool schemas, credentials, authority and retry IDs", async () => {
  const models = createModels();
  const registry = createRegistry();
  const dispatches: string[] = [];
  const toolScopes: string[] = [];
  const createScope = (name: string, property: string) => {
    let allowed = true;
    const faux = fauxProvider({
      models: [{ id: "same-model" }],
      provider: "same-provider",
    });
    const model = faux.getModel();
    const source = faux.provider;
    const controlled = createControlledProvider({
      authorize: () =>
        allowed
          ? Effect.void
          : Effect.fail(
              new Denied({ code: "revoked", reason: "Scope was revoked." })
            ),
      deadlineMs: name === "sales" ? 5000 : 10_000,
      maxInputBytes: 100_000,
      maxResponseBytes: 100_000,
      model,
      provider: {
        ...source,
        auth: {
          apiKey: {
            name,
            resolve: () =>
              Promise.resolve({ auth: { apiKey: `credential-${name}` } }),
          },
        },
        streamSimple: (value, transcript, options) => {
          assert.equal(value.provider, "same-provider");
          assert.equal(options?.apiKey, `credential-${name}`);
          assert.equal(options?.timeoutMs, name === "sales" ? 5000 : 10_000);
          assert.match(
            JSON.stringify(transcript.messages),
            new RegExp(`${name} instructions`, "u")
          );
          dispatches.push(name);
          return source.streamSimple(value, transcript, options);
        },
      },
    });
    const provider = conversationProvider(name, model, controlled);
    models.setProvider(provider);
    const extension = {
      name: `scope:${name}`,
      tools: [
        {
          description: `${name} only`,
          execute: (args: Record<string, unknown>) => {
            assert.deepEqual(args, { [property]: name });
            toolScopes.push(name);
            return Promise.resolve({
              output: [{ text: `${name} tool result`, type: "text" as const }],
            });
          },
          name: "same_tool",
          parameters: {
            additionalProperties: false,
            properties: { [property]: { type: "string" } },
            required: [property],
            type: "object",
          },
          replay: "safe" as const,
        },
      ],
    };
    registry.install(extension);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("same_tool", { [property]: name }), {
        stopReason: "toolUse",
      }),
      (transcript) => {
        const result = transcript.messages.findLast(
          (message) => message.role === "toolResult"
        );
        assert.equal(result?.content[0]?.type, "text");
        assert.match(
          JSON.stringify(result),
          new RegExp(`${name} tool result`, "u")
        );
        return fauxAssistantMessage(`${name} answer`);
      },
    ]);
    return {
      agent: {
        extensions: [extension],
        instructions: `${name} instructions`,
        model: { modelId: model.id, provider: provider.id },
      },
      faux,
      revoke: () => {
        allowed = false;
      },
    };
  };
  const sales = createScope("sales", "account");
  const support = createScope("support", "ticket");
  const context = piContext();
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, settings: { extensions: [] } },
    context
  );
  try {
    const salesChat = await harness.createConversation(
      { agent: sales.agent, ownership: { kind: "ownerless" } },
      context
    );
    const supportChat = await harness.createConversation(
      { agent: support.agent, ownership: { kind: "ownerless" } },
      context
    );
    const [first, second] = await Promise.all([
      salesChat.submit(
        { content: "Sales request", requestId: "same-id", type: "input" },
        context
      ),
      supportChat.submit(
        { content: "Support request", requestId: "same-id", type: "input" },
        context
      ),
    ]);
    const settled = await Promise.all([
      first.wait(context),
      second.wait(context),
    ]);
    assert.deepEqual(
      settled.map((value) => value.status),
      ["done", "done"]
    );
    assert.notEqual(first.id, second.id);
    assert.deepEqual(toolScopes.toSorted(), ["sales", "support"]);
    assert.deepEqual(dispatches.toSorted(), [
      "sales",
      "sales",
      "support",
      "support",
    ]);
    const retried = await salesChat.submit(
      { content: "Sales request", requestId: "same-id", type: "input" },
      context
    );
    assert.equal(retried.id, first.id);
    assert.equal(dispatches.length, 4);

    sales.revoke();
    support.faux.appendResponses([fauxAssistantMessage("Still available")]);
    const denied = await salesChat.submit(
      { content: "Revoked request", requestId: "next", type: "input" },
      context
    );
    const available = await supportChat.submit(
      { content: "Allowed request", requestId: "next", type: "input" },
      context
    );
    const deniedResult = await denied.wait(context);
    const availableResult = await available.wait(context);
    assert.equal(deniedResult.status, "unanswered");
    assert.equal(availableResult.status, "done");
    assert.equal(sales.faux.state.callCount, 2);
    assert.equal(support.faux.state.callCount, 3);
  } finally {
    await harness.close(context);
  }
});
