/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Native frame reads, controls, and crash checkpoints require ordered effects. */
import assert from "node:assert/strict";
import { before as beforeAll, test } from "node:test";

import { z } from "zod";

import type { ChatObservation } from "../../../packages/contracts/src/session-service.ts";
import { waitForFixture } from "../../slice-1/application.ts";
import {
  completedCalls,
  controlReportQueue,
  drained,
  evidence,
  fixture,
  literal,
  metadata,
  observed,
  summary,
  wireModels,
} from "./team-support.ts";
import {
  setupWebTeam,
  marker,
  createConversation,
  read,
  sendMessage,
  stopWork,
  heldAcceptance,
  waitReport,
  observe,
  access,
  finishCancelledWork,
} from "./web-team-support.ts";

beforeAll(setupWebTeam, { timeout: 180_000 });

test(
  "web exact status, update, and stop have replay receipts and idle observation without extra coordinator calls",
  { timeout: 120_000 },
  async () => {
    await fixture.controls({
      models: { [wireModels.lead]: { hold: true, delayMs: 0 } },
    });
    const { conversation, route } = await createConversation();
    const before = await observed();
    let stream: Awaited<ReturnType<typeof observe>> | undefined;
    try {
      await sendMessage(route, {
        operationId: crypto.randomUUID(),
        text: marker,
      });
      const accepted = await heldAcceptance(before);
      const view = await waitForFixture(
        () => read(route),
        (value) =>
          !value.snapshot.busy &&
          value.snapshot.activity?.backgroundWork !== undefined
      );
      const activeWork = view.snapshot.activity?.backgroundWork;
      assert.ok(activeWork);
      assert.equal(activeWork.status.kind, "accepted");
      stream = await observe(route);
      const initial = await stream.next();
      assert.equal(initial?.type, "snapshot");
      if (initial?.type === "snapshot") {
        assert.equal(initial.snapshot.busy, false);
        assert.ok(initial.snapshot.activity?.backgroundWork);
      }
      await fixture.controls({
        models: {
          [wireModels.lead]: { hold: true, delayMs: 0 },
          [wireModels.coordinator]: { hold: true, delayMs: 0 },
        },
      });
      const inputs = [
        { operationId: crypto.randomUUID(), text: " status " },
        {
          operationId: crypto.randomUUID(),
          text: "SLACK_TEAM_FIXTURE Continue with this update.",
        },
        { operationId: crypto.randomUUID(), text: "stop" },
      ] as const;
      const receipts = [];
      await controlReportQueue("pause");
      const startedAt = Date.now();
      for (const input of inputs) {
        const result = await sendMessage(route, input);
        assert.equal(result.receipt.operationId, input.operationId);
        receipts.push(result);
      }
      assert.ok(Date.now() - startedAt < 10_000);
      const frames: ChatObservation[] = [];
      for (;;) {
        const frame = await stream.next();
        assert.ok(frame);
        frames.push(frame);
        if (
          frame.type === "snapshot" &&
          frame.snapshot.activity?.backgroundWork?.status.kind === "cancelled"
        ) {
          assert.equal(frame.snapshot.busy, false);
          break;
        }
      }
      const cancelled = await read(route);
      assert.equal(
        cancelled.snapshot.messages.filter(
          (entry) => entry.text === "status" && entry.role === "user"
        ).length,
        1
      );
      assert.equal(
        cancelled.snapshot.messages.filter(
          (entry) => entry.text === inputs[1].text && entry.role === "user"
        ).length,
        1
      );
      assert.equal(
        cancelled.snapshot.messages.filter(
          (entry) => entry.text === "stop" && entry.role === "user"
        ).length,
        1
      );
      assert.ok(
        cancelled.snapshot.messages.some(
          (entry) =>
            entry.text === "Team work cancelled." && entry.role === "assistant"
        )
      );
      for (const input of inputs) {
        assert.equal(
          (await sendMessage(route, input)).receipt.operationId,
          input.operationId
        );
      }
      const changed = await fixture.request(
        `${route}/messages`,
        metadata.owner.cookie,
        { ...inputs[1], text: "Changed update." }
      );
      assert.equal(changed.status, 409);
      await changed.body?.cancel();
      const changedIntent = await fixture.request(
        `${route}/control`,
        metadata.owner.cookie,
        {
          kind: "stop-work",
          workId: activeWork.workId,
          operationId: inputs[0].operationId,
        }
      );
      assert.equal(changedIntent.status, 409);
      await changedIntent.body?.cancel();
      assert.deepEqual(await read(route), cancelled);
      const controlled = await observed();
      assert.equal(
        controlled.model.filter((call) => call.model === wireModels.coordinator)
          .length,
        accepted.model.filter((call) => call.model === wireModels.coordinator)
          .length
      );
      await finishCancelledWork(conversation.conversationId);
      const terminal = await read(route);
      assert.equal(
        terminal.snapshot.activity?.backgroundWork?.status.kind,
        "cancelled"
      );
      assert.equal(
        terminal.snapshot.messages.some((entry) => entry.text === summary),
        false
      );
      await evidence("web-team-native-exact-controls", {
        conversation,
        before,
        accepted,
        view,
        initial,
        inputs,
        receipts,
        frames,
        cancelled,
        controlled,
        terminal,
      });
    } finally {
      await stream?.close();
      await fixture.controls({ models: {}, release: true });
      await controlReportQueue("resume");
    }
  }
);

test(
  "targeted web stop binds receipt intent and stale work A cannot cancel replacement B",
  { timeout: 150_000 },
  async () => {
    await fixture.controls({
      models: { [wireModels.lead]: { hold: true, delayMs: 0 } },
    });
    const { conversation, route } = await createConversation();
    try {
      const before = await observed();
      await sendMessage(route, {
        operationId: crypto.randomUUID(),
        text: marker,
      });
      await heldAcceptance(before);
      const view = await waitForFixture(
        () => read(route),
        (value) =>
          !value.snapshot.busy &&
          value.snapshot.activity?.backgroundWork !== undefined
      );
      const first = view.snapshot.activity?.backgroundWork;
      assert.ok(first);
      const foregroundStop = await fixture.json(
        `${route}/stop`,
        metadata.owner.cookie,
        z.object({ stopped: z.boolean() }),
        {}
      );
      assert.equal(typeof foregroundStop.stopped, "boolean");
      assert.equal(
        (await read(route)).snapshot.activity?.backgroundWork?.status.kind,
        "accepted"
      );
      const operationId = crypto.randomUUID();
      await controlReportQueue("pause");
      const receipt = await stopWork(route, first.workId, operationId);
      assert.deepEqual(receipt, { kind: "stop-work", id: first.workId });
      assert.deepEqual(
        await stopWork(route, first.workId, operationId),
        receipt
      );
      assert.equal(
        (await read(route)).snapshot.activity?.backgroundWork?.status.kind,
        "cancelled"
      );
      await finishCancelledWork(conversation.conversationId);
      await fixture.controls({
        models: { [wireModels.lead]: { hold: true, delayMs: 0 } },
      });
      const nextBefore = await observed();
      await sendMessage(route, {
        operationId: crypto.randomUUID(),
        text: marker,
      });
      await heldAcceptance(nextBefore);
      const replacement = await waitForFixture(
        () => read(route),
        (value) =>
          value.snapshot.activity?.backgroundWork?.workId !== first.workId
      );
      const second = replacement.snapshot.activity?.backgroundWork;
      assert.ok(second);
      await stopWork(route, first.workId);
      assert.deepEqual(
        (await read(route)).snapshot.activity?.backgroundWork,
        second
      );
      const conflict = await fixture.request(
        `${route}/control`,
        metadata.owner.cookie,
        { kind: "stop-work", workId: second.workId, operationId }
      );
      assert.equal(conflict.status, 409);
      await conflict.body?.cancel();
      assert.deepEqual(
        (await read(route)).snapshot.activity?.backgroundWork,
        second
      );
      const foreign = await createConversation();
      const denied = await fixture.request(
        `${foreign.route}/control`,
        metadata.owner.cookie,
        {
          kind: "stop-work",
          workId: second.workId,
          operationId: crypto.randomUUID(),
        }
      );
      assert.equal(denied.status, 403);
      await denied.body?.cancel();
      const pendingReport = await controlReportQueue("pause");
      await fixture.controls({ models: {}, release: true });
      await waitReport("cerebro-team-reports", conversation.conversationId);
      const completedBeforeCancel = await observed();
      await stopWork(route, second.workId);
      await controlReportQueue("resume");
      await drained("cerebro-team-reports");
      const terminal = await read(route);
      assert.equal(
        terminal.snapshot.activity?.backgroundWork?.status.kind,
        "cancelled"
      );
      assert.equal(
        terminal.snapshot.messages.some((entry) => entry.text === summary),
        false
      );
      await evidence("web-team-native-targeted-controls", {
        conversation,
        before,
        view,
        first,
        foregroundStop,
        operationId,
        receipt,
        replacement,
        second,
        pendingReport,
        completedBeforeCancel,
        terminal,
      });
    } finally {
      await fixture.controls({ models: {}, release: true });
      await controlReportQueue("resume");
    }
  }
);

test(
  "passive web controls commit while the source coordinator foreground is held",
  { timeout: 120_000 },
  async () => {
    await fixture.controls({
      models: {
        [wireModels.coordinator]: { hold: true, delayMs: 0 },
        [wireModels.lead]: { hold: true, delayMs: 0 },
      },
    });
    const { conversation, route } = await createConversation();
    const before = await observed();
    try {
      await sendMessage(route, {
        operationId: crypto.randomUUID(),
        text: marker,
      });
      await waitForFixture(
        observed,
        (value) =>
          value.held === 1 && value.model.length === before.model.length + 1
      );
      await fixture.controls({ release: true });
      const held = await waitForFixture(
        observed,
        (value) =>
          value.held >= 2 &&
          completedCalls(value, wireModels.coordinator).length ===
            completedCalls(before, wireModels.coordinator).length + 1 &&
          value.model.filter((call) => call.model === wireModels.coordinator)
            .length ===
            before.model.filter((call) => call.model === wireModels.coordinator)
              .length +
              2,
        60_000
      );
      const view = await read(route);
      assert.equal(view.snapshot.busy, true);
      const work = view.snapshot.activity?.backgroundWork;
      assert.ok(work?.canCancel);
      await controlReportQueue("pause");
      const controlsAt = Date.now();
      await sendMessage(route, {
        operationId: crypto.randomUUID(),
        text: "status",
      });
      await sendMessage(route, {
        operationId: crypto.randomUUID(),
        text: "SLACK_TEAM_FIXTURE An update while foreground is held.",
      });
      const receipt = await stopWork(route, work.workId);
      assert.ok(Date.now() - controlsAt < 10_000);
      const controlled = await read(route);
      assert.equal(controlled.snapshot.busy, true);
      assert.equal(
        controlled.snapshot.activity?.backgroundWork?.status.kind,
        "cancelled"
      );
      assert.equal(
        (await observed()).model.filter(
          (call) => call.model === wireModels.coordinator
        ).length,
        held.model.filter((call) => call.model === wireModels.coordinator)
          .length
      );
      const foregroundStop = await fixture.json(
        `${route}/stop`,
        metadata.owner.cookie,
        z.object({ stopped: z.boolean() }),
        {}
      );
      assert.equal(foregroundStop.stopped, true);
      await finishCancelledWork(conversation.conversationId);
      const terminal = await waitForFixture(
        () => read(route),
        (value) => !value.snapshot.busy
      );
      assert.equal(
        terminal.snapshot.activity?.backgroundWork?.status.kind,
        "cancelled"
      );
      assert.equal(
        terminal.snapshot.messages.some((entry) => entry.text === summary),
        false
      );
      await drained("cerebro-team-commands");
      await drained("cerebro-team-reports");
      await evidence("web-team-native-held-foreground", {
        conversation,
        before,
        held,
        view,
        receipt,
        controlled,
        foregroundStop,
        terminal,
      });
    } finally {
      await fixture.controls({ models: {}, release: true });
      await controlReportQueue("resume");
    }
  }
);

test(
  "a company peer with coordinator access still cannot read or stop another owner's web work",
  { timeout: 120_000 },
  async () => {
    await fixture.controls({
      models: { [wireModels.lead]: { hold: true, delayMs: 0 } },
    });
    const { conversation, route } = await createConversation();
    const before = await observed();
    try {
      await sendMessage(route, {
        operationId: crypto.randomUUID(),
        text: marker,
      });
      await heldAcceptance(before);
      const view = await read(route);
      const work = view.snapshot.activity?.backgroundWork;
      assert.ok(work);
      const peer = await fixture.signup("Web team peer");
      const peerPrincipalId = `web-team-peer-${crypto.randomUUID()}`;
      await fixture.sql(
        `INSERT INTO identity_principal (id,organization_id,better_auth_user_id,kind,state) VALUES (${literal(peerPrincipalId)},${literal(metadata.agent.organizationId)},${literal(peer.userId)},'human','active')`
      );
      await access(["read", "execute"], peerPrincipalId);
      const denials = [];
      for (const [suffix, body] of [
        ["", undefined],
        ["/observations", undefined],
        [
          "/control",
          {
            kind: "stop-work",
            workId: work.workId,
            operationId: crypto.randomUUID(),
          },
        ],
        ["/messages", { operationId: crypto.randomUUID(), text: "stop" }],
        ["/stop", {}],
      ] as const) {
        const denied = await fixture.request(
          `${route}${suffix}`,
          peer.cookie,
          body
        );
        denials.push({ suffix, status: denied.status });
        assert.equal(denied.status, 404);
        await denied.body?.cancel();
      }
      assert.deepEqual(
        (await read(route)).snapshot.activity?.backgroundWork,
        work
      );
      await controlReportQueue("pause");
      await stopWork(route, work.workId);
      await finishCancelledWork(conversation.conversationId);
      await evidence("web-team-native-owner-isolation", {
        conversation,
        peerPrincipalId,
        denials,
        view,
      });
    } finally {
      await fixture.controls({ models: {}, release: true });
      await controlReportQueue("resume");
    }
  }
);
