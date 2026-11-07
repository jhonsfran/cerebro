/* oxlint-disable unicorn/no-await-expression-member -- Assertions read one field of freshly awaited durable state. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect } from "effect";

import { id } from "../../packages/contracts/src/identity.ts";
import type { TeamApprovalRequest } from "../../packages/contracts/src/team-events.ts";
import { triggerId } from "../../packages/contracts/src/triggers.ts";
import type {
  TeamCommand,
  WorkAdmission,
} from "../../packages/contracts/src/work.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { Bindings } from "../../packages/runtime/src/conversation-bindings.ts";
import { terminalNoticeIn } from "../../packages/runtime/src/coordinator-event-content.ts";
import { TeamApprovals } from "../../packages/runtime/src/coordinator-ledger.ts";
import {
  TeamApprovalRequests,
  decideTeamApproval,
} from "../../packages/runtime/src/team-approvals.ts";
import { TeamState } from "../../packages/runtime/src/team-state.ts";
import { Receipts } from "../../packages/runtime/src/trigger-receipts.ts";
import { context } from "./coordinator-fixture.ts";
import { actor, setupWeb } from "./coordinator-web-fixture.ts";
import { waitFor } from "./helpers.ts";
import { teamProvenanceFixture } from "./team-provenance-fixture.ts";

type Team = Awaited<ReturnType<typeof teamProvenanceFixture>>;
type Coordinator = Awaited<ReturnType<typeof setupWeb>>;

const post = (coordinator: Coordinator, path: string, body: unknown) =>
  coordinator.scope.handle(
    new Request(`https://session.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    actor
  );
const decide = async (
  coordinator: Coordinator,
  approvalId: string,
  decision: "allow" | "deny"
) => {
  const response = await post(coordinator, "/decide", {
    approvalId,
    decision,
  });
  return { status: response.status, body: await response.json() };
};
const teamIdle = async (team: Team) => {
  const state = await team.pi().snapshot(TeamState, context);
  assert.ok(state?.lead);
  const native = await team.pi().conversation(state.lead, context);
  await native?.waitForIdle(context);
};
const finish = async (team: Team) => {
  await teamIdle(team);
  await team.runtime().wake(team.work.deadlineAt);
  const [report] = team.reports;
  assert.ok(report, "the Team saved its report");
  return report;
};
const pendingTeamApproval = (team: Team) =>
  waitFor(
    () => team.pi().commit(() => team.runtime().approvals.all(), context),
    (approvals) => approvals.length === 1,
    10_000,
    20
  );

const connected = async (refresh = false) => {
  let team: Team | undefined;
  const coordinator = await setupWeb(true, refresh, (configuration) => ({
    ...configuration,
    checkImportedDependencies: () => Effect.void,
    importDependencies: () => {},
    ...(configuration.coordination
      ? {
          coordination: {
            ...configuration.coordination,
            decideApproval: (
              work: WorkAdmission,
              approvalId: string,
              decision: "allow" | "deny"
            ) => {
              assert.ok(team);
              return decideTeamApproval({
                pi: team.pi(),
                approvals: team.runtime().approvals,
                decision: { work, approvalId, decision },
                persist: () => Promise.resolve(),
              });
            },
          },
        }
      : {}),
  }));
  try {
    coordinator.source.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("start_team", { goal: "File the quarterly ticket." }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("The team is filing the ticket."),
      fauxAssistantMessage(
        "Team work asks to run team_write. Allow or Deny it in this chat."
      ),
    ]);
    const response = await coordinator.send(
      "start-work",
      "File the quarterly ticket."
    );
    assert.equal(response.status, 200, await response.clone().text());
    await coordinator.settled(
      await triggerId(coordinator.source.address, {
        kind: "web",
        operationId: id.operation("start-work"),
      })
    );
    await coordinator.fixture.waitDispatch();
    const start = coordinator.fixture.calls.find(
      (command): command is Extract<TeamCommand, { kind: "start" }> =>
        command.kind === "start"
    );
    assert.ok(start, "the coordinator dispatched the Team");
    const receipts: unknown[] = [];
    const created = await teamProvenanceFixture({
      work: start.work,
      sendApproval: async (request) => {
        const delivered = await post(coordinator, "/team-approval", request);
        const body: unknown = await delivered.json();
        if (!delivered.ok) {
          throw new Error(JSON.stringify(body));
        }
        receipts.push(body);
      },
    });
    team = created;
    const accepted = await created.runtime().receive(start);
    assert.equal(accepted.kind, "accepted");
    const [approval] = await pendingTeamApproval(created);
    assert.ok(approval);
    await waitFor(
      () => receipts.length,
      (count) => count === 1,
      10_000,
      20
    );
    await coordinator.drain();
    return { coordinator, team: created, start, approval, receipts };
  } catch (error) {
    await team?.close();
    await coordinator.close();
    throw error;
  }
};
const closeAll = async (subject: Awaited<ReturnType<typeof connected>>) => {
  await subject.team.close();
  await subject.coordinator.close();
};

test("a Team role offers its write tool, and calling it saves one approval and one request to send", async () => {
  const sent: TeamApprovalRequest[] = [];
  const team = await teamProvenanceFixture({
    sendApproval: (request) => {
      sent.push(request);
      return Promise.resolve();
    },
  });
  try {
    await team.runtime().receive({
      id: "start",
      kind: "start",
      work: team.work,
    });
    const [approval] = await pendingTeamApproval(team);
    assert.ok(approval);
    assert.deepEqual(
      {
        toolId: approval.toolId,
        arguments: approval.arguments,
        state: approval.state,
      },
      {
        toolId: "team_write",
        arguments: { title: "Quarterly ticket" },
        state: "pending",
      }
    );
    assert.equal(approval.expiresAt, team.work.deadlineAt);
    await waitFor(
      () => sent.length,
      (count) => count === 1,
      10_000,
      20
    );
    assert.deepEqual(sent, [
      {
        version: 2,
        kind: "approval-request",
        work: team.work,
        approval: { ...approval, workId: team.work.key.workId },
      },
    ]);
    const saved = await team
      .pi()
      .snapshot(TeamApprovalRequests, approval.approvalId, context);
    assert.ok(saved?.record, "the request is saved under its approval ID");
    assert.deepEqual(team.executions, []);
  } finally {
    await team.close();
  }
});

test("a delivered request mirrors once with its work, triggers the coordinator once, and refuses a changed payload", async () => {
  const subject = await connected();
  const { coordinator, team, start, approval } = subject;
  try {
    assert.deepEqual(subject.receipts, [
      {
        approvalId: approval.approvalId,
        key: start.work.key,
        accepted: true,
      },
    ]);
    const eventId = await triggerId(coordinator.source.address, {
      kind: "teamapproval",
      key: start.work.key,
      approvalId: approval.approvalId,
    });
    const event = await coordinator.fixture
      .pi()
      .snapshot(Receipts, eventId, context);
    assert.equal(event?.receipt?.trigger.origin.kind, "teamapproval");
    assert.match(
      event?.receipt?.trigger.text ?? "",
      /asks to run the tool team_write.*Allow or Deny it in web chat/u
    );
    const [request] = team.approvalRequests;
    assert.ok(request);
    const duplicate = await post(coordinator, "/team-approval", request);
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), subject.receipts[0]);
    const replayed = await coordinator.fixture
      .pi()
      .snapshot(Receipts, eventId, context);
    assert.equal(replayed?.receipt?.duplicates, 0);
    const changed = await post(coordinator, "/team-approval", {
      ...request,
      approval: { ...request.approval, arguments: { title: "Another ticket" } },
    });
    assert.equal(changed.status, 409);
    const snapshot = await coordinator.scope.read(actor);
    assert.deepEqual(snapshot.approvals, [
      { ...approval, workId: start.work.key.workId },
    ]);
  } finally {
    await closeAll(subject);
  }
});

test("Allow in the coordinator runs the Team's tool once and its result reaches the report", async () => {
  const subject = await connected();
  const { coordinator, team, approval } = subject;
  try {
    const allowed = await decide(coordinator, approval.approvalId, "allow");
    assert.deepEqual(allowed, {
      status: 200,
      body: {
        status: "ok",
        value: { approvalId: approval.approvalId, state: "allowed" },
      },
    });
    await waitFor(
      () => team.executions.length,
      (count) => count === 1,
      10_000,
      20
    );
    const report = await finish(team);
    assert.equal(report.kind, "completed");
    assert.ok(
      report.kind === "completed" && report.text.includes("Ticket created."),
      JSON.stringify(report)
    );
    const repeated = await decide(coordinator, approval.approvalId, "allow");
    assert.deepEqual(repeated, allowed);
    assert.deepEqual(team.executions, [{ title: "Quarterly ticket" }]);
    assert.deepEqual(
      team.audits.map((event) => ({
        name: event.name,
        approvalId: event.payload.approvalId,
        outcome: "outcome" in event.payload ? event.payload.outcome : null,
      })),
      [
        {
          name: "tool.dispatched",
          approvalId: approval.approvalId,
          outcome: null,
        },
        {
          name: "tool.settled",
          approvalId: approval.approvalId,
          outcome: "succeeded",
        },
      ]
    );
    const snapshot = await coordinator.scope.read(actor);
    assert.equal(snapshot.approvals[0]?.state, "allowed");
  } finally {
    await closeAll(subject);
  }
});

test("Deny in the coordinator stops the Team's tool before dispatch and the lead sees the denial", async () => {
  const subject = await connected();
  const { coordinator, team, approval } = subject;
  try {
    const denied = await decide(coordinator, approval.approvalId, "deny");
    assert.deepEqual(denied.body.value, {
      approvalId: approval.approvalId,
      state: "denied",
    });
    const report = await finish(team);
    assert.ok(
      report.kind === "completed" &&
        report.text.includes(
          "The tool approval was denied, cancelled, or expired."
        ),
      JSON.stringify(report)
    );
    assert.deepEqual(team.executions, []);
    assert.deepEqual(
      team.audits.map((event) => ({
        name: event.name,
        approvalId: event.payload.approvalId,
        outcome: "outcome" in event.payload ? event.payload.outcome : null,
      })),
      [
        {
          name: "tool.settled",
          approvalId: approval.approvalId,
          outcome: "denied",
        },
      ]
    );
  } finally {
    await closeAll(subject);
  }
});

test("a Team cell restart between the request and the decision still runs the tool once", async () => {
  const subject = await connected();
  const { coordinator, team, approval } = subject;
  try {
    await team.reopen();
    await pendingTeamApproval(team);
    const allowed = await decide(coordinator, approval.approvalId, "allow");
    assert.equal(allowed.body.value.state, "allowed");
    await waitFor(
      () => team.executions.length,
      (count) => count === 1,
      10_000,
      20
    );
    const report = await finish(team);
    assert.ok(
      report.kind === "completed" && report.text.includes("Ticket created."),
      JSON.stringify(report)
    );
    assert.equal(team.executions.length, 1);
    assert.equal(team.approvalRequests.length, 1);
  } finally {
    await closeAll(subject);
  }
});

test("a cancelled Team's report cancels its mirror, and a later Allow returns the Team's final state without dispatch", async () => {
  const subject = await connected();
  const { coordinator, team, start, approval } = subject;
  try {
    coordinator.source.faux.setResponses([
      fauxAssistantMessage("The team work was cancelled."),
    ]);
    await team.runtime().receive({
      id: "cancel",
      kind: "cancel",
      work: start.work,
    });
    const report = await finish(team);
    assert.equal(report.kind, "cancelled");
    const delivered = await post(coordinator, "/team-report", {
      version: 2,
      report,
      sourceEventAddress: start.work.sourceEventAddress,
    });
    assert.equal(delivered.status, 200, await delivered.clone().text());
    const mirrored = await coordinator.scope.read(actor);
    assert.equal(mirrored.approvals[0]?.state, "cancelled");
    const late = await decide(coordinator, approval.approvalId, "allow");
    assert.deepEqual(late.body.value, {
      approvalId: approval.approvalId,
      state: "cancelled",
    });
    assert.deepEqual(team.executions, []);
  } finally {
    await closeAll(subject);
  }
});

test("an expired work's terminal notice cancels its pending mirror in the same commit", async () => {
  const subject = await connected();
  const { coordinator, approval } = subject;
  try {
    coordinator.source.faux.setResponses([
      fauxAssistantMessage("The team work deadline expired."),
    ]);
    const record = await coordinator.fixture.work("a");
    await coordinator.fixture
      .pi()
      .commit(
        (tx) => terminalNoticeIn(coordinator.triggers)(tx, record, "expired"),
        context
      );
    const mirror = await coordinator.fixture
      .pi()
      .snapshot(TeamApprovals, approval.approvalId, context);
    assert.equal(mirror?.record?.state, "cancelled");
  } finally {
    await closeAll(subject);
  }
});

test("a pending Team approval does not hold the coordinator's publication gate", async () => {
  const subject = await connected(true);
  const { coordinator } = subject;
  try {
    const before = await coordinator.scope.read(actor);
    assert.equal(before.approvals[0]?.state, "pending");
    coordinator.publish({
      ...coordinator.configuration,
      agent: { ...coordinator.configuration.agent, version: 2 },
    });
    await coordinator.source.native.waitForIdle(context);
    assert.equal(await coordinator.scope.advancePublication(), "open");
    const bindings = await coordinator.fixture.pi().snapshot(Bindings, context);
    assert.equal(
      bindings?.conversations[coordinator.source.address.sessionId]
        ?.agentVersion,
      2
    );
  } finally {
    await closeAll(subject);
  }
});
