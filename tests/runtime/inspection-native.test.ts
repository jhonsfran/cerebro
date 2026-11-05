import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Schema } from "effect";

import { TeamInspectionFrame } from "../../packages/contracts/src/inspection.ts";
import { WorkAdmissionSchema } from "../../packages/contracts/src/work.ts";
import {
  createModels,
  fauxAssistantMessage,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  AgentDoc,
  Harness,
  LiveDoc,
  UsageDoc,
  createRegistry,
  defineTask,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { openNodeSqliteStorage } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js";
import { piContext } from "../../packages/runtime/src/pi-harness.ts";
import { readTeamInspection } from "../../packages/runtime/src/team-inspection.ts";
import { TeamState } from "../../packages/runtime/src/team-state.ts";

const context = piContext();
const heldTask = defineTask({
  name: "inspection-held-task",
  version: 1,
  initial: () => ({ phase: "held" as const }),
  phases: {
    held: () => {
      throw new Error("An inspection must not execute this task.");
    },
  },
});
test("private native projection shows actual saved models and safe text without providers or execution profiles", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "inspection-native-"));
  const pi = await Harness.open(
    await openNodeSqliteStorage(path.join(directory, "state.sqlite")),
    {
      models: createModels(),
      registry: createRegistry(),
      settings: { extensions: [] },
    },
    context
  );
  try {
    const lead = await pi.createConversation(
      { ownership: { kind: "ownerless" } },
      context
    );
    const now = Date.now();
    const work = Schema.decodeUnknownSync(WorkAdmissionSchema)({
      version: 2,
      admittedAt: now,
      deadlineAt: now + 60_000,
      goal: "Inspect retained native data.",
      key: {
        organizationId: "org",
        ownerPrincipalId: "owner",
        workId: "inspect-work",
      },
      lead: { agentId: "removed-lead", agentVersion: 4 },
      worker: { agentId: "removed-worker", agentVersion: 2 },
      limits: { maxTeams: 2, maxWorkers: 1, maxTurns: 8, timeoutMs: 60_000 },
      sourceEventAddress: {
        organizationId: "org",
        agentId: "coordinator",
        conversationId: "source",
        sessionId: "source",
      },
      contentDependencies: { sourceIds: [], toolIds: [] },
    });
    const answer = fauxAssistantMessage([
      { type: "thinking", thinking: "hidden-thinking-marker" },
      { type: "text", text: "Visible answer." },
      fauxToolCall(
        "delegate_worker",
        { text: "Visible delegation.", apiKey: "credential-marker" },
        { id: "safe-call" }
      ),
      fauxToolCall(
        "arbitrary_connector",
        {
          authorization: "credential-marker",
          query: "hidden-arbitrary-argument",
        },
        { id: "unknown-call" }
      ),
    ]);
    const usage = {
      ...answer.usage,
      input: 13,
      output: 7,
      cacheRead: 3,
      cacheWrite: 2,
      totalTokens: 25,
    };
    await pi.commit(async (tx) => {
      const agent = await tx.doc(AgentDoc, lead.id);
      agent.model = {
        provider: "native-provider-alias",
        modelId: "actual-saved-model",
      };
      agent.instructions = "hidden-instructions-marker";
      const savedUsage = await tx.doc(UsageDoc, lead.id);
      savedUsage.models["native-provider-alias/actual-saved-model"] = usage;
      const state = await tx.doc(TeamState);
      state.admission = work;
      state.lead = lead.id;
      state.phase = "completed";
      state.modelCalls = 3;
      state.report = {
        kind: "completed",
        id: "result-id",
        key: work.key,
        contentDependencies: { sourceIds: [], toolIds: [] },
        text: "Final result.",
      };
      await tx.appendEntry(lead.id, {
        kind: "pi.system",
        model: [{ role: "system", content: "hidden-system-marker" }],
      });
      await tx.appendEntry(lead.id, {
        kind: "pi.assistant",
        model: [{ ...answer, model: "actual-saved-model" }],
        data: { secret: "credential-marker" },
      });
      await tx.appendEntry(lead.id, {
        kind: "pi.tool-result",
        model: [
          {
            role: "toolResult",
            toolCallId: "safe-call",
            toolName: "delegate_worker",
            content: [{ type: "text", text: "Visible tool result." }],
            isError: false,
            timestamp: now,
            details: { secret: "credential-marker" },
          },
        ],
      });
      await tx.appendEntry(lead.id, {
        kind: "pi.tool-result",
        model: [
          {
            role: "toolResult",
            toolCallId: "unknown-call",
            toolName: "arbitrary_connector",
            content: [{ type: "text", text: "raw-provider-error-marker" }],
            isError: true,
            timestamp: now,
          },
        ],
      });
      await tx.appendEntry(lead.id, {
        kind: "pi.assistant",
        model: [
          fauxAssistantMessage("raw-provider-error-marker", {
            stopReason: "error",
            errorMessage: "credential-marker",
          }),
        ],
      });
    }, context);
    const query = { kind: "team" as const, workId: work.key.workId };
    const summary = await readTeamInspection({ pi, work, query });
    assert.ok(summary.kind === "team" && summary.team.kind === "available");
    assert.equal(summary.team.sealed, true);
    assert.equal(summary.team.roles[0]?.modelId, "actual-saved-model");
    assert.deepEqual(summary.team.roles[0]?.usage, {
      input: 13,
      output: 7,
      cacheRead: 3,
      cacheWrite: 2,
      totalTokens: 25,
    });
    const transcript = await readTeamInspection({
      pi,
      work,
      query: { kind: "transcript", workId: work.key.workId, role: 0 },
    });
    assert.ok(transcript.kind === "transcript");
    assert.deepEqual(
      transcript.messages.map((message) => message.content.text),
      ["Visible answer.", "Generation failed."]
    );
    assert.deepEqual(
      transcript.tools.map((tool) => ({
        input: tool.input,
        output: tool.output,
        status: tool.status,
      })),
      [
        {
          input: {
            kind: "text",
            label: "Delegation",
            content: { text: "Visible delegation.", truncated: false },
          },
          output: { text: "Visible tool result.", truncated: false },
          status: "succeeded",
        },
        { input: { kind: "unavailable" }, output: null, status: "failed" },
      ]
    );
    const encoded = JSON.stringify({ summary, transcript });
    for (const hidden of [
      "credential-marker",
      "hidden-thinking-marker",
      "hidden-system-marker",
      "hidden-instructions-marker",
      "hidden-arbitrary-argument",
      "raw-provider-error-marker",
      "native-provider-alias",
    ]) {
      assert.equal(encoded.includes(hidden), false, hidden);
    }
    assert.deepEqual(
      Schema.decodeUnknownSync(TeamInspectionFrame, {
        onExcessProperty: "error",
      })(summary),
      summary
    );
    assert.deepEqual(await readTeamInspection({ pi, work, query }), summary);
    const before = await pi.snapshot(UsageDoc, lead.id, context);
    assert.deepEqual(await pi.snapshot(UsageDoc, lead.id, context), before);
    const finalScheduling = await pi.inspect(context);
    assert.equal(finalScheduling.scheduling, "paused");
    const partial = fauxAssistantMessage([
      { type: "text", text: "Visible live text." },
      { type: "thinking", thinking: "hidden-live-thinking" },
    ]);
    await pi.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, lead.id);
      const task = await tx.createTask(
        heldTask,
        {},
        { conversationId: lead.id, ownership: { kind: "conversation" } }
      );
      live.run = { taskId: task, inputs: [] };
      live.generation = {
        attempt: 2,
        retry: { at: now + 1000, error: "raw-provider-error-marker" },
        message: partial,
      };
    }, context);
    const live = await readTeamInspection({
      pi,
      work,
      query: { kind: "transcript", workId: work.key.workId, role: 0 },
    });
    assert.ok(live.kind === "transcript");
    assert.equal(live.messages.at(-1)?.content.text, "Visible live text.");
    assert.equal(live.messages.at(-1)?.state, "streaming");
    assert.equal(JSON.stringify(live).includes("hidden-live-thinking"), false);
    const unsealed = await readTeamInspection({ pi, work, query });
    assert.ok(unsealed.kind === "team" && unsealed.team.kind === "available");
    assert.equal(unsealed.team.sealed, false);
    assert.equal(unsealed.team.roles[0]?.attempt, 2);
    assert.equal(unsealed.team.roles[0]?.retryAt, now + 1000);
    const scheduling = await pi.inspect(context);
    assert.equal(scheduling.scheduling, "paused");
  } finally {
    await pi.close(context);
    await rm(directory, { recursive: true });
  }
});
