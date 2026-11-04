import assert from "node:assert/strict";
import { before as beforeAll, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { Schema } from "effect";
import { z } from "zod";

import { TeamReportDeliverySchema } from "../../../packages/contracts/src/work.ts";
import { waitForFixture } from "../../slice-1/application.ts";
import {
  completedCalls,
  controlReportQueue,
  drained,
  metadata,
  queueBodies,
  compose,
  configure,
  docker,
  event,
  evidence,
  fixture,
  hasReply,
  literal,
  observed,
  queue,
  ready,
  send,
  snapshot,
  summary,
  wireModels,
} from "./team-support.ts";

let roles: Awaited<ReturnType<typeof configure>>;
beforeAll(
  async () => {
    roles = await configure();
  },
  { timeout: 180_000 }
);
const marker = "SLACK_TEAM_FIXTURE run both worker checks.";
const startCount = (value: Awaited<ReturnType<typeof snapshot>>) =>
  value.snapshot.tools.filter((tool) => tool.toolName === "start_team");

test(
  "signed Slack queues deliver one private team result to the original thread before any product read",
  { timeout: 120_000 },
  async () => {
    const thread = "1800000200.000001";
    const before = await observed();
    const input = event("team-complete", marker, thread);
    await Promise.all([send(input), send(input, true)]);
    const completed = await waitForFixture(
      observed,
      (value) =>
        hasReply(value, thread) &&
        completedCalls(value, wireModels.coordinator).length ===
          completedCalls(before, wireModels.coordinator).length + 2,
      90_000
    );
    const firstReadAt = Date.now();
    const view = await snapshot(thread);
    assert.equal(startCount(view).length, 1);
    assert.equal(
      view.snapshot.messages.filter((message) => message.role === "user")
        .length,
      1
    );
    assert.equal(
      view.snapshot.messages.filter(
        (message) => message.role === "assistant" && message.text === summary
      ).length,
      1
    );
    assert.equal(
      completedCalls(completed, wireModels.lead).length -
        completedCalls(before, wireModels.lead).length,
      2
    );
    assert.equal(
      completedCalls(completed, wireModels.worker).length -
        completedCalls(before, wireModels.worker).length,
      2
    );
    assert.ok(
      completed.model
        .filter(
          (call) => call.startedAt >= (before.model.at(-1)?.startedAt ?? 0)
        )
        .every(
          (call) =>
            call.completedAt === undefined || call.completedAt <= firstReadAt
        )
    );
    assert.equal(
      await fixture.sql(
        `SELECT count(*) FROM channel_conversation WHERE agent_id IN (${literal(roles.lead.agentId)},${literal(roles.worker.agentId)})`
      ),
      "0"
    );
    await send(input, true);
    await drained("cerebro-slack-events");
    const replay = await observed();
    assert.equal(replay.model.length, completed.model.length);
    assert.equal(
      replay.slack.messages.filter(
        (message) => message.text === summary && message.threadTs === thread
      ).length,
      1
    );
    const queues = await Promise.all([
      queue("info", "cerebro-slack-events"),
      queue("info", "cerebro-team-commands"),
      queue("info", "cerebro-team-reports"),
    ]);
    await evidence("team-native-complete", {
      roles,
      eventId: input.event_id,
      thread,
      firstReadAt,
      before,
      completed,
      replay,
      view,
      queues,
    });
  }
);

test(
  "SIGKILL of a held private lead recovers on the same volume and publishes before any conversation or Team read",
  { timeout: 150_000 },
  async () => {
    const thread = "1800000300.000001";
    await fixture.controls({
      models: { [wireModels.lead]: { hold: true, delayMs: 0 } },
    });
    const before = await observed();
    const input = event("team-crash", marker, thread);
    await send(input);
    const held = await waitForFixture(
      observed,
      (value) =>
        value.held > 0 &&
        completedCalls(value, wireModels.coordinator).length ===
          completedCalls(before, wireModels.coordinator).length + 2 &&
        hasReply(
          value,
          thread,
          "SLACK_TEAM_FIXTURE coordinator accepted background work."
        ),
      60_000
    );
    const celld = await fixture.container("celld");
    const killedAt = Date.now();
    await docker("kill", "--signal", "KILL", celld);
    await compose("up", "--no-deps", "-d", "--wait", "celld");
    await ready();
    await fixture.controls({ models: {} });
    const completed = await waitForFixture(
      observed,
      (value) => hasReply(value, thread),
      90_000
    );
    const firstReadAt = Date.now();
    const attempts = completed.model.slice(before.model.length);
    assert.equal(
      attempts.filter((call) => call.model === wireModels.coordinator).length,
      2
    );
    assert.ok(
      attempts.filter((call) => call.model !== wireModels.coordinator).length <=
        8
    );
    assert.ok(
      attempts.filter((call) => call.model === wireModels.lead).length >= 2
    );
    const view = await snapshot(thread);
    assert.equal(startCount(view).length, 1);
    assert.equal(
      view.snapshot.messages.filter((message) => message.role === "user")
        .length,
      1
    );
    assert.equal(
      view.snapshot.messages.filter((message) => message.text === summary)
        .length,
      1
    );
    await send(input, true);
    await drained("cerebro-slack-events");
    const replay = await observed();
    assert.equal(replay.model.length, completed.model.length);
    await evidence("team-native-recovery", {
      eventId: input.event_id,
      thread,
      celld,
      killedAt,
      firstReadAt,
      held,
      completed,
      replay,
      view,
    });
  }
);

test(
  "one identity has two team slots and exact controls/direct updates add no coordinator calls",
  { timeout: 120_000 },
  async () => {
    const threads = [
      "1800000400.000001",
      "1800000500.000001",
      "1800000600.000001",
    ];
    const [first, second, third] = threads;
    assert.ok(first && second && third);
    await fixture.controls({
      models: { [wireModels.lead]: { hold: true, delayMs: 0 } },
    });
    const before = await observed();
    await Promise.all(
      [first, second].map((thread, index) =>
        send(event(`team-cap-${index}`, marker, thread))
      )
    );
    await waitForFixture(
      observed,
      (value) =>
        value.held === 2 &&
        completedCalls(value, wireModels.coordinator).length ===
          completedCalls(before, wireModels.coordinator).length + 4,
      60_000
    );
    await send(event("team-cap-2", marker, third));
    const admitted = await waitForFixture(
      observed,
      (value) =>
        completedCalls(value, wireModels.coordinator).length ===
          completedCalls(before, wireModels.coordinator).length + 6 &&
        hasReply(
          value,
          third,
          "SLACK_TEAM_FIXTURE coordinator accepted background work."
        ),
      60_000
    );
    const targetThread = first;
    const update = event(
      "team-direct-update",
      "Continue with this update.",
      "1800000401.000001",
      targetThread
    );
    await send(
      event("team-status", "status", "1800000402.000001", targetThread)
    );
    await send(update);
    await Promise.all(
      [first, second].map((thread, index) =>
        send(
          event(
            `team-stop-${index}`,
            "stop",
            `180000040${index + 3}.000001`,
            thread
          )
        )
      )
    );
    const stopped = await waitForFixture(
      observed,
      (value) =>
        value.slack.messages.filter(
          (message) => message.text === "Team work cancelled."
        ).length >= 2,
      30_000
    );
    assert.equal(
      completedCalls(stopped, wireModels.coordinator).length,
      completedCalls(admitted, wireModels.coordinator).length
    );
    await send(update, true);
    await drained("cerebro-slack-events");
    const replay = await observed();
    assert.equal(
      completedCalls(replay, wireModels.coordinator).length,
      completedCalls(admitted, wireModels.coordinator).length
    );
    const views = await Promise.all(threads.map(snapshot));
    assert.equal(
      views.filter((value) =>
        startCount(value).some((tool) =>
          tool.output?.includes("maximum active teams")
        )
      ).length,
      1
    );
    const after = await snapshot(targetThread);
    assert.equal(
      after.snapshot.messages.filter(
        (message) =>
          message.role === "user" &&
          message.text === "Continue with this update."
      ).length,
      1
    );
    await fixture.controls({ models: {}, release: true });
    await evidence("team-native-controls", {
      threads,
      admitted,
      views,
      stopped,
      replay,
      after,
    });
  }
);

const containsEvent = (value: unknown, eventId: string): boolean => {
  if (typeof value === "string") {
    return (
      value.includes(eventId) ||
      Buffer.from(value, "base64").toString("utf-8").includes(eventId)
    );
  }
  return (
    value !== null &&
    typeof value === "object" &&
    Object.values(value).some((child: unknown) => containsEvent(child, eventId))
  );
};
test(
  "native DLQ inspection and redrive recover a legitimate callback after owned Postgres failure",
  { timeout: 360_000 },
  async () => {
    const thread = "1800000700.000001";
    const input = event(
      "team-native-dead-letter",
      "Give one ordinary answer.",
      thread
    );
    const before = await observed();
    const postgres = await fixture.container("postgres");
    let peek: unknown;
    await docker("stop", postgres);
    try {
      await send(input);
      peek = await waitForFixture(
        async () => {
          await delay(1000);
          return await queue("peek", "cerebro-slack-events-dead-letter", 10);
        },
        (value) => containsEvent(value, input.event_id),
        240_000
      );
      const info = await queue("info", "cerebro-slack-events-dead-letter");
      await evidence("team-native-dead-letter", {
        eventId: input.event_id,
        postgres,
        peek,
        info,
      });
    } finally {
      await docker("start", postgres);
      await waitForFixture(
        async () => {
          try {
            return await fixture.sql("SELECT 1");
          } catch {
            return "";
          }
        },
        (value) => value === "1",
        60_000
      );
    }
    const saved = queueBodies(peek)
      .map((body) =>
        z
          .strictObject({
            agentId: z.string(),
            appId: z.string(),
            event: z.object({ text: z.string() }),
            eventId: z.string(),
            organizationId: z.string(),
            receivedAt: z.number(),
            sourceRetry: z.boolean(),
            version: z.literal(1),
            workspaceId: z.string(),
          })
          .parse(body)
      )
      .find((delivery) => delivery.eventId === input.event_id);
    assert.ok(saved);
    assert.equal(saved.event.text, input.event.text);
    const redrive = await queue(
      "redrive",
      "cerebro-slack-events-dead-letter",
      10
    );
    const completed = await waitForFixture(
      observed,
      (value) => hasReply(value, thread, "Cerebro slice 1 completed."),
      60_000
    );
    assert.equal(completed.model.length, before.model.length + 1);
    const repeated = await queue(
      "redrive",
      "cerebro-slack-events-dead-letter",
      10
    );
    await send(input, true);
    await drained("cerebro-slack-events");
    const replay = await observed();
    assert.equal(replay.model.length, completed.model.length);
    const view = await snapshot(thread);
    assert.equal(
      view.snapshot.messages.filter((message) => message.role === "user")
        .length,
      1
    );
    await evidence("team-native-redrive", {
      eventId: input.event_id,
      thread,
      saved,
      redrive,
      repeated,
      before,
      completed,
      replay,
      view,
    });
  }
);

test(
  "source read revocation blocks a completed report until native report DLQ redrive",
  { timeout: 300_000 },
  async () => {
    const thread = "1800000800.000001";
    await controlReportQueue("pause");
    const before = await observed();
    const input = event("team-report-revoked", marker, thread);
    let peek: unknown;
    try {
      await send(input);
      await waitForFixture(
        observed,
        (value) =>
          completedCalls(value, wireModels.coordinator).length ===
            completedCalls(before, wireModels.coordinator).length + 2 &&
          completedCalls(value, wireModels.lead).length ===
            completedCalls(before, wireModels.lead).length + 2 &&
          completedCalls(value, wireModels.worker).length ===
            completedCalls(before, wireModels.worker).length + 2,
        60_000
      );
      const waiting = await waitForFixture(
        () => queue("peek", "cerebro-team-reports", 10),
        (value) => containsEvent(value, thread),
        30_000
      );
      const report = queueBodies(waiting)
        .map((body) => Schema.decodeUnknownSync(TeamReportDeliverySchema)(body))
        .find(
          (delivery) => delivery.sourceSlackThread.rootTimestamp === thread
        );
      assert.ok(report);
      assert.equal(report.report.kind, "completed");
      const grant = `organization_id=${literal(metadata.agent.organizationId)} AND principal_id=${literal(metadata.agent.principalId)} AND action='read' AND resource_kind='agent' AND resource_id=${literal(roles.coordinator.agentId)}`;
      await fixture.sql(`DELETE FROM identity_grant WHERE ${grant}`);
      await controlReportQueue("resume");
      try {
        peek = await waitForFixture(
          async () => {
            await delay(1000);
            return await queue("peek", "cerebro-team-reports-dead-letter", 10);
          },
          (value) => containsEvent(value, thread),
          180_000
        );
        const blocked = await observed();
        assert.equal(hasReply(blocked, thread), false);
        assert.equal(blocked.model.length, before.model.length + 6);
        await evidence("team-native-report-denied", {
          input,
          waiting,
          report,
          peek,
          blocked,
        });
      } finally {
        await fixture.sql(
          `INSERT INTO identity_grant (organization_id,principal_id,action,resource_kind,resource_id,source) VALUES (${literal(metadata.agent.organizationId)},${literal(metadata.agent.principalId)},'read','agent',${literal(roles.coordinator.agentId)},'native-report-restore') ON CONFLICT DO NOTHING`
        );
      }
      const redrive = await queue(
        "redrive",
        "cerebro-team-reports-dead-letter",
        10
      );
      const completed = await waitForFixture(
        observed,
        (value) => hasReply(value, thread),
        60_000
      );
      const firstReadAt = Date.now();
      const repeated = await queue(
        "redrive",
        "cerebro-team-reports-dead-letter",
        10
      );
      await drained("cerebro-team-reports");
      const view = await snapshot(thread);
      assert.equal(startCount(view).length, 1);
      assert.equal(
        view.snapshot.messages.filter((message) => message.text === summary)
          .length,
        1
      );
      assert.equal(completed.model.length, before.model.length + 6);
      await evidence("team-native-report-redrive", {
        input,
        peek,
        redrive,
        repeated,
        completed,
        firstReadAt,
        view,
      });
    } finally {
      await controlReportQueue("resume");
    }
  }
);
