/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Publication boundaries follow real native task progress. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect } from "effect";

import { Denied, Unavailable } from "../../packages/contracts/src/failures.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  AgentDoc,
  defineTask,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { Bindings } from "../../packages/runtime/src/conversation-bindings.ts";
import { nativeDrainIn } from "../../packages/runtime/src/conversation-drain.ts";
import { BotEventQueue } from "../../packages/runtime/src/coordinator-event-state.ts";
import {
  WorkDocuments,
  WorkLedger,
} from "../../packages/runtime/src/coordinator-ledger.ts";
import { context } from "./coordinator-fixture.ts";
import { actor, setupWeb } from "./coordinator-web-fixture.ts";
import { waitFor } from "./helpers.ts";

const binding = async (subject: Awaited<ReturnType<typeof setupWeb>>) => {
  const saved = await subject.fixture.pi().snapshot(Bindings, context);
  const value = saved?.conversations[subject.source.address.sessionId];
  assert.ok(value);
  return value;
};
const settle = async (subject: Awaited<ReturnType<typeof setupWeb>>) => {
  await waitFor(
    async () => {
      const queue = await subject.fixture.pi().snapshot(BotEventQueue, context);
      return Object.values(queue?.pending ?? {}).filter(
        (entry) => entry.nativeId === subject.source.native.id
      ).length;
    },
    (count) => count === 0
  );
};

test("an unchanged definition keeps its conversation state and native selection across a send", async () => {
  const subject = await setupWeb(false, true);
  try {
    const { approvals } = subject.scope.runtime;
    await subject.scope.reminders.schedule(
      { instruction: "Keep the schedule.", runAt: Date.now() + 60_000 },
      "retained"
    );
    const before = await subject.source.native.entries(
      {},
      64,
      undefined,
      context
    );
    const old = await subject.fixture
      .pi()
      .snapshot(AgentDoc, subject.source.native.id, context);
    assert.deepEqual(old?.extensions, ["cerebro-tools:source-a:v1"]);
    const response = await subject.send(
      "same-definition",
      "Explain the current policy."
    );
    assert.equal(response.status, 200, await response.clone().text());
    await settle(subject);
    assert.equal((await binding(subject)).agentVersion, 1);
    assert.equal((await binding(subject)).nativeId, subject.source.native.id);
    assert.equal(subject.scope.runtime.approvals, approvals);
    assert.equal(
      (await subject.scope.reminders.list())[0]?.id,
      "reminder:retained"
    );
    const agent = await subject.fixture
      .pi()
      .snapshot(AgentDoc, subject.source.native.id, context);
    assert.deepEqual(agent?.extensions, ["cerebro-tools:source-a:v1"]);
    assert.equal(agent?.tools, undefined);
    assert.equal(agent?.modelTools, undefined);
    assert.equal(agent?.model?.provider, "cerebro:source-a:v1");
    const names = subject.fixture
      .registry()
      .snapshot()
      .extension("cerebro-tools:source-a:v1")
      ?.tools?.map((tool) => tool.name);
    assert.ok(names?.includes("schedule"));
    const after = await subject.source.native.entries(
      {},
      64,
      undefined,
      context
    );
    for (const entry of before.items) {
      assert.ok(after.items.some((candidate) => candidate.id === entry.id));
    }
  } finally {
    await subject.close();
  }
});

test("a published profile waits for an old native request and changes physical model, instructions, input, and tools together", async () => {
  const subject = await setupWeb(false, true);
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  try {
    subject.source.faux.setResponses([
      async () => {
        entered.resolve(true);
        await release.promise;
        return fauxAssistantMessage("Original answer.");
      },
    ]);
    const old = await subject.source.native.submit(
      {
        type: "input",
        requestId: "old-native",
        content: "Finish under version one.",
      },
      context
    );
    subject.fixture.pi().resume();
    await entered.promise;
    const next = subject.fixture.source("b").faux;
    const recorded: unknown[] = [];
    const offered = new Set<string>();
    next.setResponses([
      (request, options, _state, model) => {
        recorded.push({ request, options, model });
        for (const message of request.messages) {
          if (message.role !== "system") {
            continue;
          }
          for (const tool of message.toolsAdded ?? []) {
            offered.add(tool.name);
          }
          for (const tool of message.toolsRemoved ?? []) {
            offered.delete(tool.name);
          }
        }
        return fauxAssistantMessage("New answer.");
      },
    ]);
    subject.publish({
      ...subject.configuration,
      agent: {
        ...subject.configuration.agent,
        version: 2,
        instructions: "Version two instructions.",
        model: "coordinator-b/test",
      },
      provider: {
        ...subject.configuration.provider,
        model: next.getModel(),
        provider: next.provider,
      },
      prepareInput: (text) => Effect.succeed(`${text}\nCurrent memory grant.`),
    });
    await subject.send("new-native", "Use the new profile.");
    await waitFor(
      () => binding(subject),
      (value) => value.refresh?.agentVersion === 2
    );
    assert.equal((await binding(subject)).agentVersion, 1);
    assert.equal(next.state.callCount, 0);
    release.resolve(true);
    await old.wait(context);
    await settle(subject);
    assert.equal((await binding(subject)).agentVersion, 2);
    assert.equal(recorded.length, 1);
    const request = JSON.stringify(recorded[0]);
    assert.ok(request.includes("Version two instructions."));
    assert.ok(request.includes("Current memory grant."));
    assert.ok(request.includes("coordinator-b"));
    assert.equal((await subject.scope.read(actor)).agentVersion, 2);
  } finally {
    release.resolve(true);
    await subject.close();
  }
});

test("background tasks and tasks beyond the first page block native activation", async () => {
  const subject = await setupWeb(false, true);
  const held = defineTask({
    name: "fixture.profile-background",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (_task, runtime, invocation) => {
        await runtime.sleep(Date.now() + 60_000, invocation);
      },
    },
  });
  try {
    subject.fixture
      .registry()
      .install({ name: "fixture.profile-background", tasks: [held] });
    const ids = await subject.fixture.pi().commit(async (tx) => {
      const created = [];
      for (let index = 0; index < 70; index += 1) {
        created.push(
          await tx.createTask(
            held,
            {},
            {
              conversationId: subject.source.native.id,
              ownership: { kind: "conversation" },
              background: true,
            }
          )
        );
      }
      return created;
    }, context);
    assert.equal(
      await subject.fixture
        .pi()
        .commit((tx) => nativeDrainIn(tx, subject.source.native.id), context),
      false
    );
    await subject.source.native.waitForIdle(context);
    subject.publish({
      ...subject.configuration,
      agent: { ...subject.configuration.agent, version: 2 },
    });
    await subject.send(
      "background-boundary",
      "Wait for native background work."
    );
    await waitFor(
      () => binding(subject),
      (value) => value.refresh !== null
    );
    assert.equal((await binding(subject)).agentVersion, 1);
    for (const task of ids.slice(0, 69)) {
      await subject.fixture.pi().abortTask(task, context);
    }
    assert.equal(
      await subject.fixture
        .pi()
        .commit((tx) => nativeDrainIn(tx, subject.source.native.id), context),
      false
    );
    await subject.fixture.pi().abortTask(ids[69], context);
    await settle(subject);
    assert.equal((await binding(subject)).agentVersion, 2);
  } finally {
    await subject.close();
  }
});

test("an unprepared adopted binding makes the scope unavailable synchronously", async () => {
  const subject = await setupWeb(false, true);
  try {
    await subject.fixture.pi().commit(async (tx) => {
      const bindings = await tx.doc(Bindings);
      bindings.conversations[subject.source.address.sessionId].agentVersion =
        99;
    }, context);
    await assert.rejects(
      subject.scope.read(actor),
      (error: unknown) =>
        error instanceof Unavailable &&
        error.reason === "The conversation profile is unavailable."
    );
    assert.deepEqual(subject.recoveries, ["requested"]);
    assert.equal(subject.source.faux.state.callCount, 0);
  } finally {
    await subject.close();
  }
});

test("a delayed authenticated schedule control repeats authorization before the first durable write", async () => {
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  let delay = false;
  const subject = await setupWeb(false, true, (configuration) => ({
    ...configuration,
    authority: {
      ...configuration.authority,
      require: (request, options) => {
        if (delay && request.action === "execute" && request.model) {
          delay = false;
          return Effect.tryPromise(async () => {
            entered.resolve(true);
            await release.promise;
            return { request, policyVersion: "old", evaluatedAt: Date.now() };
          });
        }
        return configuration.authority.require(request, options);
      },
    },
  }));
  try {
    delay = true;
    const scheduling = subject.scope.handle(
      new Request("https://session.internal/control", {
        method: "POST",
        body: JSON.stringify({
          command: {
            kind: "schedule",
            operationId: "stale-control",
            instruction: "Never create this instruction.",
            runAt: Date.now() + 60_000,
          },
        }),
      }),
      actor
    );
    await entered.promise;
    subject.publish({
      ...subject.configuration,
      agent: { ...subject.configuration.agent, version: 2 },
      authority: {
        ...subject.configuration.authority,
        require: (request, options) =>
          request.action === "execute" && request.model
            ? Effect.fail(
                new Denied({ code: "revoked", reason: "New execution denied." })
              )
            : subject.configuration.authority.require(request, options),
      },
    });
    await subject.send("adopt-during-control", "Adopt the new profile.");
    await waitFor(
      () => binding(subject),
      (value) => value.agentVersion === 2
    );
    release.resolve(true);
    assert.equal((await scheduling).status, 403);
    assert.deepEqual(await subject.scope.reminders.list(), []);
    assert.equal(
      subject.fixture.jobs.has(
        "cerebro-reminder:source-a:reminder:stale-control"
      ),
      false
    );
  } finally {
    release.resolve(true);
    await subject.close();
  }
});

test("report turns without a human cause cannot leave a new durable schedule", async () => {
  const subject = await setupWeb(true, true);
  try {
    subject.source.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("schedule", {
          delaySeconds: 60,
          instruction: "Start a Team later.",
        }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("The unauthorized routine was rejected."),
    ]);
    const submitted = await subject.source.native.submit(
      {
        type: "input",
        requestId: "retained-report",
        content: "This is a Team report.",
        entry: {
          kind: "cerebro.bot-event-input",
          data: {
            eventId: "retained-report",
            source: "teamreport",
            agentVersion: 1,
          },
        },
      },
      context
    );
    await submitted.wait(context);
    assert.deepEqual(await subject.scope.reminders.list(), []);
    assert.equal(
      [...subject.fixture.jobs.values()].filter(
        (job) => job.fn === "cerebro-reminder"
      ).length,
      0
    );
  } finally {
    await subject.close();
  }
});

test("a frozen publication admits the oldest held event before a later publication", async () => {
  const subject = await setupWeb(false, true);
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  try {
    subject.source.faux.setResponses([
      async () => {
        entered.resolve(true);
        await release.promise;
        return fauxAssistantMessage("Original execution finished.");
      },
      fauxAssistantMessage("First held event."),
      fauxAssistantMessage("Second held event."),
    ]);
    const prior = await subject.source.native.submit(
      {
        type: "input",
        requestId: "before-publications",
        content: "Keep the old execution.",
      },
      context
    );
    subject.fixture.pi().resume();
    await entered.promise;
    subject.publish({
      ...subject.configuration,
      agent: { ...subject.configuration.agent, version: 2 },
    });
    await subject.send("oldest-held", "Admit this first.");
    await waitFor(
      () => binding(subject),
      (value) => value.refresh?.agentVersion === 2
    );
    subject.publish({
      ...subject.configuration,
      agent: { ...subject.configuration.agent, version: 3 },
    });
    await subject.send("later-held", "Admit this second.");
    release.resolve(true);
    await prior.wait(context);
    await settle(subject);
    const entries = await subject.source.native.entries(
      {},
      64,
      undefined,
      context
    );
    const heldEntries = entries.items
      .filter((entry) => entry.kind === "cerebro.bot-event-input")
      .toSorted((left, right) => left.id - right.id);
    assert.equal(heldEntries[0]?.data.agentVersion, 2);
    assert.equal(heldEntries[1]?.data.agentVersion, 3);
    assert.equal(heldEntries[0]?.data.operationId, "oldest-held");
    assert.equal((await binding(subject)).agentVersion, 3);
  } finally {
    release.resolve(true);
    await subject.close();
  }
});

test("existing active and queued Team admissions keep their role pins while new work resolves current pins", async () => {
  const subject = await setupWeb(true, true);
  try {
    for (let index = 0; index < 3; index += 1) {
      await subject.fixture.invoke(
        "a",
        "start_team",
        { goal: `Independent original work ${index}.` },
        `original-team-${index}`
      );
    }
    await subject.fixture.waitDispatch();
    const savedLedger = await subject.fixture
      .pi()
      .snapshot(WorkLedger, context);
    const oldIds = [
      ...Object.keys(savedLedger?.active ?? {}),
      ...(savedLedger?.queue.map((item) => item.workId) ?? []),
    ];
    assert.equal(oldIds.length, 3);
    const old = await Promise.all(
      oldIds.map((workId) =>
        subject.fixture.pi().snapshot(WorkDocuments, workId, context)
      )
    );
    const admissions = old.map((document) =>
      JSON.stringify(document?.record?.admission)
    );
    subject.fixture.setPinVersion(9);
    subject.publish({
      ...subject.configuration,
      agent: { ...subject.configuration.agent, version: 2 },
    });
    await subject.send(
      "refresh-with-private-teams",
      "Keep coordinating the existing work."
    );
    await settle(subject);
    assert.equal((await binding(subject)).agentVersion, 2);
    for (const [index, workId] of oldIds.entries()) {
      const document = await subject.fixture
        .pi()
        .snapshot(WorkDocuments, workId, context);
      assert.equal(
        JSON.stringify(document?.record?.admission),
        admissions[index]
      );
    }
    await subject.fixture.invoke(
      "a",
      "start_team",
      { goal: "A new independent task with current role pins." },
      "new-team-pins"
    );
    const current = await subject.scope.coordination.current();
    assert.ok(current);
    const newest = await subject.fixture
      .pi()
      .snapshot(WorkDocuments, current.workId, context);
    assert.equal(newest?.record?.admission.lead.agentVersion, 9);
    assert.equal(newest?.record?.admission.worker.agentVersion, 9);
  } finally {
    await subject.close();
  }
});

test("idle native child selections retain their exact profile while unselected publications are removed", async () => {
  const subject = await setupWeb(false, true);
  const childTask = defineTask({
    name: "fixture.profile-child",
    version: 1,
    initial: () => ({ phase: "create", id: 0 }),
    phases: {
      create: async (_task, runtime, invocation) =>
        await runtime.commit(async (tx) => {
          const child = await tx.createConversation({
            ownership: { kind: "task", taskId: runtime.taskId },
          });
          return {
            status: "running",
            checkpoint: { phase: "finish", id: child.id },
          };
        }, invocation),
      finish: async (task, runtime, invocation) =>
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: {
              status: "completed",
              result: { id: task.state.checkpoint.id },
            },
          }),
          invocation
        ),
    },
  });
  try {
    await subject.send("initial-policy", "Adopt the coordinator policy.");
    await settle(subject);
    subject.fixture
      .registry()
      .install({ name: "fixture.profile-child", tasks: [childTask] });
    const taskId = await subject.fixture.pi().commit(
      (tx) =>
        tx.createTask(
          childTask,
          {},
          {
            conversationId: subject.source.native.id,
            ownership: { kind: "conversation" },
          }
        ),
      context
    );
    const task = await subject.fixture.pi().waitForTask(taskId, context);
    assert.equal(task.state.status, "terminal");
    assert.equal(
      task.state.outcome.status,
      "completed",
      JSON.stringify(task.state)
    );
    const childId = task.state.outcome.result.id;
    const oldProvider = "cerebro:source-a:v1";
    const oldExtension = "cerebro-tools:source-a:v1";
    subject.publish({
      ...subject.configuration,
      agent: { ...subject.configuration.agent, version: 2 },
    });
    await subject.send("second-policy", "Use definition two.");
    await settle(subject);
    assert.ok(subject.fixture.models().getModel(oldProvider, "test"));
    assert.ok(subject.fixture.registry().snapshot().extension(oldExtension));
    const childAgent = await subject.fixture
      .pi()
      .snapshot(AgentDoc, childId, context);
    assert.equal(childAgent?.model?.provider, oldProvider);
    const child = await subject.fixture.pi().conversation(childId, context);
    assert.ok(child);
    await child.configure({ model: null, extensions: [] }, context);
    subject.publish({
      ...subject.configuration,
      agent: { ...subject.configuration.agent, version: 3 },
    });
    await subject.send("third-policy", "Use definition three.");
    await settle(subject);
    assert.equal(
      subject.fixture.models().getModel(oldProvider, "test"),
      undefined
    );
    assert.equal(
      subject.fixture.registry().snapshot().extension(oldExtension),
      undefined
    );
    assert.equal(
      subject.fixture.models().getModel("cerebro:source-a:v2", "test"),
      undefined
    );
    assert.ok(subject.fixture.models().getModel("cerebro:source-a:v3", "test"));
  } finally {
    await subject.close();
  }
});

test("a real retained no-Team human input can schedule and its accepted fingerprint replays", async () => {
  const subject = await setupWeb(false, true);
  try {
    subject.source.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("schedule", {
          delaySeconds: 60,
          instruction: "An authorized retained human routine.",
        }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("The routine is saved."),
    ]);
    const input = await subject.source.native.submit(
      {
        type: "input",
        requestId: "retained-human",
        content: "Save this reminder.",
      },
      context
    );
    await input.wait(context);
    const schedules = await subject.scope.reminders.list();
    assert.equal(schedules.length, 1);
    const [saved] = schedules;
    assert.ok(saved);
    const replay = await subject.scope.reminders.schedule(
      { instruction: saved.instruction, runAt: saved.runAt },
      saved.id.slice("reminder:".length),
      undefined,
      (change) => subject.fixture.pi().commit(change, context)
    );
    assert.equal(replay.id, saved.id);
    assert.equal(
      [...subject.fixture.jobs.values()].filter(
        (job) => job.fn === "cerebro-reminder"
      ).length,
      1
    );
  } finally {
    await subject.close();
  }
});

test("a fresh coordinator starts with its complete policy instructions and explicit native selection", async () => {
  const subject = await setupWeb(false, true);
  try {
    const agent = await subject.fixture
      .pi()
      .snapshot(AgentDoc, subject.source.native.id, context);
    assert.equal(agent?.model?.provider, "cerebro:source-a:v1");
    assert.ok(agent?.instructions?.includes("coordinate independent work"));
    const response = await subject.send(
      "fresh-policy",
      "Answer with the complete initial profile."
    );
    assert.equal(response.status, 200, await response.clone().text());
    await settle(subject);
    assert.equal((await binding(subject)).agentVersion, 1);
    assert.equal(subject.source.faux.state.callCount, 1);
  } finally {
    await subject.close();
  }
});
