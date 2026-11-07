/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Native page cursors, authority changes, and configuration-loss checkpoints are ordered. */
import assert from "node:assert/strict";
import { before as beforeAll, test } from "node:test";

import { z } from "zod";

import {
  INSPECTION_MAX_BYTES,
  INSPECTION_PAGE_SIZE,
} from "../../../packages/contracts/src/inspection.ts";
import { workCellName } from "../../../packages/contracts/src/work.ts";
import { waitForFixture } from "../../slice-1/application.ts";
import { cellInventory } from "./cell-evidence.ts";
import { inspect, overview, waitTeamAdmission } from "./inspection-support.ts";
import {
  matchingWorkReport,
  reportEvent,
  reportInputDigest,
} from "./team-queue-support.ts";
import {
  agentWireModel,
  compose,
  completedCalls,
  configure,
  coordinatorDefinition,
  controlQueue,
  drained,
  evidence,
  fixture,
  literal,
  metadata,
  observed,
  ready,
  teamRoles,
} from "./team-support.ts";
import {
  access,
  createConversation,
  publishedSchema,
  read,
  sendMessage,
  sendTurn,
  startedWork,
  stopWork,
  waitStartedWork,
  waitWorkReport,
} from "./web-team-support.ts";

let installed: Awaited<ReturnType<typeof configure>>;
beforeAll(
  async () => {
    installed = await configure();
  },
  { timeout: 180_000 }
);
const open = () => createConversation(installed.coordinator.agentId);
const startGoal = async (route: string, text: string) => {
  await sendMessage(route, { operationId: crypto.randomUUID(), text });
  const accepted = await waitStartedWork(route, text);
  assert.ok(accepted.work);
  return accepted.work;
};
const retire = async (
  route: string,
  targets: Awaited<ReturnType<typeof startGoal>>[]
) => {
  await controlQueue("pause");
  for (const target of targets) {
    await stopWork(route, target.key.workId);
  }
  await fixture.controls({ models: {}, failFirst: false, release: true });
  await Promise.all(
    targets.map((target) => waitWorkReport("cerebro-team-reports", target))
  );
  await controlQueue("resume");
  await drained("cerebro-team-reports");
  await waitForFixture(
    () => overview(route),
    (value) =>
      targets.every((target) =>
        value.work.some(
          (work) => work.workId === target.key.workId && !work.reservationHeld
        )
      )
  );
};

test(
  "protected Inspector shows real active roles, retry attempts, native tasks, and READ without EXECUTE",
  { timeout: 180_000 },
  async () => {
    await fixture.controls({
      failFirst: true,
      models: { [teamRoles.lead]: { hold: true, delayMs: 0 } },
    });
    await controlQueue("pause");
    const { route, conversation } = await open();
    try {
      const goal =
        "PERSISTENT_AGENT_FIXTURE storage:inspector-active. Compare offline storage correctness and maintenance.";
      await sendMessage(route, {
        operationId: crypto.randomUUID(),
        text: goal,
      });
      const placed = await waitForFixture(
        () => read(route),
        (value) => startedWork(value.snapshot, goal) !== undefined
      );
      const target = startedWork(placed.snapshot, goal);
      assert.ok(target);
      const physical = await waitForFixture(
        observed,
        (value) =>
          value.held > 0 &&
          value.model.some(
            (call) => call.role === teamRoles.lead && call.status === 503
          )
      );
      const failed = physical.model.find(
        (call) => call.role === teamRoles.lead && call.status === 503
      );
      assert.ok(failed);
      assert.ok(
        physical.model.some(
          (call) =>
            call.role === teamRoles.lead &&
            call.operationId === failed.operationId &&
            call.startedAt > failed.startedAt
        )
      );
      const active = await waitForFixture(
        () => inspect(route, { kind: "team", workId: target.key.workId }),
        (value) =>
          value.kind === "team" &&
          value.team.kind === "available" &&
          value.team.roles.some(
            (role) =>
              role.slot === 0 &&
              role.running &&
              role.attempt !== null &&
              role.attempt >= 1
          ),
        60_000
      );
      assert.ok(active.kind === "team" && active.team.kind === "available");
      assert.equal(active.team.cell, workCellName(target.key));
      assert.equal(active.team.sealed, false);
      assert.deepEqual(
        active.team.roles.map((role) => role.slot),
        [0, 1, 2]
      );
      assert.deepEqual(
        active.team.roles.map((role) => role.role),
        ["lead", "worker", "worker"]
      );
      assert.ok(
        active.team.roles.every(
          (role) =>
            role.definition.agentId === installed.coordinator.agentId &&
            role.definition.agentVersion === installed.coordinator.version
        )
      );
      assert.equal(
        new Set(active.team.roles.map((role) => role.nativeId)).size,
        3
      );
      assert.ok(
        active.team.roles.every((role) => role.modelId === agentWireModel)
      );
      assert.ok(
        active.team.requestReservations > 0 &&
          active.team.requestReservations <= active.team.requestLimit
      );
      const pages = await Promise.all(
        ([0, 1, 2] as const).map(async (role) => {
          assert.ok(role === 0 || role === 1 || role === 2);
          const tasks = await inspect(route, {
            kind: "tasks",
            workId: target.key.workId,
            role,
          });
          const transcript = await inspect(route, {
            kind: "transcript",
            workId: target.key.workId,
            role,
          });
          assert.ok(tasks.kind === "tasks" && transcript.kind === "transcript");
          assert.ok(tasks.tasks.length <= INSPECTION_PAGE_SIZE);
          assert.ok(
            transcript.messages.length <= INSPECTION_PAGE_SIZE &&
              transcript.tools.length <= INSPECTION_PAGE_SIZE
          );
          assert.ok(
            Buffer.byteLength(JSON.stringify(transcript)) <=
              INSPECTION_MAX_BYTES
          );
          return { tasks, transcript };
        })
      );
      assert.ok(
        pages[0]?.tasks.tasks.some(
          (task) => task.status === "running" && task.kind === "pi.generation"
        )
      );
      await access(
        ["read"],
        metadata.agent.principalId,
        installed.coordinator.agentId
      );
      const readOnly = await Promise.all([
        inspect(route, { kind: "overview" }),
        inspect(route, { kind: "history" }),
        inspect(route, { kind: "events" }),
        inspect(route, { kind: "team", workId: target.key.workId }),
        inspect(route, { kind: "tasks", workId: target.key.workId, role: 0 }),
      ]);
      assert.equal((await observed()).model.length, physical.model.length);
      const execute = await fixture.request(
        `${route}/messages`,
        metadata.owner.cookie,
        {
          operationId: crypto.randomUUID(),
          text: "This read-only actor cannot start new work.",
        }
      );
      assert.equal(execute.status, 403);
      await execute.body?.cancel();
      await access(
        ["execute"],
        metadata.agent.principalId,
        installed.coordinator.agentId
      );
      const denied = await fixture.request(
        `${route}/inspection`,
        metadata.owner.cookie,
        { query: { kind: "team", workId: target.key.workId } }
      );
      assert.equal(denied.status, 403);
      await denied.body?.cancel();
      await access(
        ["read", "execute", "approve"],
        metadata.agent.principalId,
        installed.coordinator.agentId
      );
      const outsider = await fixture.signup("Inspector outsider");
      const foreign = await fixture.request(
        `${route}/inspection`,
        outsider.cookie,
        { query: { kind: "overview" } }
      );
      assert.equal(foreign.status, 403);
      await foreign.body?.cancel();
      const peer = await fixture.signup("Inspector company peer");
      const peerId = `inspector-peer-${crypto.randomUUID()}`;
      await fixture.sql(
        `INSERT INTO identity_principal (id,organization_id,better_auth_user_id,kind,state) VALUES (${[peerId, metadata.agent.organizationId, peer.userId].map(literal).join(",")},'human','active')`
      );
      await access(["read", "execute"], peerId, installed.coordinator.agentId);
      const notOwner = await fixture.request(
        `${route}/inspection`,
        peer.cookie,
        { query: { kind: "team", workId: target.key.workId } }
      );
      assert.equal(notOwner.status, 404);
      await notOwner.body?.cancel();
      await retire(route, [target]);
      await evidence("native-inspector-active-read-authority", {
        conversation,
        target,
        active,
        physical,
        failed,
        pages,
        readOnly,
        peerId,
      });
    } finally {
      await access(
        ["read", "execute", "approve"],
        metadata.agent.principalId,
        installed.coordinator.agentId
      );
      await fixture.controls({ models: {}, failFirst: false, release: true });
      await controlQueue("resume");
    }
  }
);

test(
  "real queued cancellations produce bounded Work and event pages without creating a private Team",
  { timeout: 300_000 },
  async () => {
    const { route, conversation } = await open();
    await controlQueue("pause");
    await fixture.controls({
      models: { [teamRoles.lead]: { hold: true, delayMs: 0 } },
    });
    try {
      const first = await startGoal(
        route,
        "PERSISTENT_AGENT_FIXTURE storage:history-active-a. Review offline edit recovery."
      );
      const second = await startGoal(
        route,
        "PERSISTENT_AGENT_FIXTURE slack:history-active-b. Review event filtering."
      );
      const calibration = await waitForFixture(
        () =>
          Promise.all([cellInventory(first.key), cellInventory(second.key)]),
        (values) => values.every((value) => value.local && value.bucket)
      );
      const held = await waitForFixture(observed, (value) => value.held === 2);
      const cancelled = [];
      let absence;
      for (const index of Array.from({ length: 34 }, (_, value) => value)) {
        const target = await startGoal(
          route,
          `PERSISTENT_AGENT_FIXTURE storage:history-${index}. Review one bounded queued implementation constraint.`
        );
        assert.equal(target.work.status.kind, "queued");
        if (index === 0) {
          const before = await cellInventory(target.key);
          assert.equal(before.local || before.bucket, false);
          const team = await inspect(route, {
            kind: "team",
            workId: target.key.workId,
          });
          assert.ok(team.kind === "team");
          assert.deepEqual(team.team, { kind: "not-started" });
          const missing = await fixture.request(
            `${route}/inspection`,
            metadata.owner.cookie,
            { query: { kind: "tasks", workId: target.key.workId, role: 0 } }
          );
          assert.equal(missing.status, 404);
          await missing.body?.cancel();
          absence = { before, team, after: await cellInventory(target.key) };
          assert.deepEqual(absence.after, before);
        }
        await stopWork(route, target.key.workId);
        cancelled.push(target.key.workId);
      }
      const history = await inspect(route, { kind: "history" });
      const events = await inspect(route, { kind: "events" });
      assert.ok(history.kind === "history" && events.kind === "events");
      assert.ok(history.work.length <= 32 && history.next !== null);
      assert.ok(events.events.length <= 32 && events.next !== null);
      const nextHistory = await inspect(route, {
        kind: "history",
        cursor: history.next,
      });
      const nextEvents = await inspect(route, {
        kind: "events",
        cursor: events.next,
      });
      assert.ok(nextHistory.kind === "history" && nextEvents.kind === "events");
      const workIds = [...history.work, ...nextHistory.work].map(
        (work) => work.workId
      );
      assert.equal(new Set(workIds).size, workIds.length);
      assert.ok(cancelled.every((id) => workIds.includes(id)));
      assert.equal(
        new Set([...events.events, ...nextEvents.events].map((item) => item.id))
          .size,
        events.events.length + nextEvents.events.length
      );
      const other = await fixture.json(
        "/api/product/agents",
        metadata.owner.cookie,
        publishedSchema,
        {
          operationId: crypto.randomUUID(),
          name: "Inspector cursor source",
          model: "fixture/slack-coordinator",
          instructions: "Answer ordinary input.",
          enabledToolIds: [],
          grants: [],
        }
      );
      const foreign = await createConversation(other.agentId);
      await read(foreign.route);
      for (const [targetRoute, query] of [
        [foreign.route, { kind: "history", cursor: history.next }],
        [
          route,
          {
            kind: "tasks",
            workId: first.key.workId,
            role: 1,
            cursor: history.next,
          },
        ],
        [
          route,
          {
            kind: "transcript",
            workId: second.key.workId,
            role: 0,
            cursor: history.next,
          },
        ],
      ] as const) {
        const invalid = await fixture.request(
          `${targetRoute}/inspection`,
          metadata.owner.cookie,
          { query }
        );
        assert.equal(invalid.status, 400);
        await invalid.body?.cancel();
      }
      const reports = await Promise.all(
        [first, second].map(async (target) => {
          const queued = await waitWorkReport(
            "cerebro-team-reports",
            target,
            120_000
          );
          const delivery = matchingWorkReport(queued, target);
          assert.ok(
            delivery?.kind === "report" &&
              delivery.wire.report.kind === "failed"
          );
          return {
            target,
            queued,
            delivery,
            event: await reportEvent(delivery.wire),
            inputDigest: await reportInputDigest(delivery.wire, "pilot"),
          };
        })
      );
      const beforeRelease = await observed();
      await fixture.controls({ models: {}, release: true });
      await controlQueue("resume");
      await drained("cerebro-team-reports");
      const physical = await waitForFixture(
        observed,
        (value) =>
          completedCalls(value, teamRoles.coordinator).length ===
            completedCalls(beforeRelease, teamRoles.coordinator).length + 2 &&
          reports.every(
            (report) =>
              completedCalls(value, teamRoles.coordinator).filter(
                (call) => call.messageTextDigests.at(-1) === report.inputDigest
              ).length === 1
          ),
        120_000
      );
      const terminal = await waitForFixture(
        async () => {
          let page = await inspect(route, { kind: "history" });
          assert.ok(page.kind === "history");
          const pages = [page];
          while (page.next !== null) {
            assert.ok(pages.length < 4);
            page = await inspect(route, { kind: "history", cursor: page.next });
            assert.ok(page.kind === "history");
            pages.push(page);
          }
          return pages;
        },
        (pages) =>
          reports.every((report) =>
            pages.some((page) =>
              page.work.some(
                (work) =>
                  work.workId === report.target.key.workId &&
                  work.status === "failed" &&
                  !work.reservationHeld &&
                  work.result?.id === report.delivery.wire.report.id &&
                  work.result.kind === "failed"
              )
            )
          )
      );
      const previousResults = new Set(
        [...history.work, ...nextHistory.work].flatMap((work) =>
          work.result ? [work.result.id] : []
        )
      );
      assert.deepEqual(
        terminal
          .flatMap((page) => page.work)
          .flatMap((work) =>
            work.result && !previousResults.has(work.result.id)
              ? [work.result.id]
              : []
          )
          .toSorted(),
        reports.map((report) => report.delivery.wire.report.id).toSorted()
      );
      const settled = await waitForFixture(
        async () => {
          let page = await inspect(route, { kind: "events" });
          assert.ok(page.kind === "events");
          const pages = [page];
          while (
            !reports.every((report) =>
              pages.some((value) =>
                value.events.some((item) => item.id === report.event.id)
              )
            )
          ) {
            assert.ok(pages.length < 4 && page.next !== null);
            page = await inspect(route, { kind: "events", cursor: page.next });
            assert.ok(page.kind === "events");
            pages.push(page);
          }
          return pages;
        },
        (pages) =>
          reports.every((report) =>
            pages.some((page) =>
              page.events.some(
                (item) =>
                  item.id === report.event.id &&
                  item.channel === "teamreport" &&
                  item.route === "inbox" &&
                  item.placement === "done" &&
                  item.duplicates === 0 &&
                  item.reply === null
              )
            )
          )
      );
      await evidence("native-inspector-real-pages-queued-absence", {
        conversation,
        first,
        second,
        calibration,
        held,
        absence,
        cancelled,
        history,
        events,
        nextHistory,
        nextEvents,
        foreign: foreign.conversation,
        reports,
        beforeRelease,
        physical,
        terminal,
        settled,
      });
    } finally {
      await fixture.controls({ models: {}, release: true });
      await controlQueue("resume");
    }
  }
);

test(
  "actual private connector content remains inspectable with READ and is denied after current content revocation",
  { timeout: 240_000 },
  async () => {
    const { route, conversation } = await open();
    await controlQueue("pause");
    await fixture.controls({
      models: { [teamRoles.worker]: { hold: true, delayMs: 0 } },
    });
    let removed: string | undefined;
    try {
      const target = await startGoal(
        route,
        "PERSISTENT_AGENT_FIXTURE storage:inspector-content. Compare correctness and implementation effort."
      );
      await waitForFixture(observed, (value) => value.held >= 2);
      const beforeAdmission = await inspect(route, {
        kind: "tasks",
        workId: target.key.workId,
        role: 0,
      });
      assert.ok(beforeAdmission.kind === "tasks");
      const update = await sendTurn(
        route,
        "PERSISTENT_AGENT_FIXTURE update storage:inspector-content. Use fixture-read for the current refund policy."
      );
      assert.ok(
        update.tools.some(
          (tool) =>
            tool.toolName === "message_team" && tool.state === "succeeded"
        )
      );
      const admission = await waitTeamAdmission(
        route,
        target.key.workId,
        beforeAdmission
      );
      await fixture.controls({ models: {}, release: true });
      const waiting = await waitWorkReport("cerebro-team-reports", target);
      const delivery = matchingWorkReport(waiting, target);
      assert.ok(
        delivery?.kind === "report" && delivery.wire.report.kind === "completed"
      );
      assert.ok(
        delivery.wire.report.contentDependencies.toolIds.includes(
          "fixture-read"
        )
      );
      const transcript = await inspect(route, {
        kind: "transcript",
        workId: target.key.workId,
        role: 0,
      });
      assert.ok(transcript.kind === "transcript");
      assert.ok(
        transcript.tools.some(
          (tool) => tool.name === "fixture-read" && tool.status === "succeeded"
        )
      );
      assert.ok(
        transcript.tools.every(
          (tool) =>
            tool.input.kind === "unavailable" ||
            tool.input.content.text.length <= 2000
        )
      );
      const condition = `organization_id=${literal(metadata.agent.organizationId)} AND principal_id=${literal(metadata.agent.principalId)} AND action='read' AND resource_kind='tool' AND resource_id='fixture-read'`;
      removed = await fixture.sql(
        `SELECT coalesce(json_agg(t),'[]'::json) FROM identity_grant t WHERE ${condition}`
      );
      assert.ok(z.array(z.unknown()).parse(JSON.parse(removed)).length > 0);
      await fixture.sql(`DELETE FROM identity_grant WHERE ${condition}`);
      const denied = await fixture.request(
        `${route}/inspection`,
        metadata.owner.cookie,
        { query: { kind: "transcript", workId: target.key.workId, role: 0 } }
      );
      assert.equal(denied.status, 403);
      await denied.body?.cancel();
      await fixture.sql(
        `INSERT INTO identity_grant SELECT * FROM json_populate_recordset(NULL::identity_grant,${literal(removed)}::json) ON CONFLICT DO NOTHING`
      );
      removed = undefined;
      await access(
        ["read"],
        metadata.agent.principalId,
        installed.coordinator.agentId
      );
      assert.deepEqual(
        await inspect(route, {
          kind: "transcript",
          workId: target.key.workId,
          role: 0,
        }),
        transcript
      );
      await access(
        ["read", "execute", "approve"],
        metadata.agent.principalId,
        installed.coordinator.agentId
      );
      const expectedInput = await reportInputDigest(delivery.wire, "pilot");
      await controlQueue("resume");
      await drained("cerebro-team-reports");
      await waitForFixture(observed, (value) =>
        value.model.some(
          (call) =>
            call.completedAt !== undefined &&
            call.messageTextDigests.includes(expectedInput)
        )
      );
      await waitForFixture(
        () => overview(route),
        (value) =>
          value.work.some(
            (work) =>
              work.workId === target.key.workId &&
              work.result?.id === delivery.wire.report.id
          )
      );
      await evidence("native-inspector-current-content", {
        conversation,
        target,
        update,
        admission,
        waiting,
        delivery,
        transcript,
        expectedInput,
      });
    } finally {
      if (removed !== undefined) {
        await fixture.sql(
          `INSERT INTO identity_grant SELECT * FROM json_populate_recordset(NULL::identity_grant,${literal(
            removed
          )}::json) ON CONFLICT DO NOTHING`
        );
      }
      await access(
        ["read", "execute", "approve"],
        metadata.agent.principalId,
        installed.coordinator.agentId
      );
      await fixture.controls({ models: {}, failFirst: false, release: true });
      await controlQueue("resume");
    }
  }
);

test(
  "a genuinely sealed Team keeps its saved result, roles, tasks, and usage after its agent is republished with another model and cold reopen",
  { timeout: 240_000 },
  async () => {
    const { route, conversation } = await open();
    await controlQueue("pause");
    const target = await startGoal(
      route,
      "PERSISTENT_AGENT_FIXTURE storage:inspector-sealed. Compare offline correctness and implementation effort."
    );
    const waiting = await waitWorkReport("cerebro-team-reports", target);
    const delivery = matchingWorkReport(waiting, target);
    assert.ok(
      delivery?.kind === "report" && delivery.wire.report.kind === "completed"
    );
    const expectedInput = await reportInputDigest(delivery.wire, "pilot");
    await controlQueue("resume");
    await drained("cerebro-team-reports");
    await waitForFixture(observed, (value) =>
      value.model.some(
        (call) =>
          call.completedAt !== undefined &&
          call.messageTextDigests.includes(expectedInput)
      )
    );
    const sealed = await waitForFixture(
      () => inspect(route, { kind: "team", workId: target.key.workId }),
      (value) =>
        value.kind === "team" &&
        value.team.kind === "available" &&
        value.team.sealed &&
        value.work.result?.id === delivery.wire.report.id,
      60_000
    );
    assert.ok(sealed.kind === "team" && sealed.team.kind === "available");
    const settledConversation = await waitForFixture(
      () => read(route),
      (value) => !value.snapshot.busy
    );
    assert.deepEqual(
      sealed.team.roles.map((role) => role.role),
      ["lead", "worker", "worker"]
    );
    const [pin] = sealed.team.roles.map((role) => role.definition);
    assert.ok(pin);
    assert.equal(pin.agentId, installed.coordinator.agentId);
    assert.ok(
      sealed.team.roles.every(
        (role) =>
          role.definition.agentId === pin.agentId &&
          role.definition.agentVersion === pin.agentVersion &&
          role.modelId === agentWireModel
      )
    );
    assert.ok(sealed.team.roles.every((role) => role.usage.totalTokens > 0));
    const pages = await Promise.all(
      ([0, 1, 2] as const).map(async (role) => {
        assert.ok(role === 0 || role === 1 || role === 2);
        return {
          role,
          tasks: await inspect(route, {
            kind: "tasks",
            workId: target.key.workId,
            role,
          }),
          transcript: await inspect(route, {
            kind: "transcript",
            workId: target.key.workId,
            role,
          }),
        };
      })
    );
    const physical = await observed();
    const republished = await fixture.json(
      `/api/product/agents/${encodeURIComponent(pin.agentId)}`,
      metadata.owner.cookie,
      publishedSchema,
      {
        ...coordinatorDefinition(),
        expectedVersion: pin.agentVersion,
        operationId: crypto.randomUUID(),
        model: "fixture/slice-1",
        instructions: "Handle only future work with the supplied tools.",
      },
      "PUT"
    );
    assert.equal(republished.agentId, pin.agentId);
    assert.equal(republished.version, pin.agentVersion + 1);
    await compose("restart", "celld");
    await ready();
    const sealedView = { work: sealed.work, team: sealed.team };
    const cold = await inspect(route, {
      kind: "team",
      workId: target.key.workId,
    });
    assert.ok(cold.kind === "team");
    assert.deepEqual({ work: cold.work, team: cold.team }, sealedView);
    const repeated = await inspect(route, {
      kind: "team",
      workId: target.key.workId,
    });
    assert.ok(repeated.kind === "team");
    assert.deepEqual({ work: repeated.work, team: repeated.team }, sealedView);
    for (const page of pages) {
      assert.deepEqual(
        await inspect(route, {
          kind: "tasks",
          workId: target.key.workId,
          role: page.role,
        }),
        page.tasks
      );
      assert.deepEqual(
        await inspect(route, {
          kind: "transcript",
          workId: target.key.workId,
          role: page.role,
        }),
        page.transcript
      );
    }
    assert.equal((await observed()).model.length, physical.model.length);
    await evidence("native-inspector-sealed-republish", {
      fault: "the Team's agent republished with another model after sealing",
      conversation,
      target,
      waiting,
      delivery,
      expectedInput,
      sealed,
      settledConversation,
      pages,
      pin,
      republished,
      physical,
      cold,
    });
  }
);
