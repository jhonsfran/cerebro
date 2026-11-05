import assert from "node:assert/strict";
import { test } from "node:test";

import { botEventId } from "../../packages/contracts/src/bot-events.ts";
import type { BotEvent } from "../../packages/contracts/src/bot-events.ts";
import { Denied, InvalidInput } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import {
  defineDoc,
  defineTask,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import type {
  EntryId,
  TaskId,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import {
  BotEventQueue,
  BotEventReceipts,
} from "../../packages/runtime/src/coordinator-event-state.ts";
import { context, setup } from "./coordinator-fixture.ts";

const ReplyIntent = defineDoc({
  kind: "fixture.exact-answer-intent",
  scope: "session",
  version: 1,
  initial: (): {
    answerId: EntryId | null;
    taskId: TaskId | null;
    applications: number;
  } => ({ answerId: null, taskId: null, applications: 0 }),
});

for (const failure of [
  {
    name: "Denied",
    create: () =>
      new Denied({ code: "revoked", reason: "Answer access was revoked." }),
  },
  {
    name: "InvalidInput",
    create: () => new InvalidInput({ reason: "Reply destination is invalid." }),
  },
]) {
  for (const boundary of ["prepare", "commit"] as const) {
    test(
      `${failure.name} at settlement ${boundary} retains the exact answer without a reply intent or pending slot`,
      { timeout: 5000 },
      async () => {
        const fixture = await setup();
        let preparations = 0;
        let createdTaskId: TaskId | undefined;
        try {
          const source = fixture.source("a");
          const replyTask = defineTask<
            Record<string, never>,
            { phase: "apply" },
            { applied: true }
          >({
            name: "fixture.rejected-reply",
            version: 1,
            initial: () => ({ phase: "apply" }),
            phases: {
              apply: (_task, runtime, invocation) =>
                runtime.commit(async (tx) => {
                  const intent = await tx.doc(ReplyIntent);
                  intent.applications += 1;
                  return {
                    status: "terminal",
                    outcome: { status: "completed", result: { applied: true } },
                  };
                }, invocation),
            },
          });
          fixture
            .registry()
            .install({ name: "fixture.rejected-reply", tasks: [replyTask] });
          fixture.setEventSettlement(async (_receipt, result) => {
            await fixture.pi().snapshot(ReplyIntent, context);
            preparations += 1;
            assert.ok(result.type === "input" && result.status === "done");
            if (boundary === "prepare") {
              throw failure.create();
            }
            return async (tx) => {
              const intent = await tx.doc(ReplyIntent);
              intent.answerId = result.answer;
              createdTaskId = await tx.createTask(
                replyTask,
                {},
                {
                  background: true,
                  conversationId: source.native.id,
                  ownership: { kind: "conversation" },
                }
              );
              intent.taskId = createdTaskId;
              throw failure.create();
            };
          });
          const origin = {
            kind: "web",
            operationId: id.operation(`rejected-${failure.name}-${boundary}`),
          } as const;
          const event: BotEvent = {
            version: 1,
            id: await botEventId(source.address, origin),
            coordinator: source.address,
            ownerPrincipalId: id.principal("owner-A"),
            source: origin,
            replyTo: null,
            content: { text: "Keep this exact answer.", reference: null },
            dependencies: { sourceIds: [], toolIds: [] },
          };
          const admitted = await fixture.events().admit(event, {
            actor: {
              id: id.principal("owner-A"),
              organizationId: id.organization("org-A"),
              kind: "human",
              state: "active",
            },
          });
          assert.ok(admitted.delivery.kind === "coordinator");
          await fixture.pi().waitForTask(admitted.delivery.taskId, context);
          const settled = await fixture
            .pi()
            .snapshot(BotEventReceipts, event.id, context);
          assert.ok(
            settled?.receipt?.delivery.kind === "coordinator" &&
              settled.receipt.delivery.admission.kind === "settled" &&
              settled.receipt.delivery.admission.outcome === "done"
          );
          const { admission } = settled.receipt.delivery;
          const submission = await fixture
            .pi()
            .submission(admission.submissionId, context);
          assert.ok(submission);
          const result = await submission.wait(context);
          assert.ok(result.type === "input" && result.status === "done");
          assert.equal(admission.entry, result.entry);
          assert.equal(admission.answer, result.answer);
          assert.equal(admission.requestId, result.requestId);
          const answer = await fixture
            .pi()
            .commit((tx) => tx.entry(admission.answer), context);
          assert.match(JSON.stringify(answer?.model), /Coordinator result/u);
          assert.equal(
            await fixture.pi().snapshot(ReplyIntent, context),
            undefined
          );
          if (createdTaskId !== undefined) {
            assert.equal(
              await fixture
                .pi()
                .commit((tx) => tx.task(createdTaskId), context),
              undefined
            );
          }
          const queue = await fixture.pi().snapshot(BotEventQueue, context);
          assert.equal(queue?.pending[event.id], undefined);
          assert.equal(preparations, 1);
          assert.equal(source.faux.state.callCount, 1);
          assert.equal(fixture.eventSubmissions.length, 1);
        } finally {
          await fixture.close();
        }
      }
    );
  }
}

test(
  "outside-prepared reply intent commits with exact settlement and recovers after rollback and reopen",
  { timeout: 10_000 },
  async () => {
    const fixture = await setup();
    const failed = Promise.withResolvers<boolean>();
    let fail = true;
    let preparations = 0;
    try {
      const source = fixture.source("a");
      const replyTask = defineTask<
        { answerId: EntryId },
        { phase: "apply" },
        { applied: true }
      >({
        name: "fixture.apply-exact-answer",
        version: 1,
        initial: () => ({ phase: "apply" }),
        phases: {
          apply: (_task, runtime, invocation) =>
            runtime.commit(async (tx) => {
              const intent = await tx.doc(ReplyIntent);
              intent.applications += 1;
              return {
                status: "terminal",
                outcome: { status: "completed", result: { applied: true } },
              };
            }, invocation),
        },
      });
      fixture
        .registry()
        .install({ name: "fixture.exact-answer", tasks: [replyTask] });
      fixture.setEventSettlement(async (_receipt, result) => {
        await fixture.pi().snapshot(ReplyIntent, context);
        preparations += 1;
        assert.ok(result.type === "input" && result.status === "done");
        return async (tx) => {
          const answer = await tx.entry(result.answer);
          assert.match(JSON.stringify(answer?.model), /Coordinator result/u);
          const intent = await tx.doc(ReplyIntent);
          intent.answerId = result.answer;
          intent.taskId = await tx.createTask(
            replyTask,
            { answerId: result.answer },
            {
              background: true,
              conversationId: source.native.id,
              ownership: { kind: "conversation" },
            }
          );
          if (fail) {
            fail = false;
            failed.resolve(true);
            throw new Error("Injected reply intent commit failure.");
          }
        };
      });
      const origin = {
        kind: "web",
        operationId: id.operation("settlement-human"),
      } as const;
      const event: BotEvent = {
        version: 1,
        id: await botEventId(source.address, origin),
        coordinator: source.address,
        ownerPrincipalId: id.principal("owner-A"),
        source: origin,
        replyTo: null,
        content: { text: "Answer this exact request.", reference: null },
        dependencies: { sourceIds: [], toolIds: [] },
      };
      const admitted = await fixture.events().admit(event, {
        actor: {
          id: id.principal("owner-A"),
          organizationId: id.organization("org-A"),
          kind: "human",
          state: "active",
        },
      });
      assert.ok(admitted.delivery.kind === "coordinator");
      await failed.promise;
      const rejected = await fixture
        .pi()
        .snapshot(BotEventReceipts, event.id, context);
      assert.ok(
        rejected?.receipt?.delivery.kind === "coordinator" &&
          rejected.receipt.delivery.admission.kind === "submitted"
      );
      assert.equal(
        await fixture.pi().snapshot(ReplyIntent, context),
        undefined
      );
      assert.equal(source.faux.state.callCount, 1);
      await fixture.reopen();
      fixture
        .registry()
        .install({ name: "fixture.exact-answer", tasks: [replyTask] });
      await fixture.pi().waitForTask(admitted.delivery.taskId, context);
      const intent = await fixture.pi().snapshot(ReplyIntent, context);
      assert.ok(intent?.taskId);
      await fixture.pi().waitForTask(intent.taskId, context);
      const settled = await fixture
        .pi()
        .snapshot(BotEventReceipts, event.id, context);
      assert.ok(
        settled?.receipt?.delivery.kind === "coordinator" &&
          settled.receipt.delivery.admission.kind === "settled" &&
          settled.receipt.delivery.admission.outcome === "done"
      );
      assert.equal(settled.receipt.delivery.admission.answer, intent.answerId);
      const resolvedValue = await fixture.pi().snapshot(ReplyIntent, context);
      assert.equal(resolvedValue?.applications, 1);
      assert.equal(fixture.eventSubmissions.length, 1);
      assert.equal(preparations, 2);
      assert.equal(fixture.source("a").faux.state.callCount, 0);
    } finally {
      await fixture.close();
    }
  }
);
