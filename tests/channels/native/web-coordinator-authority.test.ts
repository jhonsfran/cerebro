/* oxlint-disable no-await-in-loop -- Revocation frames and queue redrive require ordered effects. */
import assert from "node:assert/strict";
import { before as beforeAll, test } from "node:test";

import { z } from "zod";

import type { ChatObservation } from "../../../packages/contracts/src/session-service.ts";
import { waitForFixture } from "../../slice-1/application.ts";
import { inspect } from "./inspection-support.ts";
import {
  matchingWorkReport,
  reportEvent,
  reportInputDigest,
} from "./team-queue-support.ts";
import {
  completedCalls,
  controlQueue,
  drained,
  evidence,
  fixture,
  metadata,
  observed,
  queue,
  wireModels,
} from "./team-support.ts";
import {
  access,
  callsCompleted,
  createConversation,
  observe,
  read,
  sendMessage,
  setupWebTeam,
  waitStartedWork,
  waitWorkReport,
} from "./web-team-support.ts";

beforeAll(setupWebTeam, { timeout: 180_000 });

test(
  "current source read denial closes observation and retains the exact report for one authorized coordinator redrive",
  { timeout: 300_000 },
  async () => {
    await controlQueue("pause");
    const { conversation, route } = await createConversation();
    const before = await observed();
    let stream: Awaited<ReturnType<typeof observe>> | undefined;
    let revoked = false;
    try {
      const input = {
        operationId: crypto.randomUUID(),
        text: "PERSISTENT_AGENT_FIXTURE slack:authority. Review Slack event admission and uncertain physical replies.",
      };
      await sendMessage(route, input);
      const accepted = await waitStartedWork(route, input.text);
      assert.ok(accepted.work);
      const target = accepted.work;
      const completed = await callsCompleted(before);
      const waiting = await waitWorkReport("cerebro-team-reports", target);
      const selected = matchingWorkReport(waiting, target);
      assert.ok(
        selected?.kind === "report" && selected.wire.report.kind === "completed"
      );
      const { report } = selected.wire;
      const expectedInput = await reportInputDigest(selected.wire);
      const expectedEvent = await reportEvent(selected.wire);
      const previousIds = new Set(
        accepted.view.snapshot.messages.map((entry) => entry.id)
      );
      stream = await observe(route);
      const initial = await stream.next();
      assert.ok(initial?.type === "snapshot");
      assert.equal(
        initial.snapshot.messages.some(
          (entry) =>
            !previousIds.has(entry.id) &&
            entry.text.startsWith("Team report received.")
        ),
        false
      );
      await access(["execute"]);
      revoked = true;
      const frames: ChatObservation[] = [];
      for (;;) {
        const frame = await stream.next();
        assert.ok(frame);
        frames.push(frame);
        if (frame.type === "access-denied") {
          break;
        }
        assert.equal(
          frame.snapshot.messages.some((entry) =>
            entry.text.startsWith("Team report received.")
          ),
          false
        );
      }
      assert.equal(await stream.next(), undefined);
      await Promise.all(
        [
          ["", undefined],
          ["/observations", undefined],
          ["/inspection", { query: { kind: "events" } }],
          ["/messages", { operationId: crypto.randomUUID(), text: "status" }],
          [
            "/control",
            {
              kind: "stop-work",
              workId: target.key.workId,
              operationId: crypto.randomUUID(),
            },
          ],
        ].map(async ([suffix, body]) => {
          assert.ok(typeof suffix === "string");
          const denied = await fixture.request(
            route + suffix,
            metadata.owner.cookie,
            body
          );
          assert.equal(denied.status, 403);
          await denied.body?.cancel();
        })
      );
      await controlQueue("resume");
      const deadLetter = await waitWorkReport(
        "cerebro-team-reports-dead-letter",
        target,
        180_000,
        report.id
      );
      const blocked = await observed();
      assert.equal(blocked.model.length, completed.model.length);
      await access(["read", "execute", "approve"]);
      revoked = false;
      const deniedView = await read(route);
      assert.equal(
        deniedView.snapshot.messages.some((entry) =>
          entry.text.startsWith("Team report received.")
        ),
        false
      );
      const redrive = await queue(
        "redrive",
        "cerebro-team-reports-dead-letter",
        10
      );
      assert.equal(
        z.object({ redriven: z.number() }).parse(redrive).redriven,
        1
      );
      await drained("cerebro-team-reports");
      const physical = await waitForFixture(
        observed,
        (value) =>
          completedCalls(value, wireModels.coordinator).length ===
            completedCalls(completed, wireModels.coordinator).length + 1 &&
          value.model.some(
            (call) =>
              call.completedAt !== undefined &&
              call.messageTextDigests.includes(expectedInput)
          ),
        60_000
      );
      const final = await waitForFixture(
        () => read(route),
        (value) =>
          !value.snapshot.busy &&
          value.snapshot.messages.some(
            (entry) =>
              !previousIds.has(entry.id) &&
              entry.text ===
                `Team report received. ${report.text.slice(0, 2000)}`
          )
      );
      assert.equal(
        final.snapshot.messages.filter(
          (entry) =>
            !previousIds.has(entry.id) &&
            entry.text === `Team report received. ${report.text.slice(0, 2000)}`
        ).length,
        1
      );
      const events = await inspect(route, { kind: "events" });
      assert.ok(events.kind === "events");
      assert.equal(
        events.events.filter(
          (event) =>
            event.id === expectedEvent.id &&
            event.source === "teamreport" &&
            event.outcome === "done"
        ).length,
        1
      );
      const repeated = await queue(
        "redrive",
        "cerebro-team-reports-dead-letter",
        10
      );
      assert.equal(
        z.object({ redriven: z.number() }).parse(repeated).redriven,
        0
      );
      assert.deepEqual(await read(route), final);
      const repeatedPhysical = await observed();
      assert.equal(repeatedPhysical.model.length, physical.model.length);
      await evidence("web-native-current-authority-redrive", {
        conversation,
        input,
        target,
        accepted,
        before,
        completed,
        waiting,
        selected,
        initial,
        frames,
        deadLetter,
        blocked,
        deniedView,
        redrive,
        physical,
        final,
        events,
        repeated,
      });
    } finally {
      await stream?.close();
      if (revoked) {
        await access(["read", "execute", "approve"]);
      }
      await controlQueue("resume");
    }
  }
);
