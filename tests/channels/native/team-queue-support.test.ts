import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { Schema } from "effect";

import { inputText } from "../../../packages/contracts/src/triggers.ts";
import { TeamReportDeliverySchema } from "../../../packages/contracts/src/work.ts";
import { reportTriggerIn } from "../../../packages/runtime/src/coordinator-event-content.ts";
import { TeamState } from "../../../packages/runtime/src/team-state.ts";
import { context, setup, start } from "../../runtime/subscription-fixture.ts";
import { teamProvenanceFixture } from "../../runtime/team-provenance-fixture.ts";
import { matchingWorkReport, reportInputDigest } from "./team-queue-support.ts";

test("queue matching uses complete work identity and the canonical digest of a real Pi report", async () => {
  const source = await setup();
  try {
    const work = await start(source, "Generate one actual private report.");
    const other = await start(
      source,
      "Another real work item in this primary."
    );
    const team = await teamProvenanceFixture({ work: work.admission });
    try {
      await team.runtime().receive({
        id: `start:${work.admission.key.workId}`,
        kind: "start",
        work: work.admission,
      });
      const pending = await team.pi().snapshot(TeamState, context);
      assert.ok(pending?.lead);
      await Promise.all(
        Object.values(pending.pending).map((taskId) =>
          team.pi().waitForTask(taskId, context)
        )
      );
      const lead = await team.pi().conversation(pending.lead, context);
      assert.ok(lead);
      await lead.waitForIdle(context);
      await team.runtime().wake(work.admission.deadlineAt);
      const completed = await team.pi().snapshot(TeamState, context);
      assert.ok(completed?.report?.kind === "completed");
      assert.match(completed.report.text, /Answer from/u);
      const delivery = Schema.decodeUnknownSync(TeamReportDeliverySchema)({
        version: 2,
        sourceEventAddress: work.admission.sourceEventAddress,
        report: completed.report,
      });
      const queue = {
        messages: [
          {
            contentType: "json",
            bodyBase64: Buffer.from(JSON.stringify(delivery)).toString(
              "base64"
            ),
          },
        ],
      };
      const selected = matchingWorkReport(
        queue,
        work.admission,
        completed.report.id
      );
      assert.ok(selected?.kind === "report");
      assert.deepEqual(selected.wire, delivery);
      assert.equal(matchingWorkReport(queue, other.admission), undefined);
      assert.equal(
        matchingWorkReport(queue, {
          ...work.admission,
          sourceEventAddress: source.source("b").address,
        }),
        undefined
      );
      assert.equal(
        matchingWorkReport(queue, work.admission, "another-report"),
        undefined
      );
      const trigger = await source
        .pi()
        .commit((tx) => reportTriggerIn(tx, work, completed.report), context);
      const expected = createHash("sha256")
        .update(inputText(trigger))
        .digest("hex");
      assert.equal(await reportInputDigest(delivery), expected);
    } finally {
      await team.close();
    }
  } finally {
    await source.close();
  }
});
