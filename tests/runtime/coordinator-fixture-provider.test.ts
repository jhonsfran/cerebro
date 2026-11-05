import assert from "node:assert/strict";
import { test } from "node:test";

import { Schema } from "effect";

import { id } from "../../packages/contracts/src/identity.ts";
import { WorkReportSchema } from "../../packages/contracts/src/work.ts";
import { coordinatorReportEvent } from "../../packages/runtime/src/coordinator-event-content.ts";
import { BotEventReceipts } from "../../packages/runtime/src/coordinator-events.ts";
import { coordinatorFixtureResponses } from "./coordinator-fixture-responses.ts";
import { context, setup } from "./coordinator-fixture.ts";

test("the coordinator fixture supplies its tool call, initial answer and one report answer", async () => {
  const fixture = await setup();
  try {
    const source = fixture.source("a");
    let calls = 0;
    source.faux.setResponses(
      coordinatorFixtureResponses({
        goal: "Read a team report.",
        record: () => {
          calls += 1;
          return Promise.resolve();
        },
      })
    );
    await source.coordinator.rememberHumanOperation("fixture-human");
    const human = await source.native.submit(
      {
        type: "input",
        content: "Start bounded work.",
        requestId: "fixture-human",
      },
      context
    );
    const initial = await human.wait(context);
    assert.equal(initial.status, "done");
    await fixture.waitDispatch();
    assert.equal(calls, 2);
    const work = await fixture.work("a");
    const event = await coordinatorReportEvent(
      work,
      Schema.decodeUnknownSync(WorkReportSchema)({
        kind: "completed",
        id: "fixture-report",
        key: work.admission.key,
        contentDependencies: { sourceIds: [], toolIds: [] },
        text: "SLACK_TEAM_FIXTURE Answer from lead.",
      })
    );
    const admitted = await fixture.events().admit(event, {
      actor: {
        id: id.principal("owner-A"),
        organizationId: id.organization("org-A"),
        kind: "human",
        state: "active",
      },
    });
    await fixture.pi().waitForTask(admitted.taskId, context);
    const receipt = await fixture
      .pi()
      .snapshot(BotEventReceipts, event.id, context);
    const entries = await source.native.entries({}, 100, undefined, context);
    const errors = entries.items
      .flatMap((entry) => entry.model ?? [])
      .filter(
        (message) =>
          message.role === "assistant" && message.stopReason === "error"
      );
    assert.equal(calls, 3, JSON.stringify(errors));
    assert.ok(
      receipt?.receipt?.admission.kind === "settled" &&
        receipt.receipt.admission.outcome === "done"
    );
    const { answer } = receipt.receipt.admission;
    const output = await source.native.entries(
      { minEntryId: answer, maxEntryId: answer },
      1,
      undefined,
      context
    );
    assert.match(
      JSON.stringify(output.items),
      /Coordinator result\. SLACK_TEAM_FIXTURE Answer from lead\./u
    );
    assert.equal(
      fixture.calls.filter((command) => command.kind === "start").length,
      1
    );
    assert.equal(source.faux.getPendingResponseCount(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await fixture.close();
  }
});
