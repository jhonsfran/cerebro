import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { z } from "zod";

import { openAICompletionsApi } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js";
import {
  Type,
  createModels,
  createProvider,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import type {
  AssistantMessage,
  Context,
  Model,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { waitForFixture } from "../slice-1/application.ts";
import { createFixture } from "../slice-1/provider.mjs";

const roleModels = {
  coordinator: "wire-coordinator-alpha",
  lead: "wire-lead-beta",
  worker: "wire-worker-gamma",
};
const startTool = {
  name: "start_team",
  description: "Start bounded background work.",
  parameters: Type.Object({ goal: Type.String() }),
};
const workerTool = {
  name: "delegate_worker",
  description: "Delegate one question.",
  parameters: Type.Object({ text: Type.String() }),
};
const user = (content: string): UserMessage => ({
  content,
  role: "user",
  timestamp: Date.now(),
});
const textOf = (message: AssistantMessage): string =>
  message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
const toolResult = (call: ToolCall, text: string): ToolResultMessage => ({
  content: [{ text, type: "text" }],
  isError: false,
  role: "toolResult",
  timestamp: Date.now(),
  toolCallId: call.id,
  toolName: call.name,
});
const observationsSchema = z.object({
  held: z.number(),
  model: z.array(
    z.object({
      completedAt: z.number().optional(),
      firstTokenAt: z.number().optional(),
      model: z.string(),
      startedAt: z.number(),
    })
  ),
});
const setup = async (context: TestContext) => {
  const directory = await mkdtemp(path.join(tmpdir(), "cerebro-team-fixture-"));
  const fixture = await createFixture({
    directory,
    fixtureId: "team-provider-fixture",
    sha: "team-provider-fixture-source",
  });
  context.after(async () => {
    if (fixture.server.listening) {
      const closed = once(fixture.server, "close");
      fixture.server.close();
      fixture.server.closeAllConnections();
      await closed;
    }
    await fixture.flush();
    await rm(directory, { force: true, recursive: true });
  });
  fixture.server.listen(0, "127.0.0.1");
  await once(fixture.server, "listening");
  const address = fixture.server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const configured = Object.values(roleModels).map(
    (id): Model<"openai-completions"> => ({
      api: "openai-completions",
      baseUrl: `${baseUrl}/v1`,
      contextWindow: 16_384,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      id,
      input: ["text"],
      maxTokens: 2048,
      name: id,
      provider: "fixture",
      reasoning: false,
    })
  );
  const models = createModels();
  models.setProvider(
    createProvider({
      api: openAICompletionsApi(),
      auth: {
        apiKey: {
          name: "fixture",
          resolve: () =>
            Promise.resolve({ auth: { apiKey: "fixture-model-key" } }),
        },
      },
      baseUrl: `${baseUrl}/v1`,
      id: "fixture",
      models: configured,
    })
  );
  const controls = async (input: unknown) => {
    const response = await fetch(`${baseUrl}/control`, {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
        "X-Fixture-Control": "slice-1-control",
      },
      method: "POST",
    });
    assert.equal(response.status, 200);
    await response.body?.cancel();
  };
  await controls({ delayMs: 0 });
  return {
    complete: async (modelId: string, transcript: Context) => {
      const model = configured.find((value) => value.id === modelId);
      assert.ok(model);
      const result = await models.completeSimple(model, transcript);
      assert.notEqual(
        result.stopReason,
        "error",
        result.errorMessage ?? "Fixture model failed."
      );
      return result;
    },
    controls,
    observed: async () => {
      const response = await fetch(`${baseUrl}/observations`);
      assert.equal(response.status, 200);
      return observationsSchema.parse(await response.json());
    },
  };
};

test(
  "Pi AI receives one coordinator call, two distinct worker calls, and a summary of the real tool results",
  { timeout: 15_000 },
  async (context) => {
    const fixture = await setup(context);
    const request = user("SLACK_TEAM_FIXTURE run the two worker checks.");
    const coordinator = await fixture.complete(roleModels.coordinator, {
      messages: [request],
      tools: [startTool],
    });
    const starts = coordinator.content.filter(
      (block) => block.type === "toolCall"
    );
    assert.deepEqual(
      starts.map((call) => ({ name: call.name, arguments: call.arguments })),
      [
        {
          name: "start_team",
          arguments: {
            goal: "SLACK_TEAM_FIXTURE Analyze both worker checks and return a bounded summary.",
          },
        },
      ]
    );
    const start = starts.at(0);
    assert.ok(start);
    const acknowledged = await fixture.complete(roleModels.coordinator, {
      messages: [
        request,
        coordinator,
        toolResult(start, "Accepted fixture-work."),
      ],
      tools: [startTool],
    });
    assert.equal(
      textOf(acknowledged),
      "SLACK_TEAM_FIXTURE coordinator accepted background work."
    );
    const goal = user(
      z.object({ goal: z.string() }).parse(start.arguments).goal
    );
    const lead = await fixture.complete(roleModels.lead, {
      messages: [goal],
      tools: [workerTool],
    });
    const workers = lead.content.filter((block) => block.type === "toolCall");
    assert.deepEqual(
      workers.map((call) => ({ name: call.name, arguments: call.arguments })),
      [
        {
          name: "delegate_worker",
          arguments: {
            text: "SLACK_TEAM_FIXTURE worker:one. Return one bounded result.",
          },
        },
        {
          name: "delegate_worker",
          arguments: {
            text: "SLACK_TEAM_FIXTURE worker:two. Return one bounded result.",
          },
        },
      ]
    );
    assert.equal(new Set(workers.map((call) => call.id)).size, 2);
    const results = await Promise.all(
      workers.map(async (call) => {
        const input = z.object({ text: z.string() }).parse(call.arguments);
        const answer = await fixture.complete(roleModels.worker, {
          messages: [user(input.text)],
        });
        return toolResult(call, textOf(answer));
      })
    );
    const summary = await fixture.complete(roleModels.lead, {
      messages: [goal, lead, ...results],
      tools: [workerTool],
    });
    assert.equal(
      textOf(summary),
      "SLACK_TEAM_FIXTURE lead summary: SLACK_TEAM_FIXTURE worker one complete. SLACK_TEAM_FIXTURE worker two complete."
    );
    const ordinary = await fixture.complete(roleModels.coordinator, {
      messages: [user("Give an ordinary answer with no fixture marker.")],
      tools: [startTool, workerTool],
    });
    assert.equal(textOf(ordinary), "Cerebro slice 1 completed.");
    const observed = await fixture.observed();
    assert.deepEqual(
      observed.model.map((call) => call.model),
      [
        roleModels.coordinator,
        roleModels.coordinator,
        roleModels.lead,
        roleModels.worker,
        roleModels.worker,
        roleModels.lead,
        roleModels.coordinator,
      ]
    );
  }
);

test(
  "a per-model hold keeps the lead pending while the coordinator answers, and targeted delay applies on release",
  { timeout: 15_000 },
  async (context) => {
    const fixture = await setup(context);
    await fixture.controls({
      models: { [roleModels.lead]: { delayMs: 0, hold: true } },
    });
    const pending = fixture.complete(roleModels.lead, {
      messages: [user("SLACK_TEAM_FIXTURE run the held lead.")],
      tools: [workerTool],
    });
    const held = await waitForFixture(
      fixture.observed,
      (value) => value.held === 1,
      5000
    );
    assert.equal(held.held, 1);
    assert.equal(held.model.at(0)?.model, roleModels.lead);
    const coordinator = await fixture.complete(roleModels.coordinator, {
      messages: [user("Keep the conversation responsive.")],
    });
    assert.equal(textOf(coordinator), "Cerebro slice 1 completed.");
    const beforeRelease = await fixture.observed();
    assert.equal(beforeRelease.held, 1);
    assert.equal(
      beforeRelease.model.find((call) => call.model === roleModels.lead)
        ?.completedAt,
      undefined
    );
    assert.ok(
      beforeRelease.model.find((call) => call.model === roleModels.coordinator)
        ?.completedAt
    );
    const releasedAt = Date.now();
    await fixture.controls({
      models: { [roleModels.lead]: { delayMs: 100, hold: false } },
    });
    const lead = await pending;
    assert.equal(
      lead.content.filter((block) => block.type === "toolCall").length,
      2
    );
    const afterRelease = await fixture.observed();
    assert.equal(afterRelease.held, 0);
    const leadCall = afterRelease.model.find(
      (call) => call.model === roleModels.lead
    );
    assert.ok(leadCall?.completedAt);
    assert.ok(
      leadCall.firstTokenAt && leadCall.firstTokenAt - releasedAt >= 75
    );
  }
);
