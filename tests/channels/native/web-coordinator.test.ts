/* oxlint-disable unicorn/no-await-expression-member -- Native frame reads, controls, and crash checkpoints require ordered effects. */
import assert from "node:assert/strict";
import { before as beforeAll, test } from "node:test";

import { Schema } from "effect";
import { z } from "zod";

import { TeamReportDeliverySchema } from "../../../packages/contracts/src/work.ts";
import { waitForFixture } from "../../slice-1/application.ts";
import {
  boot,
  completedCalls,
  controlReportQueue,
  queue,
  queueBodies,
  compose,
  drained,
  docker,
  evidence,
  fixture,
  literal,
  metadata,
  observed,
  ready,
  summary,
  wireModels,
} from "./team-support.ts";
import {
  setupWebTeam,
  conversationSchema,
  viewSchema,
  receiptSchema,
  marker,
  coordinatorTools,
  roles,
  noSlack,
  createConversation,
  read,
  sendMessage,
  heldAcceptance,
  matchingReport,
  waitReport,
} from "./web-team-support.ts";

beforeAll(setupWebTeam, { timeout: 180_000 });

test(
  "a profile-free web conversation remains ordinary chat without background state or team tools",
  { timeout: 180_000 },
  async () => {
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
    try {
      await noSlack();
      const { conversation, route } = await createConversation();
      const before = await observed();
      await sendMessage(route, {
        operationId: crypto.randomUUID(),
        text: marker,
      });
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
          value.snapshot.messages.some((entry) => entry.role === "assistant")
      );
      assert.equal(view.snapshot.activity?.backgroundWork, undefined);
      assert.equal(
        view.snapshot.tools.some((tool) =>
          coordinatorTools.includes(tool.toolName)
        ),
        false
      );
      assert.ok(
        coordinatorTools.every(
          (tool) => !completed.model.at(-1)?.toolNames.includes(tool)
        )
      );
      assert.equal(completed.slack.calls.length, 0);
      await evidence("web-team-native-profile-absent", {
        conversation,
        before,
        completed,
        view,
      });
    } finally {
      await compose(
        "run",
        "--no-deps",
        "--rm",
        "test-config",
        "node",
        "--input-type=module",
        "-e",
        "import {readFile,writeFile} from 'node:fs/promises'; const p='/run/cerebro-secrets/runtime.json'; const c=JSON.parse(await readFile(p,'utf8')); c.coordination=JSON.parse(process.argv[1]); await writeFile(p,JSON.stringify(c),{mode:0o600});",
        JSON.stringify({
          leadAgentId: roles().lead.agentId,
          workerAgentId: roles().worker.agentId,
        })
      );
      await compose("run", "--no-deps", "--rm", "bootstrap");
      await compose("restart", "celld");
      await ready();
    }
  }
);

test(
  "no-Slack web input starts private roles and imports one canonical result before the first product read",
  { timeout: 150_000 },
  async () => {
    await controlReportQueue("pause");
    try {
      const sourceConfiguration = await noSlack();
      const conversation = await fixture.json(
        "/api/product/conversations",
        metadata.owner.cookie,
        conversationSchema,
        {
          agentId: roles().coordinator.agentId,
          operationId: crypto.randomUUID(),
        }
      );
      const route = `/api/product/conversations/${encodeURIComponent(conversation.conversationId)}`;
      const input = {
        operationId: crypto.randomUUID(),
        text: "SLACK_TEAM_FIXTURE run both worker checks.",
      };
      const before = await observed();
      const receipt = await fixture.json(
        `${route}/messages`,
        metadata.owner.cookie,
        receiptSchema,
        input
      );
      assert.equal(receipt.receipt.accepted, true);
      assert.equal(receipt.receipt.operationId, input.operationId);
      assert.ok(receipt.receipt.session);
      await fixture.json(
        `${route}/messages`,
        metadata.owner.cookie,
        receiptSchema,
        input
      );
      const completed = await waitForFixture(
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
      const externalCompletionAt = Date.now();
      const waiting = await waitForFixture(
        () => queue("peek", "cerebro-team-reports", 10),
        (value) =>
          queueBodies(value).some((body) => {
            const delivery = Schema.decodeUnknownSync(
              TeamReportDeliverySchema,
              { onExcessProperty: "error" }
            )(body);
            return (
              delivery.sourceEventAddress.conversationId ===
              conversation.conversationId
            );
          }),
        30_000
      );
      const queuedReport = queueBodies(waiting)
        .map((body) =>
          Schema.decodeUnknownSync(TeamReportDeliverySchema, {
            onExcessProperty: "error",
          })(body)
        )
        .find(
          (delivery) =>
            delivery.sourceEventAddress.conversationId ===
            conversation.conversationId
        );
      assert.ok(queuedReport && "version" in queuedReport);
      assert.equal(queuedReport.version, 2);
      assert.equal("sourceSlackThread" in queuedReport, false);
      await controlReportQueue("resume");
      const reportQueue = await drained("cerebro-team-reports");
      const firstConversationReadAt = Date.now();
      const view = await fixture.json(route, metadata.owner.cookie, viewSchema);
      assert.equal(
        view.snapshot.activity?.backgroundWork?.status.kind,
        "completed"
      );
      assert.equal(view.agentId, roles().coordinator.agentId);
      assert.equal(view.conversationId, conversation.conversationId);
      assert.equal(view.sessionId, conversation.sessionId);
      assert.deepEqual(view.snapshot.address, {
        ...conversation,
        organizationId: metadata.agent.organizationId,
      });
      const starts = view.snapshot.tools.filter(
        (tool) => tool.toolName === "start_team"
      );
      assert.equal(starts.length, 1);
      assert.equal(starts[0]?.state, "succeeded");
      const startedWork = z
        .object({
          workId: z.string(),
          status: z.object({ kind: z.literal("accepted") }),
          deadlineAt: z.number(),
        })
        .parse(JSON.parse(starts[0]?.output ?? "null"));
      assert.equal(
        view.snapshot.messages.filter(
          (message) => message.role === "user" && message.text === input.text
        ).length,
        1
      );
      assert.equal(
        view.snapshot.messages.filter(
          (message) => message.role === "assistant" && message.text === summary
        ).length,
        1
      );
      const calls = completed.model.slice(before.model.length);
      for (const call of calls) {
        assert.ok(
          call.completedAt !== undefined &&
            call.completedAt <= externalCompletionAt &&
            externalCompletionAt <= firstConversationReadAt
        );
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
        }
      }
      assert.equal(completed.slack.calls.length, 0);
      const publicRoles = await fixture.sql(
        `SELECT count(*) FROM channel_conversation WHERE agent_id IN (${literal(roles().lead.agentId)},${literal(roles().worker.agentId)})`
      );
      assert.equal(publicRoles, "0");
      const source = await fixture.sql(
        `SELECT json_build_object('kind',kind,'organizationId',organization_id,'ownerPrincipalId',owner_principal_id,'agentId',agent_id,'conversationId',conversation_id,'sessionId',session_id,'workspaceId',workspace_id,'channelId',channel_id,'rootTimestamp',root_timestamp) FROM channel_conversation WHERE conversation_id=${literal(conversation.conversationId)}`
      );
      assert.deepEqual(JSON.parse(source), {
        kind: "web",
        organizationId: metadata.agent.organizationId,
        ownerPrincipalId: metadata.agent.principalId,
        ...conversation,
        workspaceId: null,
        channelId: null,
        rootTimestamp: null,
      });
      await fixture.json(
        `${route}/messages`,
        metadata.owner.cookie,
        receiptSchema,
        input
      );
      const replay = await observed();
      assert.equal(replay.model.length, completed.model.length);
      const reloaded = await fixture.json(
        route,
        metadata.owner.cookie,
        viewSchema
      );
      const repeated = await fixture.json(
        route,
        metadata.owner.cookie,
        viewSchema
      );
      assert.deepEqual(reloaded, view);
      assert.deepEqual(repeated, view);
      const retainedConfiguration = await noSlack();
      await evidence("web-team-native-complete", {
        boot: {
          fixtureId: boot.fixtureId,
          sha: boot.sha,
          apiUrl: boot.apiUrl,
          webUrl: boot.webUrl,
        },
        roles: roles(),
        conversation,
        input,
        sourceConfiguration,
        retainedConfiguration,
        publicRoles,
        startedWork,
        receipt,
        before,
        completed,
        externalCompletionAt,
        waiting,
        queuedReport,
        reportQueue,
        firstConversationReadAt,
        view,
        replay,
        reloaded,
        repeated,
      });
    } finally {
      await controlReportQueue("resume");
    }
  }
);

test(
  "a no-reader SIGKILL recovers private web work on the same volume and delivers its report before the first read",
  { timeout: 180_000 },
  async () => {
    await noSlack();
    await controlReportQueue("pause");
    await fixture.controls({
      models: { [wireModels.lead]: { hold: true, delayMs: 0 } },
    });
    try {
      const { conversation, route } = await createConversation();
      const input = { operationId: crypto.randomUUID(), text: marker };
      const before = await observed();
      await sendMessage(route, input);
      const held = await heldAcceptance(before);
      const celld = await fixture.container("celld");
      const identity = z
        .array(
          z.object({
            Id: z.string(),
            Config: z.object({ Labels: z.record(z.string(), z.string()) }),
            Mounts: z.array(
              z.object({ Source: z.string(), Destination: z.string() })
            ),
          })
        )
        .parse(JSON.parse((await docker("inspect", celld)).stdout));
      const killedAt = Date.now();
      await docker("kill", "--signal", "KILL", celld);
      await compose("up", "--no-deps", "-d", "--wait", "celld");
      await ready();
      assert.equal(await fixture.container("celld"), celld);
      await fixture.controls({ models: {}, release: true });
      const completed = await waitForFixture(
        observed,
        (value) =>
          completedCalls(value, wireModels.lead).length >=
            completedCalls(before, wireModels.lead).length + 2 &&
          completedCalls(value, wireModels.worker).length ===
            completedCalls(before, wireModels.worker).length + 2,
        90_000
      );
      const externalCompletionAt = Date.now();
      const waiting = await waitReport(
        "cerebro-team-reports",
        conversation.conversationId
      );
      const report = matchingReport(waiting, conversation.conversationId);
      assert.equal(report?.report.kind, "completed");
      await controlReportQueue("resume");
      const reportQueue = await drained("cerebro-team-reports");
      const firstConversationReadAt = Date.now();
      assert.ok(
        killedAt < externalCompletionAt &&
          externalCompletionAt <= firstConversationReadAt
      );
      const view = await read(route);
      assert.equal(
        view.snapshot.tools.filter((tool) => tool.toolName === "start_team")
          .length,
        1
      );
      assert.equal(
        view.snapshot.messages.filter(
          (entry) => entry.text === marker && entry.role === "user"
        ).length,
        1
      );
      assert.equal(
        view.snapshot.messages.filter(
          (entry) => entry.text === summary && entry.role === "assistant"
        ).length,
        1
      );
      assert.equal(
        view.snapshot.activity?.backgroundWork?.status.kind,
        "completed"
      );
      const attempts = completed.model.slice(before.model.length);
      assert.equal(
        attempts.filter((call) => call.model === wireModels.coordinator).length,
        2
      );
      assert.ok(
        attempts.filter((call) => call.model !== wireModels.coordinator)
          .length <= 8
      );
      assert.ok(
        attempts.every(
          (call) =>
            call.completedAt === undefined ||
            call.completedAt <= externalCompletionAt
        )
      );
      assert.equal(completed.slack.calls.length, 0);
      await sendMessage(route, input);
      assert.deepEqual(await read(route), view);
      assert.deepEqual(await read(route), view);
      const replay = await observed();
      assert.equal(replay.model.length, completed.model.length);
      await evidence("web-team-native-recovery", {
        conversation,
        input,
        before,
        held,
        celld,
        identity,
        killedAt,
        externalCompletionAt,
        completed,
        waiting,
        report,
        reportQueue,
        firstConversationReadAt,
        view,
        replay,
      });
    } finally {
      await fixture.controls({ models: {}, release: true });
      await controlReportQueue("resume");
    }
  }
);
