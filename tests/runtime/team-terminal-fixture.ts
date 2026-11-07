import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Schema } from "effect";

import { digestToolArguments } from "../../packages/contracts/src/tools.ts";
import {
  WorkAdmissionSchema,
  WorkReportSchema,
} from "../../packages/contracts/src/work.ts";
import {
  Type,
  createAssistantMessageEventStream,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  Harness,
  LiveDoc,
  createRegistry,
  defineTool,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { openNodeSqliteStorage } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js";
import { piContext } from "../../packages/runtime/src/pi-harness.ts";
import { createTeamAdmission } from "../../packages/runtime/src/team-admission.ts";
import {
  TeamCommandReceipts,
  TeamState,
} from "../../packages/runtime/src/team-state.ts";
import { waitFor } from "./helpers.ts";

const [directory, scenario] = process.argv.slice(2);
if (
  !directory ||
  !["generation", "tool", "admission"].includes(scenario ?? "")
) {
  throw new Error("A terminal fixture directory and scenario are required.");
}
const context = piContext();
const physical = path.join(directory, "physical.log");
const mark = (kind: string) => appendFileSync(physical, `${kind}\n`);
const held = Promise.withResolvers<never>().promise;
writeFileSync(physical, "");
const now = Date.now();
const work = Schema.decodeUnknownSync(WorkAdmissionSchema)({
  version: 3,
  admittedAt: now,
  deadlineAt: now + 600_000,
  goal: "Retain terminal state before abort.",
  key: {
    organizationId: "org",
    ownerPrincipalId: "owner",
    workId: "terminal-work",
  },
  agent: { agentId: "coordinator", agentVersion: 1 },
  limits: { maxTeams: 2, maxTurns: 8, maxWorkers: 1, timeoutMs: 600_000 },
  sourceEventAddress: {
    agentId: "coordinator",
    conversationId: "primary",
    organizationId: "org",
    sessionId: "primary",
  },
  contentDependencies: { sourceIds: [], toolIds: [] },
});
const models = createModels();
const registry = createRegistry();
const faux = fauxProvider({
  provider: "terminal-fixture",
  models: [{ id: "model" }],
});
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("held_read", {}), {
    stopReason: "toolUse",
  }),
]);
const provider = {
  ...faux.provider,
  streamSimple: (...args: Parameters<typeof faux.provider.streamSimple>) => {
    mark("model");
    return scenario === "generation"
      ? createAssistantMessageEventStream()
      : faux.provider.streamSimple(...args);
  },
};
models.setProvider(provider);
const tool = defineTool({
  name: "held_read",
  callers: ["model"],
  replay: "safe",
  parameters: Type.Object({}),
  execute: async () => {
    mark("tool");
    await held;
    return {
      output: [{ type: "text", text: "Must not execute after restart." }],
    };
  },
});
const extension = { name: "terminal-fixture-tools", tools: [tool] };
registry.install(extension);
const pi = await Harness.open(
  await openNodeSqliteStorage(path.join(directory, "state.sqlite")),
  {
    models,
    registry,
    settings: {
      extensions: [],
      compaction: { enabled: false },
      retry: { enabled: false },
    },
  },
  context
);
const lead = await pi.createConversation(
  { ownership: { kind: "ownerless" } },
  context
);
const model = faux.getModel();
await lead.configure(
  {
    extensions: [extension],
    model: { provider: provider.id, modelId: model.id },
  },
  context
);
await pi.commit(async (tx) => {
  const state = await tx.doc(TeamState);
  state.admission = work;
  state.phase = "running";
  state.lead = lead.id;
  state.modelCalls = scenario === "admission" ? 0 : 1;
}, context);
if (scenario === "admission") {
  const admission = createTeamAdmission({
    pi,
    work,
    now: Date.now,
    deliver: async () => {
      mark("admission");
      await held;
    },
  });
  registry.install({ name: "cerebro-team-admission", tasks: [admission] });
  const command = { id: "original-admission", kind: "start" as const, work };
  const digest = await digestToolArguments(command);
  await pi.commit(async (tx) => {
    const state = await tx.doc(TeamState);
    const receipt = await tx.doc(TeamCommandReceipts, command.id, null);
    const taskId = await tx.createTask(admission, command, {
      conversationId: lead.id,
      background: true,
      ownership: { kind: "conversation" },
    });
    state.pending[command.id] = taskId;
    receipt.receipt = { digest, taskId, accepted: true, reason: null };
  }, context);
  pi.resume();
} else {
  await lead.submit(
    {
      type: "input",
      content: "Original retained question.",
      requestId: "original-input",
    },
    context
  );
}
const expected = scenario === "generation" ? "model" : scenario;
await waitFor(
  () => readFileSync(physical, "utf-8"),
  (calls) => calls.includes(expected),
  10_000
);
const team = await pi.snapshot(TeamState, context);
const live = await pi.snapshot(LiveDoc, lead.id, context);
const owner =
  scenario === "admission"
    ? Object.values(team?.pending ?? {})[0]
    : live?.run?.taskId;
if (!owner) {
  throw new Error("The terminal fixture has no running lead task.");
}
await pi.commit(async (tx) => {
  const worker = await tx.createConversation({
    ownership: { kind: "task", taskId: owner },
  });
  const state = await tx.doc(TeamState);
  state.children = {
    "1": { nativeId: worker.id, ownerTaskId: owner, startedAt: Date.now() },
  };
}, context);
if (scenario !== "admission") {
  await lead.submit(
    {
      type: "input",
      content: "Queued steer must not execute.",
      requestId: "queued-steer",
      whenBusy: "steer",
    },
    context
  );
  await lead.submit(
    {
      type: "input",
      content: "Queued follow-up must not execute.",
      requestId: "queued-follow-up",
      whenBusy: "followUp",
    },
    context
  );
}
await pi.commit(async (tx) => {
  const state = await tx.doc(TeamState);
  state.phase = "failed";
  state.report = Schema.decodeUnknownSync(WorkReportSchema)({
    id: "retained-report",
    kind: "failed",
    key: work.key,
    reason: "A terminal report exists before role abort.",
    contentDependencies: work.contentDependencies,
  });
}, context);
writeFileSync(
  path.join(directory, "ready.json"),
  JSON.stringify({ work, scenario })
);
await delay(60_000);
throw new Error("The parent did not terminate the terminal fixture.");
