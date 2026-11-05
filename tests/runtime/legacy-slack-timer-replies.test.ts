import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mock, test } from "node:test";

import { Effect, Schema } from "effect";

import type { BotEvent } from "../../packages/contracts/src/bot-events.ts";
import { Denied } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import { LegacyTimerReplyOriginSchema } from "../../packages/contracts/src/timer-events.ts";
import { TeamReportDeliverySchema } from "../../packages/contracts/src/work.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { coordinatorReportEvent } from "../../packages/runtime/src/coordinator-event-content.ts";
import { BotEventReceipts } from "../../packages/runtime/src/coordinator-event-state.ts";
import { CoordinatorReplies } from "../../packages/runtime/src/coordinator-replies.ts";
import { submitSavedTimer } from "../../packages/runtime/src/saved-timer-submit.ts";
import { legacySlackTimerBoundary as boundary } from "../support/legacy-slack-timer-boundary.ts";
import { context } from "./coordinator-fixture.ts";
import { actor, setupWeb } from "./coordinator-web-fixture.ts";
import { waitFor } from "./helpers.ts";

const boundaryUrl = new URL(
  "../support/legacy-slack-timer-boundary.ts",
  import.meta.url
).href;
const moduleFor = (body: string) =>
  `data:text/javascript,${encodeURIComponent(`import {legacySlackTimerBoundary as boundary} from ${JSON.stringify(boundaryUrl)}; ${body}`)}`;
const hooks = registerHooks({
  resolve(specifier, importContext, nextResolve) {
    if (specifier === "@cerebro/db") {
      return {
        shortCircuit: true,
        url: moduleFor(
          "export const withDatabase = async (_env, operation) => await operation(boundary.database);"
        ),
      };
    }
    if (specifier === "@cerebro/db/repositories/identity") {
      return {
        shortCircuit: true,
        url: moduleFor(
          "export const createIdentityRepository = () => boundary.identity;"
        ),
      };
    }
    try {
      return nextResolve(specifier, importContext);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ERR_MODULE_NOT_FOUND" &&
        specifier.startsWith(".")
      ) {
        return nextResolve(`${specifier}.ts`, importContext);
      }
      throw error;
    }
  },
});
const { createSlackEventReplies } =
  await import("../../apps/server/src/session/slack-event-replies.ts");
hooks.deregister();

const setupLegacy = async () => {
  const posted: { channel: string; thread_ts: string; text: string }[] = [];
  const network = mock.method(
    globalThis,
    "fetch",
    (input: string, init: RequestInit) => {
      assert.equal(input, "https://slack.invalid/api/chat.postMessage");
      assert.equal(init.method, "POST");
      assert.equal(typeof init.body, "string");
      posted.push(JSON.parse(String(init.body)));
      return Promise.resolve(
        Response.json({ ok: true, ts: `posted-${posted.length}` })
      );
    }
  );
  let replies: ReturnType<typeof createSlackEventReplies>;
  const subject = await setupWeb(true, "web", true, (configuration) => {
    replies = createSlackEventReplies(
      { DATABASE_URL: "boundary-only" },
      {
        appId: "app-old",
        agentId: configuration.address.agentId,
        workspaceId: "workspace-old",
        apiUrl: "https://slack.invalid/api",
        botToken: "offline-token",
        signingSecret: "offline-secret",
      },
      true,
      { agent: configuration.agent, owner: () => Promise.resolve(actor) }
    );
    return {
      ...configuration,
      primaryAddress: configuration.address,
      eventReplies: replies,
      contentDependencies: () =>
        Promise.resolve({ sourceIds: [id.source("source-A")], toolIds: [] }),
      checkImportedDependencies: configuration.checkDependencies,
      importDependencies: () => {},
    };
  });
  const source = {
    ...subject.source.address,
    conversationId: id.conversation("old-slack-public"),
    sessionId: id.session("old-slack-session"),
  };
  boundary.reset(source, actor.actor.id);
  const legacy = Schema.decodeUnknownSync(LegacyTimerReplyOriginSchema)({
    kind: "legacy-slack-timer",
    source,
    ownerPrincipalId: actor.actor.id,
    authority: {
      appId: "app-old",
      userId: "slack-old",
      thread: {
        workspaceId: "workspace-old",
        channelId: "D-old",
        rootTimestamp: "1800000000.000001",
      },
    },
  });
  const profile = {
    runtime: {
      authorize: () => Promise.resolve(),
      guardIn: () => Promise.resolve(),
      configuration: {
        ...subject.configuration,
        address: source,
        primaryAddress: subject.source.address,
        legacyTimerOrigin: legacy,
        eventReplies: replies,
        contentDependencies: () =>
          Promise.resolve({ sourceIds: [id.source("source-A")], toolIds: [] }),
        ownerContext: () => Effect.succeed(actor),
      },
    },
  };
  const forward = async () => {
    let event: BotEvent | undefined;
    const { events } = subject;
    await submitSavedTimer({
      pi: subject.fixture.pi(),
      nativeId: subject.fixture.source("b").native.id,
      current: () => profile,
      occurrence: {
        reminderId: "reminder:retained-slack",
        fingerprint: "original-fingerprint",
        occurrence: 1_800_000_000_000,
        instruction: "Run the old Slack instruction on the primary.",
      },
      events: {
        ...events,
        admit: async (...args) => {
          [event] = args;
          return await events.admit(...args);
        },
      },
    });
    assert.ok(event);
    return event;
  };
  const settled = async (event: BotEvent) => {
    const receipt = await subject.fixture
      .pi()
      .snapshot(BotEventReceipts, event.id, context);
    assert.ok(receipt?.receipt?.delivery.kind === "coordinator");
    await subject.fixture
      .pi()
      .waitForTask(receipt.receipt.delivery.taskId, context);
    const ready = await waitFor(
      () =>
        subject.fixture.pi().snapshot(CoordinatorReplies, event.id, context),
      (saved) => Boolean(saved?.record)
    );
    assert.ok(ready?.record);
    if (ready.record.taskId) {
      await subject.fixture.pi().waitForTask(ready.record.taskId, context);
    }
    const saved = await subject.fixture
      .pi()
      .snapshot(CoordinatorReplies, event.id, context);
    assert.ok(saved?.record);
    return saved.record;
  };
  const startTeam = async () => {
    subject.source.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("start_team", {
          goal: "Investigate this old Slack instruction privately.",
        }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage(
        "The primary started the retained timer's private team."
      ),
    ]);
    const event = await forward();
    const reply = await settled(event);
    assert.equal(reply.delivery?.state, "sent");
    await subject.fixture.waitDispatch();
    return { event, work: await subject.fixture.work("a") };
  };
  const report = async (
    work: Awaited<ReturnType<typeof subject.fixture.work>>
  ) => {
    const delivery = Schema.decodeUnknownSync(TeamReportDeliverySchema)({
      version: 2,
      sourceEventAddress: subject.source.address,
      report: {
        id: "report:legacy-timer",
        key: work.admission.key,
        kind: "completed",
        text: "The private team finished.",
        contentDependencies: { sourceIds: [], toolIds: [] },
      },
    });
    const response = await subject.scope.handle(
      new Request("https://session.internal/team-report", {
        method: "POST",
        body: JSON.stringify(delivery),
      }),
      actor
    );
    assert.equal(response.status, 200, await response.clone().text());
    return await settled(await coordinatorReportEvent(work, delivery.report));
  };
  return {
    ...subject,
    posted,
    legacy,
    replies,
    forward,
    settled,
    startTeam,
    report,
    close: async () => {
      await subject.close();
      network.mock.restore();
    },
  };
};

test("the actual primary Slack adapter and current policy deliver a forwarded legacy timer and its Team report to the exact original thread", async () => {
  const subject = await setupLegacy();
  try {
    const { event, work } = await subject.startTeam();
    assert.notEqual(
      subject.legacy.source.sessionId,
      subject.source.address.sessionId
    );
    assert.equal(work.humanOperationId, event.id);
    subject.source.faux.setResponses([
      fauxAssistantMessage(
        "The private team completed the original Slack request."
      ),
    ]);
    const reply = await subject.report(work);
    assert.equal(reply.delivery?.state, "sent");
    assert.deepEqual(reply.destination, subject.legacy);
    assert.deepEqual(subject.posted, [
      {
        channel: "D-old",
        thread_ts: "1800000000.000001",
        text: "The primary started the retained timer's private team.",
      },
      {
        channel: "D-old",
        thread_ts: "1800000000.000001",
        text: "The private team completed the original Slack request.",
      },
    ]);
    assert.ok(boundary.policyReads >= 4);
    await subject.events.admit(event, actor);
    await subject.settled(event);
    assert.equal(subject.posted.length, 2);
  } finally {
    await subject.close();
  }
});

for (const denial of ["read", "link", "content"] as const) {
  for (const kind of ["direct", "team-report"] as const) {
    test(`the actual legacy timer adapter blocks a ${kind} reply after current ${denial} revocation`, async () => {
      const subject = await setupLegacy();
      try {
        const started =
          kind === "team-report" ? await subject.startTeam() : undefined;
        const work = started?.work;
        const before = subject.posted.length;
        subject.source.faux.setResponses([
          () => {
            if (denial === "read") {
              boundary.readable = false;
            }
            if (denial === "link") {
              boundary.linked = false;
            }
            if (denial === "content") {
              subject.setContent(false);
            }
            return fauxAssistantMessage(
              "Withhold this answer after revocation."
            );
          },
        ]);
        const reply = work
          ? await subject.report(work)
          : await subject.settled(await subject.forward());
        assert.equal(reply.delivery?.state, "blocked");
        assert.equal(subject.posted.length, before);
      } finally {
        await subject.close();
      }
    });
  }
}

test("canonical legacy source authorization rejects foreign destinations and current stored row changes", async () => {
  const subject = await setupLegacy();
  try {
    const { replies } = subject;
    assert.ok(replies);
    await replies.authorize(subject.legacy);
    await Promise.all(
      [
        {
          ...subject.legacy,
          source: {
            ...subject.legacy.source,
            conversationId: id.conversation("foreign-conversation"),
          },
        },
        {
          ...subject.legacy,
          source: {
            ...subject.legacy.source,
            sessionId: id.session("foreign-session"),
          },
        },
        {
          ...subject.legacy,
          source: {
            ...subject.legacy.source,
            agentId: id.agent("foreign-agent"),
          },
        },
        {
          ...subject.legacy,
          source: {
            ...subject.legacy.source,
            organizationId: id.organization("foreign-org"),
          },
        },
        { ...subject.legacy, ownerPrincipalId: id.principal("foreign-owner") },
        {
          ...subject.legacy,
          authority: { ...subject.legacy.authority, appId: "foreign-app" },
        },
        {
          ...subject.legacy,
          authority: { ...subject.legacy.authority, userId: "foreign-user" },
        },
        {
          ...subject.legacy,
          authority: {
            ...subject.legacy.authority,
            thread: {
              ...subject.legacy.authority.thread,
              rootTimestamp: "1800000001.000001",
            },
          },
        },
      ].map((destination) =>
        assert.rejects(replies.authorize(destination), Denied)
      )
    );
    assert.ok(boundary.row);
    const original = { ...boundary.row };
    boundary.row.agentId = "foreign-agent";
    await assert.rejects(
      replies.authorize({
        ...subject.legacy,
        source: {
          ...subject.legacy.source,
          agentId: id.agent("foreign-agent"),
        },
      }),
      Denied
    );
    boundary.row = { ...original, ownerPrincipalId: "foreign-owner" };
    await assert.rejects(
      replies.authorize({
        ...subject.legacy,
        ownerPrincipalId: id.principal("foreign-owner"),
      }),
      Denied
    );
    boundary.row = { ...original, organizationId: "foreign-org" };
    await assert.rejects(
      replies.authorize({
        ...subject.legacy,
        source: {
          ...subject.legacy.source,
          organizationId: id.organization("foreign-org"),
        },
      }),
      Denied
    );
    boundary.row = { ...original, engine: "foreign-engine" };
    await assert.rejects(replies.authorize(subject.legacy), Denied);
    boundary.row = { ...original };
    boundary.row.retiredAt = new Date();
    await assert.rejects(replies.authorize(subject.legacy), Denied);
    assert.equal(subject.posted.length, 0);
  } finally {
    await subject.close();
  }
});
