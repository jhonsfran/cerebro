import assert from "node:assert/strict";
import { test } from "node:test";

import { Schema } from "effect";

import { botEventId } from "../../packages/contracts/src/bot-events.ts";
import type { BotEvent } from "../../packages/contracts/src/bot-events.ts";
import { Denied } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import {
  WorkIdSchema,
  WorkReportIdSchema,
} from "../../packages/contracts/src/work.ts";
import {
  Type,
  fauxAssistantMessage,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  defineDoc,
  defineTool,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { BotEventReceipts } from "../../packages/runtime/src/coordinator-event-state.ts";
import { prepareInstructionCause } from "../../packages/runtime/src/instruction-cause.ts";
import { context } from "./coordinator-fixture.ts";
import { actor, setupWeb } from "./coordinator-web-fixture.ts";

const FutureInstructions = defineDoc({
  kind: "fixture.authorized-future-instructions",
  scope: "conversation",
  version: 1,
  initial: (): { causes: string[] } => ({ causes: [] }),
});
const externalEvent = async (
  subject: Awaited<ReturnType<typeof setupWeb>>,
  source: BotEvent["source"]
): Promise<BotEvent> => ({
  version: 1,
  id: await botEventId(subject.source.address, source),
  coordinator: subject.source.address,
  ownerPrincipalId: actor.actor.id,
  source,
  replyTo: null,
  content: { text: "Start a bounded storage design task.", reference: null },
  dependencies: { sourceIds: [], toolIds: [] },
});
const finish = async (
  subject: Awaited<ReturnType<typeof setupWeb>>,
  event: BotEvent
) => {
  const saved = await subject.fixture
    .pi()
    .snapshot(BotEventReceipts, event.id, context);
  assert.ok(saved?.receipt?.delivery.kind === "coordinator");
  await subject.fixture
    .pi()
    .waitForTask(saved.receipt.delivery.taskId, context);
};
const installFutureTool = async (
  subject: Awaited<ReturnType<typeof setupWeb>>
) => {
  const tool = defineTool({
    name: "create_future_instruction",
    callers: ["model"],
    replay: "safe",
    parameters: Type.Object({}),
    execute: async (_args, api, invocation) => {
      const causeIn = await prepareInstructionCause({
        pi: subject.fixture.pi(),
        nativeId: subject.source.native.id,
        address: subject.source.address,
        ownerPrincipalId: actor.actor.id,
      });
      await api.commit(async (tx) => {
        const cause = await causeIn(tx);
        const document = await tx.doc(
          FutureInstructions,
          subject.source.native.id
        );
        document.causes.push(cause.operationId);
      }, invocation);
      return {
        output: [
          { type: "text", text: "The future instruction was admitted." },
        ],
      };
    },
  });
  const extension = { name: "fixture.future-instruction", tools: [tool] };
  subject.fixture.registry().install(extension);
  await subject.source.native.configure(
    { extensions: { add: [extension] } },
    context
  );
};

for (const kind of ["web", "slack", "savedtimer"] as const) {
  test(`a real native ${kind} event authorizes independent Team work`, async () => {
    const subject = await setupWeb(true);
    try {
      subject.source.faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("start_team", { goal: "Compare two storage designs." }),
          { stopReason: "toolUse" }
        ),
        fauxAssistantMessage("The independent team was admitted."),
      ]);
      let source: BotEvent["source"] = {
        kind: "web",
        operationId: id.operation("web-cause"),
      };
      if (kind === "slack") {
        source = {
          kind,
          eventId: "slack-cause",
          thread: {
            workspaceId: "T123",
            channelId: "D123",
            rootTimestamp: "123.456000",
          },
        };
      }
      if (kind === "savedtimer") {
        source = { kind, scheduleId: "saved-routine", occurrenceId: "123" };
      }
      const event = await externalEvent(subject, source);
      await subject.events.admit(
        {
          version: 2,
          kind: "event-admission",
          event,
          routing: { kind: "automatic" },
        },
        actor
      );
      await finish(subject, event);
      await subject.fixture.waitDispatch();
      const work = await subject.fixture.work("a");
      assert.equal(work.humanOperationId, event.id);
      assert.equal(work.admission.goal, "Compare two storage designs.");
      assert.equal(
        subject.fixture.calls.filter((command) => command.kind === "start")
          .length,
        1
      );
    } finally {
      await subject.close();
    }
  });
}

test("a report cannot start a Team or mint authority for a future routine", async () => {
  const subject = await setupWeb(true);
  try {
    await installFutureTool(subject);
    subject.source.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("start_team", { goal: "Unrequested extra task." }),
          fauxToolCall("create_future_instruction", {}),
        ],
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("The report was handled without new work."),
    ]);
    const event = await externalEvent(subject, {
      kind: "teamreport",
      key: {
        organizationId: subject.source.address.organizationId,
        ownerPrincipalId: actor.actor.id,
        workId: Schema.decodeUnknownSync(WorkIdSchema)("completed-work"),
      },
      reportId: Schema.decodeUnknownSync(WorkReportIdSchema)("report-cause"),
      outcome: "completed",
    });
    await subject.events.admit(event, actor);
    await finish(subject, event);
    const view = await subject.scope.read(actor);
    assert.equal(subject.fixture.calls.length, 0);
    const resolvedValue = await subject.fixture
      .pi()
      .snapshot(FutureInstructions, subject.source.native.id, context);
    assert.equal(resolvedValue?.causes.length ?? 0, 0);
    assert.deepEqual(
      Object.fromEntries(view.tools.map((tool) => [tool.toolName, tool.state])),
      { start_team: "failed", create_future_instruction: "failed" }
    );
  } finally {
    await subject.close();
  }
});

test("an arbitrary custom entry cannot mint a future instruction", async () => {
  const subject = await setupWeb();
  try {
    await installFutureTool(subject);
    subject.source.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("create_future_instruction", {}), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("The custom entry was rejected."),
    ]);
    const submission = await subject.source.native.submit(
      {
        type: "input",
        content: "Create a future task.",
        requestId: "unowned-custom-input",
        entry: {
          kind: "cerebro.bot-event-input",
          data: {
            eventId: "unowned-custom-input",
            source: "web",
            operationId: "fake-human",
            agentVersion: 1,
          },
        },
      },
      context
    );
    const settlement = await submission.wait(context);
    assert.equal(settlement.status, "done");
    const resolvedValue2 = await subject.fixture
      .pi()
      .snapshot(FutureInstructions, subject.source.native.id, context);
    assert.equal(resolvedValue2?.causes.length ?? 0, 0);
    const snapshot = await subject.scope.read(actor);
    assert.equal(
      snapshot.tools.find(
        (tool) => tool.toolName === "create_future_instruction"
      )?.state,
      "failed"
    );
  } finally {
    await subject.close();
  }
});

test("prepared instruction causes reject stale native runs and mismatched owner or source", async () => {
  const subject = await setupWeb();
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  try {
    subject.source.faux.setResponses([
      async () => {
        entered.resolve(true);
        await release.promise;
        return fauxAssistantMessage("The human request is complete.");
      },
    ]);
    const sendResponse = await subject.send(
      "active-human",
      "Remember my instruction."
    );
    assert.equal(sendResponse.status, 200);
    await entered.promise;
    const options = {
      pi: subject.fixture.pi(),
      nativeId: subject.source.native.id,
      address: subject.source.address,
      ownerPrincipalId: actor.actor.id,
    };
    const valid = await prepareInstructionCause(options);
    const committed = await subject.fixture.pi().commit(valid, context);
    assert.equal(committed.kind, "human");
    const foreignOwner = await prepareInstructionCause({
      ...options,
      ownerPrincipalId: id.principal("another-owner"),
    });
    const foreignSource = await prepareInstructionCause({
      ...options,
      address: { ...options.address, agentId: id.agent("another-agent") },
    });
    await assert.rejects(
      subject.fixture.pi().commit(foreignOwner, context),
      (error: unknown) => error instanceof Denied
    );
    await assert.rejects(
      subject.fixture.pi().commit(foreignSource, context),
      (error: unknown) => error instanceof Denied
    );
    release.resolve(true);
    const event = await externalEvent(subject, {
      kind: "web",
      operationId: id.operation("active-human"),
    });
    await finish(subject, event);
    await assert.rejects(
      subject.fixture.pi().commit(valid, context),
      (error: unknown) => error instanceof Denied
    );
  } finally {
    release.resolve(true);
    await subject.close();
  }
});
