import assert from "node:assert/strict";
import { test } from "node:test";

import { Schema } from "effect";

import { Denied } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import {
  TRIGGER_ENTRY_KIND,
  TriggerOriginSchema,
  TriggerSchema,
  triggerId,
} from "../../packages/contracts/src/triggers.ts";
import type {
  Trigger,
  TriggerOrigin,
} from "../../packages/contracts/src/triggers.ts";
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
import { prepareInstructionCause } from "../../packages/runtime/src/instruction-cause.ts";
import { context } from "./coordinator-fixture.ts";
import { actor, setupWeb } from "./coordinator-web-fixture.ts";

type Subject = Awaited<ReturnType<typeof setupWeb>>;
const FutureInstructions = defineDoc({
  kind: "fixture.authorized-future-instructions",
  scope: "conversation",
  version: 1,
  initial: (): { causes: string[] } => ({ causes: [] }),
});
const triggerFor = async (
  subject: Subject,
  origin: TriggerOrigin,
  text = "Start a bounded storage design task."
): Promise<Trigger> =>
  Schema.decodeUnknownSync(TriggerSchema)({
    version: 2,
    id: await triggerId(subject.source.address, origin),
    address: subject.source.address,
    ownerPrincipalId: actor.actor.id,
    origin,
    text,
    reference: null,
    reply: null,
    dependencies: { sourceIds: [], toolIds: [] },
  });
const reportOrigin = (workId: string): TriggerOrigin => ({
  kind: "teamreport",
  key: {
    organizationId: actor.actor.organizationId,
    ownerPrincipalId: actor.actor.id,
    workId: Schema.decodeUnknownSync(WorkIdSchema)(workId),
  },
  reportId: Schema.decodeUnknownSync(WorkReportIdSchema)(`report-${workId}`),
  outcome: "completed",
});
const acceptInternal = async (subject: Subject, trigger: Trigger) => {
  await subject.fixture
    .pi()
    .commit((tx) => subject.triggers.acceptIn(tx, trigger), context);
  await subject.triggers.drain(subject.source.native.id);
};
const installFutureTool = async (subject: Subject) => {
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
        document.causes.push(cause.eventId);
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

for (const kind of ["web", "slack", "timer"] as const) {
  test(`a placed ${kind} trigger authorizes independent Team work`, async () => {
    const subject = await setupWeb(true);
    try {
      subject.source.faux.setResponses([
        fauxAssistantMessage(
          fauxToolCall("start_team", { goal: "Compare two storage designs." }),
          { stopReason: "toolUse" }
        ),
        fauxAssistantMessage("The independent team was admitted."),
      ]);
      let origin: TriggerOrigin = {
        kind: "web",
        operationId: id.operation("web-cause"),
      };
      if (kind === "slack") {
        origin = Schema.decodeUnknownSync(TriggerOriginSchema)({
          kind,
          eventId: "slack-cause",
          thread: {
            workspaceId: "T123",
            channelId: "D123",
            rootTimestamp: "123.456000",
          },
        });
      }
      if (kind === "timer") {
        origin = { kind, scheduleId: "saved-routine", occurrenceId: "123" };
      }
      const trigger = await triggerFor(subject, origin);
      await subject.triggers.admit(
        {
          version: 3,
          kind: "trigger-admission",
          trigger,
          routing: { kind: "automatic" },
        },
        actor
      );
      await subject.settled(trigger.id);
      await subject.fixture.waitDispatch();
      const work = await subject.fixture.work("a");
      assert.equal(work.humanOperationId, trigger.id);
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

test("a batched run that mixes a report and a human message takes the human cause", async () => {
  const subject = await setupWeb(true);
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  try {
    subject.source.faux.setResponses([
      async () => {
        entered.resolve(true);
        await release.promise;
        return fauxAssistantMessage("Foreground finished.");
      },
      fauxAssistantMessage(
        fauxToolCall("start_team", { goal: "Act on the report." }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("Started from the batched turn."),
    ]);
    const foreground = await subject.source.native.submit(
      { type: "input", content: "Hold.", requestId: "hold" },
      context
    );
    await entered.promise;
    const report = await triggerFor(
      subject,
      reportOrigin("finished-work"),
      "The previous team finished."
    );
    await acceptInternal(subject, report);
    const human = await triggerFor(
      subject,
      { kind: "web", operationId: id.operation("act-on-report") },
      "Please act on that report."
    );
    await subject.triggers.admit(human, actor);
    release.resolve(true);
    await foreground.wait(context);
    const [reportPlacement, humanPlacement] = await Promise.all([
      subject.settled(report.id),
      subject.settled(human.id),
    ]);
    assert.ok(
      reportPlacement.kind === "done" && humanPlacement.kind === "done"
    );
    assert.equal(reportPlacement.answer, humanPlacement.answer);
    await subject.fixture.waitDispatch();
    const work = await subject.fixture.work("a");
    assert.equal(work.humanOperationId, human.id);
  } finally {
    release.resolve(true);
    await subject.close();
  }
});

test("an internal-only run cannot start a Team or mint authority for a future routine", async () => {
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
    const report = await triggerFor(subject, reportOrigin("completed-work"));
    await acceptInternal(subject, report);
    await subject.settled(report.id);
    const view = await subject.scope.read(actor);
    assert.equal(subject.fixture.calls.length, 0);
    const saved = await subject.fixture
      .pi()
      .snapshot(FutureInstructions, subject.source.native.id, context);
    assert.equal(saved?.causes.length ?? 0, 0);
    assert.deepEqual(
      Object.fromEntries(view.tools.map((tool) => [tool.toolName, tool.state])),
      { start_team: "failed", create_future_instruction: "failed" }
    );
  } finally {
    await subject.close();
  }
});

test("a trigger entry without a matching receipt cannot mint a future instruction", async () => {
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
          kind: TRIGGER_ENTRY_KIND,
          data: {
            id: "unowned-custom-input",
            channel: "web",
            operationId: "fake-human",
          },
        },
      },
      context
    );
    const settlement = await submission.wait(context);
    assert.equal(settlement.status, "done");
    const saved = await subject.fixture
      .pi()
      .snapshot(FutureInstructions, subject.source.native.id, context);
    assert.equal(saved?.causes.length ?? 0, 0);
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

test("prepared instruction causes reject stale runs and mismatched owner or source", async () => {
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
    const response = await subject.send(
      "active-human",
      "Remember my instruction."
    );
    assert.equal(response.status, 200);
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
    await subject.settled(committed.eventId);
    await assert.rejects(
      subject.fixture.pi().commit(valid, context),
      (error: unknown) => error instanceof Denied
    );
  } finally {
    release.resolve(true);
    await subject.close();
  }
});
