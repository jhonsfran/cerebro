import assert from "node:assert/strict";
import { before as beforeAll, test } from "node:test";

import { z } from "zod";

import { waitForFixture } from "../../slice-1/application.ts";
import { matchingWorkReport, reportInputDigest } from "./team-queue-support.ts";
import {
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
  wireModels,
} from "./team-support.ts";
import {
  coordinatorTools,
  createConversation,
  heldAcceptance,
  noSlack,
  read,
  roles,
  sendMessage,
  setupWebTeam,
  startedWork,
  waitStartedWork,
  waitWorkReport,
} from "./web-team-support.ts";

beforeAll(setupWebTeam, { timeout: 180_000 });

const coordinationConfiguration = async (enabled: boolean) => {
  await compose(
    "run",
    "--no-deps",
    "--rm",
    "test-config",
    "node",
    "--input-type=module",
    "-e",
    "import {readFile,writeFile} from 'node:fs/promises'; const p='/run/cerebro-secrets/runtime.json'; const c=JSON.parse(await readFile(p,'utf8')); const v=JSON.parse(process.argv[1]); if(v) c.coordination=v; else delete c.coordination; await writeFile(p,JSON.stringify(c),{mode:0o600});",
    JSON.stringify(
      enabled
        ? {
            leadAgentId: roles().lead.agentId,
            workerAgentId: roles().worker.agentId,
          }
        : null
    )
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
  "a profile-free primary keeps ordinary coordinator chat without foreground or Team execution",
  { timeout: 180_000 },
  async () => {
    await coordinationConfiguration(false);
    try {
      await noSlack();
      const { conversation, route } = await createConversation();
      const input = {
        operationId: crypto.randomUUID(),
        text: "Give one brief ordinary answer. profile-free.",
      };
      const before = await observed();
      await sendMessage(route, input);
      const completed = await waitForFixture(
        observed,
        (value) =>
          value.model.length === before.model.length + 1 &&
          value.model.at(-1)?.completedAt !== undefined
      );
      const view = await waitForFixture(
        () => read(route),
        (value) =>
          !value.snapshot.busy &&
          value.snapshot.messages.some(
            (entry) =>
              entry.role === "assistant" &&
              entry.text === "Cerebro slice 1 completed."
          )
      );
      assert.equal(view.snapshot.activity?.backgroundWork, undefined);
      assert.deepEqual(view.snapshot.tools, []);
      assert.deepEqual(view.snapshot.approvals, []);
      const call = completed.model.at(-1);
      assert.ok(call);
      assert.ok(
        [...coordinatorTools, "fixture-read", "fixture_effect"].every(
          (name) => !call.toolNames.includes(name)
        )
      );
      assert.equal(completed.slack.calls.length, 0);
      const reopened = await createConversation();
      assert.deepEqual(reopened.conversation, conversation);
      await evidence("web-native-profile-free", {
        conversation,
        input,
        before,
        completed,
        view,
      });
    } finally {
      await coordinationConfiguration(true);
    }
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
          completedCalls(value, wireModels.coordinator).length ===
            completedCalls(before, wireModels.coordinator).length + 2 &&
          completedCalls(value, wireModels.lead).length ===
            completedCalls(before, wireModels.lead).length + 2 &&
          completedCalls(value, wireModels.worker).length ===
            completedCalls(before, wireModels.worker).length + 2,
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
          completedCalls(value, wireModels.coordinator).length ===
            completedCalls(before, wireModels.coordinator).length + 3 &&
          value.model.some(
            (call) =>
              call.model === wireModels.coordinator &&
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
          `SELECT count(*) FROM channel_conversation WHERE agent_id IN (${literal(roles().lead.agentId)},${literal(roles().worker.agentId)})`
        ),
        "0"
      );
      assert.equal(completed.slack.calls.length, 0);
      const calls = completedRoles.model.slice(before.model.length);
      for (const call of calls) {
        if (call.model === wireModels.coordinator) {
          assert.ok(
            coordinatorTools.every((name) => call.toolNames.includes(name))
          );
        } else {
          assert.ok(
            coordinatorTools.every((name) => !call.toolNames.includes(name))
          );
          assert.equal(
            call.toolNames.includes("delegate_worker"),
            call.model === wireModels.lead
          );
          assert.equal(
            call.toolNames.includes("return_event"),
            call.model === wireModels.lead
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
      models: { [wireModels.lead]: { hold: true, delayMs: 0 } },
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
            call.model === wireModels.lead && call.completedAt === undefined
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
              call.model === wireModels.lead &&
              call.operationId === heldLead.operationId &&
              call.startedAt > killedAt &&
              call.completedAt !== undefined
          ) &&
          completedCalls(value, wireModels.lead).length >=
            completedCalls(before, wireModels.lead).length + 2 &&
          completedCalls(value, wireModels.worker).length ===
            completedCalls(before, wireModels.worker).length + 2,
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
          completedCalls(value, wireModels.coordinator).length ===
            completedCalls(before, wireModels.coordinator).length + 3 &&
          value.model.some(
            (call) =>
              call.model === wireModels.coordinator &&
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
