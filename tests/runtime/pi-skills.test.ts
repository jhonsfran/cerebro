import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { piContext } from "../../packages/runtime/src/pi-harness.ts";

const platformImports = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return { shortCircuit: true, url: "data:text/javascript,export {};" };
    }
    return nextResolve(specifier, context);
  },
});
const { companySkillsExtension } =
  await import("../../packages/runtime/src/company-skills.ts");
platformImports.deregister();

test("company skill activation supplies its instructions to Pi and the next model request", async () => {
  const extension = await companySkillsExtension([
    {
      body: "Use the approved account format.",
      description: "Apply the approved format.",
      name: "format-guide",
    },
  ]);
  let modelInstructions = "";
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("activate_skill", { name: "format-guide" }),
      { stopReason: "toolUse" }
    ),
    (context) => {
      const result = context.messages.findLast(
        (message) => message.role === "toolResult"
      );
      modelInstructions =
        result?.role === "toolResult"
          ? result.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("")
          : "";
      return fauxAssistantMessage("Applied the approved format.");
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(extension);
  const context = piContext();
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, settings: { extensions: [extension] } },
    context
  );
  try {
    const root = await harness.root(context);
    const model = faux.getModel();
    await root.configure(
      { model: { modelId: model.id, provider: model.provider } },
      context
    );
    const submission = await root.submit(
      { content: "Apply the company guide.", type: "input" },
      context
    );
    const settled = await submission.wait(context);
    assert.equal(settled.status, "done");
    const native = await root.context(context);
    const result = native.messages.find(
      (message) => message.role === "toolResult"
    );
    assert.equal(result?.role, "toolResult");
    if (result?.role === "toolResult") {
      assert.equal(result.isError, false);
      assert.match(
        JSON.stringify(result.content),
        /Use the approved account format\./u
      );
    }
    assert.match(modelInstructions, /Use the approved account format\./u);
  } finally {
    await harness.close(context);
  }
});
