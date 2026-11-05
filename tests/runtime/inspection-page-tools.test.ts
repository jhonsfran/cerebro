import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Type,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  Harness,
  LiveDoc,
  MemoryStorage,
  createRegistry,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import {
  inspectEntries,
  inspectLive,
} from "../../packages/runtime/src/inspection-native.ts";
import { piContext } from "../../packages/runtime/src/pi-harness.ts";

const context = piContext();

test("a successful tool result outside the selected page leaves its call status unknown", async () => {
  const models = createModels();
  const registry = createRegistry();
  const entered = Promise.withResolvers<boolean>();
  const released = Promise.withResolvers<boolean>();
  const tools = {
    name: "inspection-page-tools",
    tools: [
      {
        name: "delegate_worker",
        description: "Return a saved result.",
        parameters: Type.Object({ text: Type.String() }),
        replay: "safe" as const,
        execute: async () => {
          entered.resolve(true);
          await released.promise;
          return {
            output: [
              { type: "text" as const, text: "The saved result is complete." },
            ],
          };
        },
      },
    ],
  };
  registry.install(tools);
  const faux = fauxProvider({ provider: "inspection-page-provider" });
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall(
        "delegate_worker",
        { text: "Check saved tool status." },
        { id: "page-call" }
      ),
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage("The tool finished."),
  ]);
  const pi = await Harness.open(
    new MemoryStorage(),
    { models, registry, settings: { extensions: [] } },
    context
  );
  try {
    const native = await pi.createConversation(
      { ownership: { kind: "ownerless" } },
      context
    );
    const model = faux.getModel();
    await native.configure(
      {
        extensions: [tools],
        model: { provider: model.provider, modelId: model.id },
      },
      context
    );
    const input = await native.submit(
      { type: "input", content: "Run the saved tool." },
      context
    );
    await entered.promise;
    const activeContext = await native.context(context);
    const live = await pi.snapshot(LiveDoc, native.id, context);
    assert.ok(live?.run);
    const running = inspectLive(inspectEntries(activeContext.entries), live, {
      task: await pi.getTask(live.run.taskId, context),
      conversationId: native.id,
    });
    assert.equal(running.tools[0]?.status, "running");
    released.resolve(true);
    const settled = await input.wait(context);
    assert.equal(settled.status, "done");
    const completedContext = await native.context(context);
    const history = completedContext.entries;
    const complete = inspectLive(inspectEntries(history));
    assert.deepEqual(
      complete.tools.map((tool) => ({
        status: tool.status,
        output: tool.output,
      })),
      [
        {
          status: "succeeded",
          output: { text: "The saved result is complete.", truncated: false },
        },
      ]
    );
    const call = history.find((entry) =>
      entry.model?.some(
        (message) =>
          message.role === "assistant" &&
          message.content.some((part) => part.type === "toolCall")
      )
    );
    assert.ok(call);
    const page = await native.entries(
      { minEntryId: call.id, maxEntryId: call.id },
      1,
      undefined,
      context
    );
    const projected = inspectLive(inspectEntries(page.items));
    assert.deepEqual(
      projected.tools.map((tool) => ({
        id: tool.id,
        callId: tool.callId,
        status: tool.status,
        output: tool.output,
        resultEntryId: tool.resultEntryId,
      })),
      [
        {
          id: `call:${call.id}:0:0`,
          callId: "page-call",
          status: "unknown",
          output: null,
          resultEntryId: null,
        },
      ]
    );
    assert.equal(faux.state.callCount, 2);
  } finally {
    released.resolve(true);
    await pi.close(context);
  }
});
