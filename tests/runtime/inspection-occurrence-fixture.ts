import assert from "node:assert/strict";

import { Schema } from "effect";

import { WorkAdmissionSchema } from "../../packages/contracts/src/work.ts";
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
import type { EntryRecord } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import {
  inspectEntries,
  inspectLive,
} from "../../packages/runtime/src/inspection-native.ts";
import { piContext } from "../../packages/runtime/src/pi-harness.ts";
import { readTeamInspection } from "../../packages/runtime/src/team-inspection.ts";
import { TeamState } from "../../packages/runtime/src/team-state.ts";

const toolAnswer = (ids: string[]) =>
  fauxAssistantMessage(
    ids.map((id) =>
      fauxToolCall("delegate_worker", { text: "Check retained work." }, { id })
    ),
    { stopReason: "toolUse" }
  );

export const occurrenceFixture = async (
  options: {
    first?: string[];
    second?: string[];
    holdSecondAt?: number;
  } = {}
) => {
  const context = piContext();
  const firstIds = options.first ?? ["reused-call"];
  const secondIds = options.second ?? ["reused-call", "pending-call"];
  const models = createModels();
  const registry = createRegistry();
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  let executions = 0;
  const extension = {
    name: "inspection-occurrence-tools",
    tools: [
      {
        name: "delegate_worker",
        description: "Complete a bounded check.",
        parameters: Type.Object({ text: Type.String() }),
        replay: "safe" as const,
        execute: async () => {
          executions += 1;
          if (executions === firstIds.length + (options.holdSecondAt ?? 1)) {
            entered.resolve(true);
            await release.promise;
          }
          return {
            output: [
              {
                type: "text" as const,
                text: `Completed occurrence ${executions}.`,
              },
            ],
          };
        },
      },
    ],
  };
  registry.install(extension);
  const faux = fauxProvider({ provider: "inspection-occurrence-provider" });
  models.setProvider(faux.provider);
  faux.setResponses([
    toolAnswer(firstIds),
    fauxAssistantMessage("First answer."),
    toolAnswer(secondIds),
    fauxAssistantMessage("Second answer."),
  ]);
  const pi = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      settings: { extensions: [], toolExecution: "sequential" },
    },
    context
  );
  const native = await pi.createConversation(
    { ownership: { kind: "ownerless" } },
    context
  );
  const model = faux.getModel();
  await native.configure(
    {
      extensions: [extension],
      model: { provider: model.provider, modelId: model.id },
    },
    context
  );
  const now = Date.now();
  const work = Schema.decodeUnknownSync(WorkAdmissionSchema)({
    version: 2,
    admittedAt: now,
    deadlineAt: now + 60_000,
    goal: "Inspect actual private tool occurrences.",
    key: {
      organizationId: "org",
      ownerPrincipalId: "owner",
      workId: "occurrences",
    },
    lead: { agentId: "lead", agentVersion: 1 },
    worker: { agentId: "worker", agentVersion: 1 },
    limits: { maxTeams: 2, maxWorkers: 1, maxTurns: 8, timeoutMs: 60_000 },
    sourceEventAddress: {
      organizationId: "org",
      agentId: "coordinator",
      conversationId: "source",
      sessionId: "source",
    },
    contentDependencies: { sourceIds: [], toolIds: [] },
  });
  await pi.commit(async (tx) => {
    const state = await tx.doc(TeamState);
    state.admission = work;
    state.lead = native.id;
    state.phase = "running";
  }, context);
  const first = await native.submit(
    { type: "input", content: "Complete the first checks." },
    context
  );
  const firstResult = await first.wait(context);
  assert.equal(firstResult.status, "done");
  const second = await native.submit(
    { type: "input", content: "Check the new work." },
    context
  );
  await entered.promise;
  const live = await pi.snapshot(LiveDoc, native.id, context);
  assert.ok(live?.run);
  const task = await pi.getTask(live.run.taskId, context);
  assert.ok(task);
  const { entries } = await native.context(context);
  let taskReads = 0;
  const getTask = pi.getTask.bind(pi);
  pi.getTask = async (id, readContext) => {
    taskReads += 1;
    return await getTask(id, readContext);
  };
  return {
    pi,
    native,
    entries,
    live,
    task,
    context,
    complete: async () => {
      release.resolve(true);
      const secondResult = await second.wait(context);
      assert.equal(secondResult.status, "done");
      const completed = await native.context(context);
      return completed.entries;
    },
    project: (page: readonly EntryRecord[]) =>
      inspectLive(inspectEntries(page), live, {
        task,
        conversationId: native.id,
      }),
    read: async (cursor?: string) => {
      taskReads = 0;
      const frame = await readTeamInspection({
        pi,
        work,
        query: {
          kind: "transcript",
          workId: work.key.workId,
          role: 0,
          ...(cursor ? { cursor } : {}),
        },
      });
      assert.ok(frame.kind === "transcript");
      return { frame, taskReads };
    },
    close: async () => {
      release.resolve(true);
      await pi.close(context);
    },
  };
};
