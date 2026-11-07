/* oxlint-disable no-await-in-loop -- Public turns and FIFO promotion checkpoints require ordered effects. */
import assert from "node:assert/strict";
import { before as beforeAll, test } from "node:test";

import { z } from "zod";

import { waitForFixture } from "../../slice-1/application.ts";
import { cellInventory } from "./cell-evidence.ts";
import { inspect, overview } from "./inspection-support.ts";
import { matchingWorkReport } from "./team-queue-support.ts";
import type { WorkTarget } from "./team-queue-support.ts";
import {
  completedCalls,
  controlQueue,
  drained,
  evidence,
  fixture,
  literal,
  metadata,
  observed,
  teamRoles,
} from "./team-support.ts";
import {
  access,
  createConversation,
  heldAcceptance,
  publishedSchema,
  read,
  sendMessage,
  sendTurn,
  setupWebTeam,
  stopWork,
  waitStartedWork,
  waitWorkReport,
} from "./web-team-support.ts";

beforeAll(setupWebTeam, { timeout: 180_000 });

const startGoal = async (route: string, text: string) => {
  await sendMessage(route, { operationId: crypto.randomUUID(), text });
  const accepted = await waitStartedWork(route, text);
  assert.ok(accepted.work);
  return accepted.work;
};
const settled = (route: string, targets: WorkTarget[]) =>
  waitForFixture(
    () => overview(route),
    (frame) =>
      targets.every((target) =>
        frame.work.some(
          (work) => work.workId === target.key.workId && !work.reservationHeld
        )
      ),
    60_000
  );
const cancelAndSettle = async (route: string, targets: WorkTarget[]) => {
  for (const target of targets) {
    await stopWork(route, target.key.workId);
  }
  await fixture.controls({ models: {}, release: true });
  const reports = await Promise.all(
    targets.map((target) => waitWorkReport("cerebro-team-reports", target))
  );
  await controlQueue("resume");
  await drained("cerebro-team-reports");
  await settled(route, targets);
  return reports;
};

test(
  "one primary runs two independent Teams while ordinary conversation and exact targeted controls stay responsive",
  { timeout: 180_000 },
  async () => {
    await fixture.controls({
      models: { [teamRoles.lead]: { hold: true, delayMs: 0 } },
    });
    await controlQueue("pause");
    const { route, conversation } = await createConversation();
    try {
      const first = await startGoal(
        route,
        "PERSISTENT_AGENT_FIXTURE storage:controls-a. Compare offline task edit correctness and implementation effort."
      );
      const second = await startGoal(
        route,
        "PERSISTENT_AGENT_FIXTURE slack:controls-b. Review Slack filtering and uncertain delivery."
      );
      assert.notEqual(first.key.workId, second.key.workId);
      const held = await waitForFixture(
        observed,
        (value) => value.held === 2,
        60_000
      );
      const ordinary = await sendTurn(
        route,
        "What information should I bring to the planning meeting?"
      );
      assert.deepEqual(ordinary.tools, []);
      const afterOrdinary = await observed();
      assert.equal(
        completedCalls(afterOrdinary, teamRoles.coordinator).length,
        completedCalls(held, teamRoles.coordinator).length + 1
      );
      assert.equal(afterOrdinary.held, 2);
      const beforeControls = await observed();
      const status = await sendTurn(route, "status");
      assert.ok(
        status.view.snapshot.messages.some(
          (entry) =>
            entry.role === "assistant" &&
            entry.text.includes(first.key.workId) &&
            entry.text.includes(second.key.workId)
        )
      );
      await sendTurn(route, "stop");
      const unchanged = await overview(route);
      assert.ok(
        [first, second].every((target) =>
          unchanged.work.some(
            (work) =>
              work.workId === target.key.workId && work.status === "accepted"
          )
        )
      );
      const afterControls = await observed();
      assert.equal(afterControls.model.length, beforeControls.model.length);
      const update = await sendTurn(
        route,
        "PERSISTENT_AGENT_FIXTURE update storage:controls-a. Include stable task IDs and a conflict policy."
      );
      const commands = update.tools.filter(
        (tool) => tool.toolName === "message_team"
      );
      assert.equal(commands.length, 1);
      const [command] = commands;
      assert.ok(command);
      assert.equal(command.state, "succeeded");
      assert.deepEqual(command.arguments, {
        workId: first.key.workId,
        text: "Include stable task IDs and a conflict policy.",
      });
      const beforeReplay = await observed();
      const retry = await sendMessage(route, update.input);
      assert.equal(retry.receipt.accepted, false);
      const replayed = await observed();
      assert.equal(replayed.model.length, beforeReplay.model.length);
      const reports = await cancelAndSettle(route, [first, second]);
      await evidence("web-two-teams-targeted-controls", {
        conversation,
        first,
        second,
        held,
        ordinary,
        status,
        update,
        unchanged,
        reports,
      });
    } finally {
      await fixture.controls({ models: {}, release: true });
      await controlQueue("resume");
    }
  }
);

test(
  "structured stop binds its original intent and stale Work cannot cancel a replacement or a foreign source",
  { timeout: 180_000 },
  async () => {
    const { route, conversation } = await createConversation();
    await controlQueue("pause");
    await fixture.controls({
      models: { [teamRoles.lead]: { hold: true, delayMs: 0 } },
    });
    try {
      const before = await observed();
      const first = await startGoal(
        route,
        "PERSISTENT_AGENT_FIXTURE storage:replacement-a. Review offline storage correctness."
      );
      await heldAcceptance(before);
      const foreground = await fixture.json(
        `${route}/stop`,
        metadata.owner.cookie,
        z.object({ stopped: z.boolean() }),
        {}
      );
      assert.equal(typeof foreground.stopped, "boolean");
      const operationId = crypto.randomUUID();
      const receipt = await stopWork(route, first.key.workId, operationId);
      assert.deepEqual(
        await stopWork(route, first.key.workId, operationId),
        receipt
      );
      await cancelAndSettle(route, [first]);
      await controlQueue("pause");
      await fixture.controls({
        models: { [teamRoles.lead]: { hold: true, delayMs: 0 } },
      });
      const second = await startGoal(
        route,
        "PERSISTENT_AGENT_FIXTURE slack:replacement-b. Review event deduplication."
      );
      await waitForFixture(observed, (value) => value.held > 0);
      await stopWork(route, first.key.workId);
      const retained = await overview(route);
      assert.ok(
        retained.work.some(
          (work) =>
            work.workId === second.key.workId && work.status === "accepted"
        )
      );
      const conflict = await fixture.request(
        `${route}/control`,
        metadata.owner.cookie,
        { kind: "stop-work", workId: second.key.workId, operationId }
      );
      assert.equal(conflict.status, 409);
      await conflict.body?.cancel();
      const foreignBot = await fixture.json(
        "/api/product/agents",
        metadata.owner.cookie,
        publishedSchema,
        {
          operationId: crypto.randomUUID(),
          name: "Foreign coordinator source",
          model: "fixture/slack-coordinator",
          instructions: "Answer briefly.",
          enabledToolIds: [],
          grants: [],
        }
      );
      const foreign = await createConversation(foreignBot.agentId);
      assert.notEqual(
        foreign.conversation.conversationId,
        conversation.conversationId
      );
      const denied = await fixture.request(
        `${foreign.route}/control`,
        metadata.owner.cookie,
        {
          kind: "stop-work",
          workId: second.key.workId,
          operationId: crypto.randomUUID(),
        }
      );
      assert.equal(denied.status, 403);
      await denied.body?.cancel();
      await fixture.controls({ models: {}, release: true });
      const waiting = await waitWorkReport("cerebro-team-reports", second);
      const report = matchingWorkReport(waiting, second);
      assert.ok(report?.kind === "report");
      const baseline = await read(route);
      await stopWork(route, second.key.workId);
      await controlQueue("resume");
      await drained("cerebro-team-reports");
      await settled(route, [second]);
      const after = await read(route);
      const previous = new Set(
        baseline.snapshot.messages.map((entry) => entry.id)
      );
      assert.equal(
        after.snapshot.messages.filter(
          (entry) =>
            !previous.has(entry.id) &&
            entry.role === "assistant" &&
            entry.text.startsWith("Team report received.")
        ).length,
        0
      );
      await evidence("web-structured-stale-foreign-stop", {
        conversation,
        first,
        foreground,
        second,
        operationId,
        receipt,
        retained,
        foreign: foreign.conversation,
        report,
        baseline,
        after,
      });
    } finally {
      await fixture.controls({ models: {}, release: true });
      await controlQueue("resume");
    }
  }
);

test(
  "local controls commit while a real foreground generation is held and remain private to their owner",
  { timeout: 180_000 },
  async () => {
    const { route, conversation } = await createConversation();
    await fixture.controls({
      models: { [teamRoles.lead]: { hold: true, delayMs: 0 } },
    });
    await controlQueue("pause");
    try {
      const target = await startGoal(
        route,
        "PERSISTENT_AGENT_FIXTURE storage:held-controls. Compare recovery and sync maintenance."
      );
      await waitForFixture(observed, (value) => value.held > 0);
      await fixture.controls({
        models: {
          [teamRoles.lead]: { hold: true, delayMs: 0 },
          [teamRoles.coordinator]: { hold: true, delayMs: 0 },
        },
      });
      const before = await observed();
      await sendMessage(route, {
        operationId: crypto.randomUUID(),
        text: "Hold this ordinary planning question while the team works.",
      });
      const held = await waitForFixture(
        observed,
        (value) =>
          value.model.length === before.model.length + 1 && value.held >= 2
      );
      const startedAt = Date.now();
      await sendMessage(route, {
        operationId: crypto.randomUUID(),
        text: "status",
      });
      await stopWork(route, target.key.workId);
      assert.ok(Date.now() - startedAt < 10_000);
      const controlled = await read(route);
      assert.equal(controlled.snapshot.busy, true);
      const afterControls = await observed();
      assert.equal(afterControls.model.length, held.model.length);
      const peer = await fixture.signup("Same-company work observer");
      const principalId = `native-peer-${crypto.randomUUID()}`;
      await fixture.sql(
        `INSERT INTO identity_principal (id,organization_id,better_auth_user_id,kind,state) VALUES (${[principalId, metadata.agent.organizationId, peer.userId].map(literal).join(",")},'human','active')`
      );
      await access(["read", "execute"], principalId);
      await Promise.all(
        [
          ["", undefined],
          ["/observations", undefined],
          ["/inspection", { query: { kind: "overview" } }],
          [
            "/control",
            {
              kind: "stop-work",
              workId: target.key.workId,
              operationId: crypto.randomUUID(),
            },
          ],
          ["/messages", { operationId: crypto.randomUUID(), text: "status" }],
          ["/stop", {}],
        ].map(async ([suffix, body]) => {
          assert.equal(typeof suffix, "string");
          assert.ok(typeof suffix === "string");
          const response = await fixture.request(
            route + suffix,
            peer.cookie,
            body
          );
          assert.equal(response.status, 404);
          await response.body?.cancel();
        })
      );
      const foreground = await fixture.json(
        `${route}/stop`,
        metadata.owner.cookie,
        z.object({ stopped: z.boolean() }),
        {}
      );
      assert.equal(foreground.stopped, true);
      await cancelAndSettle(route, [target]);
      await evidence("web-held-controls-owner-isolation", {
        conversation,
        target,
        held,
        controlled,
        principalId,
        foreground,
      });
    } finally {
      await fixture.controls({ models: {}, release: true });
      await controlQueue("resume");
    }
  }
);

test(
  "global FIFO promotes queued work in order and a cancelled queued Team never exists",
  { timeout: 240_000 },
  async () => {
    const { route, conversation } = await createConversation();
    await fixture.controls({
      models: { [teamRoles.lead]: { hold: true, delayMs: 0 } },
    });
    await controlQueue("pause");
    try {
      const goals = [
        "PERSISTENT_AGENT_FIXTURE storage:fifo-active-a. Review local correctness.",
        "PERSISTENT_AGENT_FIXTURE slack:fifo-active-b. Review event filtering.",
        "PERSISTENT_AGENT_FIXTURE storage:fifo-first. Review sync maintenance.",
        "PERSISTENT_AGENT_FIXTURE slack:fifo-cancel. Review reply authority.",
        "PERSISTENT_AGENT_FIXTURE storage:fifo-last. Review client packaging.",
      ];
      const works = [];
      for (const goal of goals) {
        works.push(await startGoal(route, goal));
      }
      const [first, second, head, cancelled, tail] = works;
      assert.ok(first && second && head && cancelled && tail);
      assert.equal(head.work.status.kind, "queued");
      assert.equal(cancelled.work.status.kind, "queued");
      assert.equal(tail.work.status.kind, "queued");
      const activeScopes = await waitForFixture(
        () =>
          Promise.all([cellInventory(first.key), cellInventory(second.key)]),
        (values) => values.every((value) => value.local && value.bucket),
        60_000
      );
      const before = await cellInventory(cancelled.key);
      assert.deepEqual(
        { local: before.local, bucket: before.bucket },
        { local: false, bucket: false }
      );
      const beforeInspection = await observed();
      const leadBaseline = beforeInspection.model.filter(
        (call) => call.role === teamRoles.lead
      ).length;
      const queued = await inspect(route, {
        kind: "team",
        workId: cancelled.key.workId,
      });
      assert.ok(queued.kind === "team");
      assert.deepEqual(queued.team, { kind: "not-started" });
      const queuedAgain = await inspect(route, {
        kind: "team",
        workId: cancelled.key.workId,
      });
      assert.deepEqual(queuedAgain, queued);
      await stopWork(route, cancelled.key.workId);
      const after = await cellInventory(cancelled.key);
      assert.deepEqual(after, before);
      const afterInspection = await observed();
      assert.equal(
        afterInspection.model.filter((call) => call.role === teamRoles.lead)
          .length,
        leadBaseline
      );
      await stopWork(route, first.key.workId);
      await waitWorkReport("cerebro-team-reports", first);
      await controlQueue("resume");
      const promoted = await waitForFixture(
        () => overview(route),
        (value) =>
          value.work.some(
            (work) => work.workId === head.key.workId && work.dispatched
          ) &&
          value.work.some(
            (work) =>
              work.workId === tail.key.workId && work.status === "queued"
          ),
        60_000
      );
      await controlQueue("pause");
      await stopWork(route, second.key.workId);
      await waitWorkReport("cerebro-team-reports", second);
      await controlQueue("resume");
      const next = await waitForFixture(
        () => overview(route),
        (value) =>
          value.work.some(
            (work) => work.workId === tail.key.workId && work.dispatched
          ),
        60_000
      );
      await controlQueue("pause");
      const reports = await cancelAndSettle(route, [head, tail]);
      assert.deepEqual(await cellInventory(cancelled.key), before);
      await evidence("web-native-global-fifo-queued-absence", {
        conversation,
        works,
        activeScopes,
        before,
        queued,
        queuedAgain,
        after,
        promoted,
        next,
        reports,
      });
    } finally {
      await fixture.controls({ models: {}, release: true });
      await controlQueue("resume");
    }
  }
);
