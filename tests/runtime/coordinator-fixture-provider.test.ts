import assert from "node:assert/strict";
import { test } from "node:test";

import { Schema } from "effect";

import { WorkReportSchema } from "../../packages/contracts/src/work.ts";
import { reportTriggerIn } from "../../packages/runtime/src/coordinator-event-content.ts";
import { coordinatorFixtureResponses } from "./coordinator-fixture-responses.ts";
import { actor, context, setup } from "./coordinator-fixture.ts";

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
    const human = await fixture.webTrigger(
      "a",
      "fixture-human",
      "Start bounded work."
    );
    await fixture.triggers().admit(human, actor);
    const initial = await fixture.settled(human.id);
    assert.equal(initial.kind, "done");
    await fixture.waitDispatch();
    assert.equal(calls, 2);
    const work = await fixture.work("a");
    const report = Schema.decodeUnknownSync(WorkReportSchema)({
      kind: "completed",
      id: "fixture-report",
      key: work.admission.key,
      contentDependencies: { sourceIds: [], toolIds: [] },
      text: "SLACK_TEAM_FIXTURE Answer from lead.",
    });
    const trigger = await fixture.pi().commit(async (tx) => {
      const value = await reportTriggerIn(tx, work, report);
      await fixture.triggers().acceptIn(tx, value);
      return value;
    }, context);
    assert.equal(trigger.reply, null);
    await fixture.triggers().drain(source.native.id);
    const placement = await fixture.settled(trigger.id);
    const entries = await source.native.entries({}, 100, undefined, context);
    const errors = entries.items
      .flatMap((entry) => entry.model ?? [])
      .filter(
        (message) =>
          message.role === "assistant" && message.stopReason === "error"
      );
    assert.equal(calls, 3, JSON.stringify(errors));
    assert.ok(placement.kind === "done");
    const { answer } = placement;
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
