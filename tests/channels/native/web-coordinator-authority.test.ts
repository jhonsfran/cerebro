/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Native frame reads, controls, and crash checkpoints require ordered effects. */
import assert from "node:assert/strict";
import { before as beforeAll, test } from "node:test";

import { z } from "zod";

import type { ChatObservation } from "../../../packages/contracts/src/session-service.ts";
import { waitForFixture } from "../../slice-1/application.ts";
import {
  controlReportQueue,
  queue,
  drained,
  evidence,
  fixture,
  metadata,
  observed,
  summary,
} from "./team-support.ts";
import {
  setupWebTeam,
  marker,
  createConversation,
  read,
  sendMessage,
  callsCompleted,
  matchingReport,
  waitReport,
  observe,
  access,
} from "./web-team-support.ts";

beforeAll(setupWebTeam, { timeout: 180_000 });

test(
  "public read revocation closes active web observation and sends a completed report to the DLQ before one authorized redrive",
  { timeout: 300_000 },
  async () => {
    await controlReportQueue("pause");
    const { conversation, route } = await createConversation();
    const before = await observed();
    let stream: Awaited<ReturnType<typeof observe>> | undefined;
    let revoked = false;
    try {
      await sendMessage(route, {
        operationId: crypto.randomUUID(),
        text: marker,
      });
      const completed = await callsCompleted(before);
      const waiting = await waitReport(
        "cerebro-team-reports",
        conversation.conversationId
      );
      const report = matchingReport(waiting, conversation.conversationId);
      assert.equal(report?.report.kind, "completed");
      stream = await observe(route);
      const initial = await stream.next();
      assert.equal(initial?.type, "snapshot");
      assert.ok(initial?.type === "snapshot");
      assert.equal(
        initial.snapshot.messages.some((entry) => entry.text === summary),
        false
      );
      const workId = initial.snapshot.activity?.backgroundWork?.workId;
      assert.ok(workId);
      await access(["execute"]);
      revoked = true;
      const frames: ChatObservation[] = [];
      for (;;) {
        const frame = await stream.next();
        assert.ok(frame, "Revocation must emit access-denied before closure.");
        frames.push(frame);
        if (frame.type === "access-denied") {
          break;
        }
        assert.equal(
          frame.snapshot.messages.some((entry) => entry.text === summary),
          false
        );
      }
      assert.equal(await stream.next(), undefined);
      for (const [suffix, body] of [
        ["", undefined],
        ["/observations", undefined],
        ["/sources/pilot-source", undefined],
        ["/messages", { operationId: crypto.randomUUID(), text: "status" }],
        [
          "/control",
          { kind: "stop-work", workId, operationId: crypto.randomUUID() },
        ],
      ] as const) {
        const denied = await fixture.request(
          `${route}${suffix}`,
          metadata.owner.cookie,
          body
        );
        assert.equal(denied.status, 403);
        await denied.body?.cancel();
      }
      await controlReportQueue("resume");
      const deadLetter = await waitReport(
        "cerebro-team-reports-dead-letter",
        conversation.conversationId,
        180_000
      );
      assert.equal((await observed()).model.length, completed.model.length);
      await access(["read", "execute", "approve"]);
      revoked = false;
      const deniedView = await read(route);
      assert.equal(
        deniedView.snapshot.messages.some((entry) => entry.text === summary),
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
      const final = await waitForFixture(
        () => read(route),
        (value) =>
          value.snapshot.messages.some((entry) => entry.text === summary)
      );
      assert.equal(
        final.snapshot.messages.filter((entry) => entry.text === summary)
          .length,
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
      await drained("cerebro-team-reports");
      assert.deepEqual(await read(route), final);
      assert.equal((await observed()).model.length, completed.model.length);
      await evidence("web-team-native-authority-redrive", {
        conversation,
        before,
        completed,
        waiting,
        report,
        initial,
        frames,
        deadLetter,
        deniedView,
        redrive,
        repeated,
        final,
      });
    } finally {
      await stream?.close();
      if (revoked) {
        await access(["read", "execute", "approve"]);
      }
      await controlReportQueue("resume");
    }
  }
);
