import assert from "node:assert/strict";
import { before as beforeAll, test } from "node:test";

import { z } from "zod";

import { waitForFixture } from "../../slice-1/application.ts";
import { matchingWorkReport, reportInputDigest } from "./team-queue-support.ts";
import {
  agentWireModel,
  completedCalls,
  controlQueue,
  compose,
  drained,
  docker,
  evidence,
  fixture,
  literal,
  observed,
  ready,
  teamRoles,
} from "./team-support.ts";
import {
  coordinatorTools,
  createConversation,
  heldAcceptance,
  noSlack,
  publishedAgent,
  read,
  sendMessage,
  setupWebTeam,
  startedWork,
  waitStartedWork,
  waitWorkReport,
} from "./web-team-support.ts";

beforeAll(setupWebTeam, { timeout: 180_000 });

const removeCoordinationBlock = async () => {
  await compose(
    "run",
    "--no-deps",
    "--rm",
    "test-config",
    "node",
    "--input-type=module",
    "-e",
    "import {readFile,writeFile} from 'node:fs/promises'; const p='/run/cerebro-secrets/runtime.json'; const c=JSON.parse(await readFile(p,'utf8')); delete c.coordination; await writeFile(p,JSON.stringify(c),{mode:0o600});"
  );
  await compose("run", "--no-deps", "--rm", "bootstrap");
  await compose("restart", "celld");
  await ready();
};
const mounts = async (containerId: string) => {
  const inspected = await docker("inspect", containerId);
  const parsed = z
    .array(
      z.object({
        Id: z.string(),
        Config: z.object({ Labels: z.record(z.string(), z.string()) }),
        Mounts: z.array(
          z.object({
            Type: z.string(),
            Name: z.string().optional(),
            Source: z.string(),
            Destination: z.string(),
          })
        ),
      })
    )
    .parse(JSON.parse(inspected.stdout));
  const [identity] = parsed;
  assert.ok(identity);
  assert.equal(identity.Config.Labels["cerebro.slice-1"], "disposable");
  return identity;
};

test(
  "a primary with no coordination block starts a Team whose roles all run the agent's model",
  { timeout: 180_000 },
  async () => {
    await removeCoordinationBlock();
    await noSlack();
    const { conversation, route } = await createConversation();
    const input = {
      operationId: crypto.randomUUID(),
      text: "PERSISTENT_AGENT_FIXTURE storage:no-block. Recommend SQLite with sync or IndexedDB with sync for an offline five-person task tracker.",
    };
    const before = await observed();
    await sendMessage(route, input);
    const accepted = await waitStartedWork(route, input.text);
    assert.ok(accepted.work);
    const finished = await waitForFixture(
      observed,
      (value) =>
        completedCalls(value, teamRoles.lead).length >=
          completedCalls(before, teamRoles.lead).length + 2 &&
        completedCalls(value, teamRoles.worker).length >=
          completedCalls(before, teamRoles.worker).length + 2 &&
        completedCalls(value, teamRoles.coordinator).length >=
          completedCalls(before, teamRoles.coordinator).length + 3,
      90_000
    );
    const calls = finished.model.slice(before.model.length);
    assert.ok(calls.every((call) => call.model === agentWireModel));
    assert.ok(
      calls
        .filter((call) => call.role === teamRoles.coordinator)
        .every((call) =>
          coordinatorTools.every((name) => call.toolNames.includes(name))
        )
    );
    const view = await waitForFixture(
      () => read(route),
      (value) =>
        !value.snapshot.busy &&
        value.snapshot.activity?.backgroundWork?.status.kind === "completed"
    );
    assert.equal(finished.slack.calls.length, 0);
    await evidence("web-native-no-coordination-block", {
      conversation,
      input,
      before,
      accepted,
      finished,
      view,
    });
  }
);

test(
  "web work keeps its acknowledgement, exact queued report, and useful coordinator result as separate turns",
  { timeout: 180_000 },
  async () => {
    await noSlack();
    await controlQueue("pause");
    try {
      const { conversation, route } = await createConversation();
      const input = {
        operationId: crypto.randomUUID(),
        text: "PERSISTENT_AGENT_FIXTURE storage:web-tracker. Recommend SQLite with sync or IndexedDB with sync for an offline five-person task tracker. Compare correctness and implementation effort.",
      };
      const before = await observed();
      const receipt = await sendMessage(route, input);
      assert.equal(receipt.receipt.accepted, true);
      assert.equal(receipt.receipt.operationId, input.operationId);
      const initialReplay = await sendMessage(route, input);
      assert.equal(initialReplay.receipt.accepted, false);
      const accepted = await waitStartedWork(route, input.text);
      assert.ok(accepted.work);
      const target = accepted.work;
      const previousEntryIds = new Set(
        accepted.view.snapshot.messages.map((message) => message.id)
      );
      const completedRoles = await waitForFixture(
        observed,
        (value) =>
          completedCalls(value, teamRoles.coordinator).length ===
            completedCalls(before, teamRoles.coordinator).length + 2 &&
          completedCalls(value, teamRoles.lead).length ===
            completedCalls(before, teamRoles.lead).length + 2 &&
          completedCalls(value, teamRoles.worker).length ===
            completedCalls(before, teamRoles.worker).length + 2,
        90_000
      );
      const waiting = await waitWorkReport("cerebro-team-reports", target);
      const delivery = matchingWorkReport(waiting, target);
      assert.ok(delivery?.kind === "report");
      assert.equal(delivery.wire.report.kind, "completed");
      assert.ok(delivery.wire.report.kind === "completed");
      const { report } = delivery.wire;
      assert.equal(delivery.wire.version, 2);
      assert.match(
        report.text,
        /SQLite transactions protect local multi-row edits/u
      );
      assert.match(report.text, /IndexedDB fits browser deployment/u);
      const expectedInput = await reportInputDigest(delivery.wire);
      await controlQueue("resume");
      const reportQueue = await drained("cerebro-team-reports");
      const completed = await waitForFixture(
        observed,
        (value) =>
          completedCalls(value, teamRoles.coordinator).length ===
            completedCalls(before, teamRoles.coordinator).length + 3 &&
          value.model.some(
            (call) =>
              call.role === teamRoles.coordinator &&
              call.completedAt !== undefined &&
              call.messageTextDigests.includes(expectedInput)
          ),
        60_000
      );
      const view = await waitForFixture(
        () => read(route),
        (value) =>
          !value.snapshot.busy &&
          value.snapshot.messages.some(
            (message) =>
              message.role === "assistant" &&
              !previousEntryIds.has(message.id) &&
              message.text ===
                `Team report received. ${report.text.slice(0, 2000)}`
          )
      );
      assert.deepEqual(view.snapshot.address, accepted.view.snapshot.address);
      assert.deepEqual(
        view.snapshot.messages.filter((message) =>
          previousEntryIds.has(message.id)
        ),
        accepted.view.snapshot.messages
      );
      const saved = startedWork(view.snapshot, input.text);
      assert.ok(saved);
      assert.equal(saved.work.workId, target.key.workId);
      assert.equal(
        view.snapshot.messages.filter(
          (message) => message.role === "user" && message.text === input.text
        ).length,
        1
      );
      assert.equal(
        view.snapshot.messages.filter(
          (message) =>
            message.role === "assistant" &&
            !previousEntryIds.has(message.id) &&
            message.text ===
              `Team report received. ${report.text.slice(0, 2000)}`
        ).length,
        1
      );
      assert.equal(
        view.snapshot.activity?.backgroundWork?.status.kind,
        "completed"
      );
      assert.equal(
        await fixture.sql(
          `SELECT count(*) FROM channel_conversation WHERE agent_id=${literal(publishedAgent().agentId)} AND conversation_id<>${literal(conversation.conversationId)}`
        ),
        "0"
      );
      assert.equal(completed.slack.calls.length, 0);
      const calls = completedRoles.model.slice(before.model.length);
      for (const call of calls) {
        assert.equal(call.model, agentWireModel);
        if (call.role === teamRoles.coordinator) {
          assert.ok(
            coordinatorTools.every((name) => call.toolNames.includes(name))
          );
        } else {
          assert.ok(
            coordinatorTools.every((name) => !call.toolNames.includes(name))
          );
          assert.equal(
            call.toolNames.includes("return_event"),
            call.role === teamRoles.lead
          );
        }
      }
      const retainedIds = view.snapshot.messages.map((message) => message.id);
      const reopened = await createConversation();
      assert.deepEqual(reopened.conversation, conversation);
      const repeatedInput = await sendMessage(route, input);
      assert.equal(repeatedInput.receipt.accepted, false);
      assert.deepEqual(await read(route), view);
      assert.deepEqual(await read(route), view);
      const replay = await observed();
      assert.equal(replay.model.length, completed.model.length);
      assert.equal(replay.slack.calls.length, 0);
      await evidence("web-native-exact-report", {
        conversation,
        input,
        receipt,
        target,
        before,
        accepted,
        completedRoles,
        waiting,
        delivery,
        expectedInput,
        reportQueue,
        completed,
        view,
        retainedIds,
        replay,
      });
    } finally {
      await controlQueue("resume");
    }
  }
);

test(
  "same-volume web recovery makes physical progress and a real report before its first post-kill reader",
  { timeout: 180_000 },
  async () => {
    await noSlack();
    await controlQueue("pause");
    await fixture.controls({
      models: { [teamRoles.lead]: { hold: true, delayMs: 0 } },
    });
    try {
      const { conversation, route } = await createConversation();
      const input = {
        operationId: crypto.randomUUID(),
        text: "PERSISTENT_AGENT_FIXTURE storage:web-recovery. Compare offline edit correctness and sync maintenance for a five-person task tracker.",
      };
      const before = await observed();
      await sendMessage(route, input);
      const held = await heldAcceptance(before);
      const accepted = await waitStartedWork(route, input.text);
      assert.ok(accepted.work);
      const target = accepted.work;
      const previousEntryIds = new Set(
        accepted.view.snapshot.messages.map((message) => message.id)
      );
      const heldLead = held.model
        .slice(before.model.length)
        .find(
          (call) =>
            call.role === teamRoles.lead && call.completedAt === undefined
        );
      assert.ok(heldLead);
      const celld = await fixture.container("celld");
      const identity = await mounts(celld);
      const killedAt = Date.now();
      await docker("kill", "--signal", "KILL", celld);
      await compose("up", "--no-deps", "-d", "--wait", "celld");
      await ready();
      assert.equal(await fixture.container("celld"), celld);
      assert.deepEqual(await mounts(celld), identity);
      await fixture.controls({ models: {}, release: true });
      const physical = await waitForFixture(
        observed,
        (value) =>
          value.model.some(
            (call) =>
              call.role === teamRoles.lead &&
              call.operationId === heldLead.operationId &&
              call.startedAt > killedAt &&
              call.completedAt !== undefined
          ) &&
          completedCalls(value, teamRoles.lead).length >=
            completedCalls(before, teamRoles.lead).length + 2 &&
          completedCalls(value, teamRoles.worker).length ===
            completedCalls(before, teamRoles.worker).length + 2,
        90_000
      );
      const physicalAt = Date.now();
      const waiting = await waitWorkReport("cerebro-team-reports", target);
      const delivery = matchingWorkReport(waiting, target);
      assert.ok(delivery?.kind === "report");
      assert.ok(delivery.wire.report.kind === "completed");
      const { report } = delivery.wire;
      const expectedInput = await reportInputDigest(delivery.wire);
      const queueObservedAt = Date.now();
      await controlQueue("resume");
      const reportQueue = await drained("cerebro-team-reports");
      const completed = await waitForFixture(
        observed,
        (value) =>
          completedCalls(value, teamRoles.coordinator).length ===
            completedCalls(before, teamRoles.coordinator).length + 3 &&
          value.model.some(
            (call) =>
              call.role === teamRoles.coordinator &&
              call.startedAt > queueObservedAt &&
              call.completedAt !== undefined &&
              call.messageTextDigests.includes(expectedInput)
          ),
        60_000
      );
      const firstReadAt = Date.now();
      assert.ok(
        killedAt < physicalAt &&
          physicalAt <= queueObservedAt &&
          queueObservedAt < firstReadAt
      );
      const view = await waitForFixture(
        () => read(route),
        (value) =>
          !value.snapshot.busy &&
          value.snapshot.messages.some(
            (message) =>
              message.role === "assistant" &&
              !previousEntryIds.has(message.id) &&
              message.text ===
                `Team report received. ${report.text.slice(0, 2000)}`
          )
      );
      assert.deepEqual(
        view.snapshot.messages.filter((message) =>
          previousEntryIds.has(message.id)
        ),
        accepted.view.snapshot.messages
      );
      const saved = startedWork(view.snapshot, input.text);
      assert.ok(saved);
      assert.equal(saved.work.workId, target.key.workId);
      assert.equal(saved.call.id, target.call.id);
      assert.equal(saved.call.resultMessageId, target.call.resultMessageId);
      assert.equal(
        view.snapshot.messages.filter(
          (message) => message.role === "user" && message.text === input.text
        ).length,
        1
      );
      assert.equal(
        view.snapshot.messages.filter(
          (message) =>
            message.role === "assistant" &&
            !previousEntryIds.has(message.id) &&
            message.text ===
              `Team report received. ${report.text.slice(0, 2000)}`
        ).length,
        1
      );
      assert.equal(
        view.snapshot.activity?.backgroundWork?.status.kind,
        "completed"
      );
      assert.equal(completed.slack.calls.length, 0);
      const repeatedInput = await sendMessage(route, input);
      assert.equal(repeatedInput.receipt.accepted, false);
      assert.deepEqual(await read(route), view);
      assert.deepEqual(await read(route), view);
      const replay = await observed();
      assert.equal(replay.model.length, completed.model.length);
      await evidence("web-native-no-reader-recovery", {
        conversation,
        input,
        target,
        before,
        held,
        heldLead,
        accepted,
        celld,
        identity,
        killedAt,
        physicalAt,
        physical,
        waiting,
        delivery,
        queueObservedAt,
        reportQueue,
        expectedInput,
        completed,
        firstReadAt,
        view,
        replay,
      });
    } finally {
      await fixture.controls({ models: {}, release: true });
      await controlQueue("resume");
    }
  }
);
