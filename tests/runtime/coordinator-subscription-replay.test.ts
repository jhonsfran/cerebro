import assert from "node:assert/strict";
import { test } from "node:test";

import { digestToolArguments } from "../../packages/contracts/src/tools.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import type {
  TaskId,
  ToolExecutionApi,
  ToolExecutionResult,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import {
  ThreadSubscriptions,
  SubscriptionMutations,
  WorkSubscriptions,
} from "../../packages/runtime/src/coordinator-subscriptions.ts";
import type { SubscriptionFixture } from "./subscription-fixture.ts";
import {
  admit,
  context,
  eventFor,
  setup,
  start,
  subscribe,
} from "./subscription-fixture.ts";

type MutationName = "subscribe_work" | "unsubscribe_work";
interface MutationArguments {
  workId: string;
  eventId: string;
}
interface NativeInvocation {
  taskId: TaskId;
  result: ToolExecutionResult;
}
const mutationTool = (fixture: SubscriptionFixture, name: MutationName) => {
  const tool = fixture
    .source("a")
    .subscriptions.tools.find((candidate) => candidate.name === name);
  assert.ok(tool);
  return tool;
};
const relations = async (
  fixture: SubscriptionFixture,
  args: MutationArguments
) => {
  const reverse = await fixture
    .pi()
    .snapshot(WorkSubscriptions, args.workId, context);
  const keys = reverse?.record?.threadKeys ?? [];
  const threads = await Promise.all(
    keys.map(async (key) => {
      const saved = await fixture
        .pi()
        .snapshot(ThreadSubscriptions, key, context);
      assert.ok(saved?.record);
      return saved.record.workIds;
    })
  );
  return { keys, threads };
};
const lostMutationResult = async (
  fixture: SubscriptionFixture,
  args: MutationArguments,
  name: MutationName,
  inverse = false
) => {
  const source = fixture.source("a");
  const tool = mutationTool(fixture, name);
  const otherName =
    name === "subscribe_work" ? "unsubscribe_work" : "subscribe_work";
  const other = mutationTool(fixture, otherName);
  const committed = Promise.withResolvers<NativeInvocation>();
  const inverted = Promise.withResolvers<TaskId>();
  fixture.registry().install({
    name: "source-a",
    tasks: source.coordinator.tasks,
    tools: [
      ...source.coordinator.tools,
      {
        ...tool,
        execute: async (input, api, invocation) => {
          const result = await tool.execute(input, api, invocation);
          assert.equal(result.isError, undefined);
          committed.resolve({ taskId: api.taskId, result });
          const stopped = Promise.withResolvers<never>();
          assert.ok(invocation.abortSignal);
          invocation.abortSignal.addEventListener(
            "abort",
            () =>
              stopped.reject(
                new Error("Fixture stopped before tool settlement.")
              ),
            { once: true }
          );
          await stopped.promise;
          return result;
        },
      },
      {
        ...other,
        execute: async (input, api, invocation) => {
          await committed.promise;
          const result = await other.execute(input, api, invocation);
          assert.equal(result.isError, undefined);
          inverted.resolve(api.taskId);
          return result;
        },
      },
    ],
  });
  source.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall(name, { ...args }, { id: "old-mutation" }),
        ...(inverse
          ? [fauxToolCall(otherName, { ...args }, { id: "later-inverse" })]
          : []),
      ],
      { stopReason: "toolUse" }
    ),
    fauxAssistantMessage("The subscription request is handled."),
  ]);
  await source.native.submit(
    {
      type: "input",
      content: "Update this work's Slack subscription.",
      requestId: "lost-subscription-result",
    },
    context
  );
  const first = await committed.promise;
  if (inverse) {
    const taskId = await inverted.promise;
    const terminal = await fixture.pi().waitForTask(taskId, context);
    assert.equal(terminal.state.outcome.status, "completed");
    assert.notEqual(taskId, first.taskId);
  }
  const pending = await fixture
    .pi()
    .commit((tx) => tx.task(first.taskId), context);
  assert.ok(pending?.state.status === "running");
  assert.equal(pending.state.checkpoint.phase, "execute");
  return first;
};
const recoveredResult = async (
  fixture: SubscriptionFixture,
  taskId: TaskId
) => {
  const task = await fixture.pi().waitForTask(taskId, context);
  assert.equal(task.state.outcome.status, "completed");
  const entries = await fixture
    .source("a")
    .native.entries({}, 128, undefined, context);
  const entry = entries.items.find(
    (candidate) => candidate.byTaskId === taskId
  );
  assert.ok(entry);
  const message = entry.model?.find(
    (candidate) => candidate.role === "toolResult"
  );
  assert.ok(message?.role === "toolResult");
  return { isError: message.isError, output: message.content };
};

for (const scenario of [
  { name: "subscribe_work", initial: false, expected: false, noop: false },
  { name: "unsubscribe_work", initial: true, expected: true, noop: false },
  { name: "subscribe_work", initial: true, expected: false, noop: true },
  { name: "unsubscribe_work", initial: false, expected: true, noop: true },
] satisfies {
  name: MutationName;
  initial: boolean;
  expected: boolean;
  noop: boolean;
}[]) {
  test(`${scenario.name} replay preserves a later inverse after a ${scenario.noop ? "no-op" : "relation change"}`, async () => {
    const fixture = await setup();
    try {
      const work = await start(fixture, "Prepare a storage recommendation.");
      const seed = await eventFor(fixture, "replay-reference");
      await admit(fixture, seed);
      const args = { workId: work.admission.key.workId, eventId: seed.id };
      if (scenario.initial) {
        await subscribe(fixture, args.workId, args.eventId);
      }
      const first = await lostMutationResult(
        fixture,
        args,
        scenario.name,
        true
      );
      const before = await relations(fixture, args);
      assert.equal(before.keys.length, scenario.expected ? 1 : 0);
      if (scenario.expected) {
        assert.deepEqual(before.threads, [[args.workId]]);
      }
      await fixture.reopen();
      const result = await recoveredResult(fixture, first.taskId);
      assert.equal(result.isError, false, JSON.stringify(result.output));
      assert.deepEqual(result.output, first.result.output);
      assert.deepEqual(await relations(fixture, args), before);
    } finally {
      await fixture.close();
    }
  });
}

test("a committed subscribe replays its original result after terminal work without restoring a removed relation", async () => {
  const fixture = await setup();
  try {
    const work = await start(fixture, "Finish the storage review.");
    const seed = await eventFor(fixture, "terminal-reference");
    await admit(fixture, seed);
    const args = { workId: work.admission.key.workId, eventId: seed.id };
    const first = await lostMutationResult(
      fixture,
      args,
      "subscribe_work",
      true
    );
    await fixture.report("a", "completed-after-subscription");
    const completed = await fixture.work("a");
    assert.equal(completed.status.kind, "completed");
    await fixture.reopen();
    const result = await recoveredResult(fixture, first.taskId);
    assert.equal(result.isError, false, JSON.stringify(result.output));
    assert.deepEqual(result.output, first.result.output);
    assert.deepEqual(await relations(fixture, args), { keys: [], threads: [] });
    const retained = await fixture.work("a");
    assert.equal(retained.status.kind, "completed");
  } finally {
    await fixture.close();
  }
});

for (const denial of ["source", "content"] as const) {
  test(`a saved mutation result requires current ${denial} access on replay`, async () => {
    const fixture = await setup();
    try {
      const work = await start(fixture, "Use the current project source.");
      const seed = await eventFor(fixture, "revocation-reference");
      await admit(fixture, seed);
      const args = { workId: work.admission.key.workId, eventId: seed.id };
      const first = await lostMutationResult(
        fixture,
        args,
        "subscribe_work",
        true
      );
      const receipt = await fixture
        .pi()
        .snapshot(
          SubscriptionMutations,
          fixture.source("a").native.id,
          String(first.taskId),
          context
        );
      assert.deepEqual(receipt?.receipt?.result, { ...args, subscribed: true });
      if (denial === "source") {
        fixture.revoke("a");
      } else {
        fixture.revokeContent("source-A");
      }
      await fixture.reopen();
      const result = await recoveredResult(fixture, first.taskId);
      assert.equal(result.isError, true);
      assert.deepEqual(result.output, [
        {
          type: "text",
          text:
            denial === "source"
              ? "Source access revoked."
              : "Content access revoked.",
        },
      ]);
      assert.deepEqual(await relations(fixture, args), {
        keys: [],
        threads: [],
      });
      assert.deepEqual(
        await fixture
          .pi()
          .snapshot(
            SubscriptionMutations,
            fixture.source("a").native.id,
            String(first.taskId),
            context
          ),
        receipt
      );
    } finally {
      await fixture.close();
    }
  });
}

for (const changed of ["event", "work", "action"] as const) {
  test(`the same native task rejects a changed subscription ${changed}`, async () => {
    const fixture = await setup();
    try {
      const work = await start(fixture, "The original subscription target.");
      const other = await start(fixture, "Another authorized work item.");
      const seed = await eventFor(fixture, "exact-reference");
      const extra = await eventFor(fixture, "another-authorized-reference");
      await admit(fixture, seed);
      await admit(fixture, extra);
      const args = { workId: work.admission.key.workId, eventId: seed.id };
      const source = fixture.source("a");
      const tool = mutationTool(fixture, "subscribe_work");
      const inverse = mutationTool(fixture, "unsubscribe_work");
      const checked = Promise.withResolvers<NativeInvocation>();
      fixture.registry().install({
        name: "source-a",
        tasks: source.coordinator.tasks,
        tools: [
          ...source.coordinator.tools,
          inverse,
          {
            ...tool,
            execute: async (input, api, invocation) => {
              const original = await tool.execute(input, api, invocation);
              assert.equal(original.isError, undefined);
              const replacement = {
                workId:
                  changed === "work"
                    ? other.admission.key.workId
                    : input.workId,
                eventId: changed === "event" ? extra.id : input.eventId,
              };
              const result = await (
                changed === "action" ? inverse : tool
              ).execute(replacement, api, invocation);
              checked.resolve({ taskId: api.taskId, result });
              return result;
            },
          },
        ],
      });
      await fixture.invoke("a", "subscribe_work", args, `conflict-${changed}`);
      const result = await checked.promise;
      assert.equal(result.result.isError, true);
      assert.deepEqual(result.result.output, [
        {
          type: "text",
          text: "The subscription operation names another payload.",
        },
      ]);
      const receipt = await fixture
        .pi()
        .snapshot(
          SubscriptionMutations,
          source.native.id,
          String(result.taskId),
          context
        );
      assert.deepEqual(receipt?.receipt?.result, { ...args, subscribed: true });
      const relation = await relations(fixture, args);
      assert.equal(relation.keys.length, 1);
      assert.deepEqual(
        await relations(fixture, {
          ...args,
          workId: other.admission.key.workId,
        }),
        { keys: [], threads: [] }
      );
    } finally {
      await fixture.close();
    }
  });
}

test("a rejected native commit rolls back both subscription directions and the receipt before retry", async () => {
  const fixture = await setup();
  try {
    const work = await start(fixture, "Subscribe atomically.");
    const seed = await eventFor(fixture, "rollback-reference");
    await admit(fixture, seed);
    const args = { workId: work.admission.key.workId, eventId: seed.id };
    const source = fixture.source("a");
    assert.ok(seed.source.kind === "slack");
    const key = await digestToolArguments([
      source.address.organizationId,
      source.ownerPrincipalId,
      source.address.agentId,
      source.address.conversationId,
      source.address.sessionId,
      seed.source.thread.workspaceId,
      seed.source.thread.channelId,
      seed.source.thread.rootTimestamp,
    ]);
    const before = await fixture
      .pi()
      .snapshot(ThreadSubscriptions, key, context);
    assert.deepEqual(before?.record?.workIds, []);
    const tool = mutationTool(fixture, "subscribe_work");
    const checked = Promise.withResolvers<NativeInvocation>();
    fixture.registry().install({
      name: "source-a",
      tasks: source.coordinator.tasks,
      tools: [
        ...source.coordinator.tools,
        mutationTool(fixture, "unsubscribe_work"),
        {
          ...tool,
          execute: async (input, api, invocation) => {
            try {
              const rollback: ToolExecutionApi["commit"] = (change, caller) =>
                api.commit(async (tx) => {
                  await change(tx);
                  throw new Error(
                    "Reject this native transaction before persistence."
                  );
                }, caller);
              const rejected = await tool.execute(
                input,
                { ...api, commit: rollback },
                invocation
              );
              assert.equal(rejected.isError, true);
              assert.deepEqual(
                await fixture.pi().snapshot(ThreadSubscriptions, key, context),
                before
              );
              assert.equal(
                await fixture
                  .pi()
                  .snapshot(WorkSubscriptions, args.workId, context),
                undefined
              );
              assert.equal(
                await fixture
                  .pi()
                  .snapshot(
                    SubscriptionMutations,
                    source.native.id,
                    String(api.taskId),
                    context
                  ),
                undefined
              );
              const result = await tool.execute(input, api, invocation);
              checked.resolve({ taskId: api.taskId, result });
              return result;
            } catch (error) {
              checked.reject(error);
              throw error;
            }
          },
        },
      ],
    });
    const [, completed] = await Promise.all([
      fixture.invoke("a", "subscribe_work", args, "rollback-then-retry"),
      checked.promise,
    ]);
    assert.equal(completed.result.isError, undefined);
    const committed = await relations(fixture, args);
    assert.deepEqual(committed.threads, [[args.workId]]);
    const receipt = await fixture
      .pi()
      .snapshot(
        SubscriptionMutations,
        source.native.id,
        String(completed.taskId),
        context
      );
    assert.deepEqual(receipt?.receipt?.result, { ...args, subscribed: true });
    await fixture.reopen();
    const retained = await relations(fixture, args);
    assert.deepEqual(retained.threads, [[args.workId]]);
  } finally {
    await fixture.close();
  }
});
