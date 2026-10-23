import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { openNodeSqliteStorage } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js";
import { createGenerativeUiTool } from "../../packages/runtime/src/generative-ui-tool.ts";
import {
  chatPresentation,
  piContext,
} from "../../packages/runtime/src/pi-harness.ts";
import { verificationUiRequest } from "../slice-1/provider.mjs";

const context = piContext();
const open = async (filename: string, authorize = () => Promise.resolve()) => {
  const faux = fauxProvider();
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("render_ui", verificationUiRequest()), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage(
      "Two verification checks passed. Runtime and reconnect are ready."
    ),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  const extension = {
    name: "generative-ui",
    tools: [createGenerativeUiTool({ authorize })],
  };
  registry.install(extension);
  const storage = await openNodeSqliteStorage(filename);
  const harness = await Harness.open(
    storage,
    { models, registry, settings: { extensions: [extension] } },
    context
  );
  return { harness, model: faux.getModel() };
};

test("the real Pi tool stores UI details and restores the same report after storage reopen", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cerebro-ui-"));
  const filename = path.join(directory, "pi.sqlite");
  let authorizations = 0;
  const first = await open(filename, () => {
    authorizations += 1;
    return Promise.resolve();
  });
  let before: ReturnType<typeof chatPresentation> | undefined;
  try {
    const root = await first.harness.root(context);
    await root.configure(
      { model: { modelId: first.model.id, provider: first.model.provider } },
      context
    );
    const submitted = await root.submit(
      {
        content: "Show a verification report",
        requestId: "report-input",
        type: "input",
      },
      context
    );
    const settled = await submitted.wait(context);
    assert.equal(settled.status, "done");
    assert.equal(authorizations, 1);
    const watch = await root.watch(context);
    try {
      before = chatPresentation(watch.value);
      assert.equal(before.tools[0]?.state, "succeeded");
      assert.equal(
        before.tools[0]?.presentation?.spec.elements.report?.type,
        "Card"
      );
      assert.deepEqual(before.tools[0]?.arguments, {});
      assert.equal(
        before.messages.at(-1)?.text,
        "Two verification checks passed. Runtime and reconnect are ready."
      );
      const durable = await root.context(context);
      const stored = durable.messages.find(
        (message) => message.role === "toolResult"
      );
      assert.equal(stored?.role, "toolResult");
      if (stored?.role === "toolResult") {
        assert.deepEqual(stored.details, before.tools[0]?.presentation);
      }
    } finally {
      await watch.stop();
    }
  } finally {
    await first.harness.close(context);
  }
  const second = await open(filename);
  try {
    const root = await second.harness.root(context);
    const watch = await root.watch(context);
    try {
      assert.deepEqual(chatPresentation(watch.value), before);
    } finally {
      await watch.stop();
    }
  } finally {
    await second.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("the native UI tool withholds a presentation after authorization denial", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cerebro-ui-denied-"));
  const fixture = await open(path.join(directory, "pi.sqlite"), () =>
    Promise.reject(new Error("Access revoked."))
  );
  try {
    const root = await fixture.harness.root(context);
    await root.configure(
      {
        model: { modelId: fixture.model.id, provider: fixture.model.provider },
      },
      context
    );
    const submitted = await root.submit(
      { content: "Show a verification report", type: "input" },
      context
    );
    await submitted.wait(context);
    const watch = await root.watch(context);
    try {
      const snapshot = chatPresentation(watch.value);
      assert.equal(snapshot.tools[0]?.state, "failed");
      assert.equal(snapshot.tools[0]?.presentation, undefined);
      assert.match(snapshot.tools[0]?.output ?? "", /Access revoked/u);
    } finally {
      await watch.stop();
    }
  } finally {
    await fixture.harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});
