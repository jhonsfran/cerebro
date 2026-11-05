import assert from "node:assert/strict";
import type { SQLInputValue } from "node:sqlite";
import { test } from "node:test";

import { Effect, Schema } from "effect";

import {
  BotEventSchema,
  botEventId,
} from "../../packages/contracts/src/bot-events.ts";
import { Unavailable } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import { TeamReportDeliverySchema } from "../../packages/contracts/src/work.ts";
import { fauxAssistantMessage } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import type { ToolExecutionApi } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { createSourceDependencyStore } from "../../packages/runtime/src/content-dependency-store.ts";
import {
  BotEventQueue,
  BotEventReceipts,
} from "../../packages/runtime/src/coordinator-events.ts";
import { createCoordinatorHistory } from "../../packages/runtime/src/coordinator-history.ts";
import { coordinatorOperationKey } from "../../packages/runtime/src/coordinator-ledger.ts";
import {
  createCoordinatorReport,
  SourceReportReceipts,
} from "../../packages/runtime/src/coordinator-report.ts";
import { readImportedContent } from "../../packages/runtime/src/imported-content.ts";
import { context, setup } from "./coordinator-fixture.ts";

const actor = {
  actor: {
    id: id.principal("owner-A"),
    organizationId: id.organization("org-A"),
    kind: "human" as const,
    state: "active" as const,
  },
};
const reportDependencies = {
  sourceIds: [id.source("report-source")],
  toolIds: ["report-tool"],
};
const subject = async () => {
  const fixture = await setup();
  await fixture.invoke(
    "a",
    "start_team",
    { goal: "Read a private report." },
    "human-report"
  );
  await fixture.waitDispatch();
  const source = fixture.source("a");
  const record = await fixture.work("a");
  const delivery = Schema.decodeUnknownSync(TeamReportDeliverySchema)({
    version: 2,
    sourceEventAddress: source.address,
    report: {
      id: `report:${record.admission.key.workId}`,
      key: record.admission.key,
      kind: "completed",
      text: "A private report.",
      contentDependencies: reportDependencies,
    },
  });
  const metadata = <A>(change: () => A | Promise<A>) =>
    fixture.pi().commit(change, context);
  let failMirror = false;
  let failEnqueue = false;
  const platform = {
    sql: {
      exec: (query: string, ...bindings: SQLInputValue[]) => {
        if (
          failMirror &&
          query.startsWith("INSERT OR IGNORE INTO cerebro_content_tool")
        ) {
          throw new Error("Mirror tool write failed.");
        }
        const rows = fixture
          .database()
          .prepare(query)
          .all(...bindings);
        return { toArray: () => rows };
      },
    },
  };
  const storage = platform as unknown as DurableObjectStorage;
  const mirror = await metadata(() =>
    createSourceDependencyStore(storage, source.address.sessionId, metadata)
  );
  const receive = () => {
    const current = fixture.source("a");
    return createCoordinatorReport({
      pi: fixture.pi(),
      native: current.native,
      coordination: current.coordinator,
      runtime: {
        authorize: () => Promise.resolve(),
        configuration: {
          coordination: current.coordinator.services,
          provider: { model: current.faux.getModel() },
          checkImportedDependencies: () => Effect.void,
          importDependencies: mirror.importDependencies,
        },
      },
      events: {
        ...fixture.events(),
        enqueueIn: async (tx, event) => {
          const receipt = await fixture.events().enqueueIn(tx, event);
          if (failEnqueue) {
            throw new Error("Report event intent failed.");
          }
          return receipt;
        },
      },
      persist: () => Promise.resolve(),
      notify: () => Promise.resolve(),
    });
  };
  const eventId = await botEventId(source.address, {
    kind: "teamreport",
    key: delivery.report.key,
    reportId: delivery.report.id,
    outcome: delivery.report.kind,
  });
  const reportKey = await coordinatorOperationKey(
    JSON.stringify([delivery.report.key, delivery.report.id])
  );
  return {
    fixture,
    source,
    record,
    delivery,
    mirror,
    eventId,
    reportKey,
    receive: () => receive()(delivery, actor),
    failMirror: (value: boolean) => {
      failMirror = value;
    },
    failEnqueue: (value: boolean) => {
      failEnqueue = value;
    },
    state: async () => ({
      canonical: await readImportedContent(
        fixture.pi(),
        fixture.source("a").native.id
      ),
      sources: await mirror.all(),
      tools: await mirror.tools(),
      work: await fixture.work("a"),
      report: await fixture
        .pi()
        .snapshot(
          SourceReportReceipts,
          fixture.source("a").native.id,
          reportKey,
          context
        ),
      event: await fixture.pi().snapshot(BotEventReceipts, eventId, context),
    }),
  };
};
const assertRejectedReport = async (f: Awaited<ReturnType<typeof subject>>) => {
  const state = await f.state();
  assert.deepEqual(state.canonical, { sourceIds: [], toolIds: [] });
  assert.deepEqual(state.sources, []);
  assert.deepEqual(state.tools, []);
  assert.equal(state.work.reportId, null);
  assert.equal(state.work.terminalReport, null);
  assert.equal(state.work.status.kind, "accepted");
  assert.equal(state.report, undefined);
  assert.equal(state.event, undefined);
  const ledger = await f.fixture.ledger();
  assert.ok(ledger.active[state.work.admission.key.workId]);
};

test("report rollback after event task creation leaves canonical and raw provenance unchanged on the same SQLite connection", async () => {
  const f = await subject();
  try {
    f.failEnqueue(true);
    await assert.rejects(f.receive(), /Report event intent failed/u);
    await assertRejectedReport(f);
  } finally {
    await f.fixture.close();
  }
});

test("normal full-inbox report rejection leaves canonical and raw provenance unchanged", async () => {
  const f = await subject();
  const entered = Promise.withResolvers<boolean>();
  const release = Promise.withResolvers<boolean>();
  try {
    f.source.faux.setResponses([
      async () => {
        entered.resolve(true);
        await release.promise;
        return fauxAssistantMessage("Foreground completed.");
      },
    ]);
    await f.source.native.submit(
      {
        type: "input",
        content: "Hold the foreground.",
        requestId: "full-inbox-foreground",
      },
      context
    );
    await entered.promise;
    const events = await Promise.all(
      Array.from({ length: 96 }, async (_, index) => {
        const source = {
          kind: "savedtimer" as const,
          scheduleId: "capacity",
          occurrenceId: String(index),
        };
        return Schema.decodeUnknownSync(BotEventSchema)({
          version: 1,
          id: await botEventId(f.source.address, source),
          coordinator: f.source.address,
          ownerPrincipalId: actor.actor.id,
          source,
          replyTo: null,
          content: { text: "Capacity event.", reference: null },
          dependencies: { sourceIds: [], toolIds: [] },
        });
      })
    );
    await f.fixture.pi().commit(async (tx) => {
      for (const event of events) {
        // oxlint-disable-next-line no-await-in-loop -- Each saved event consumes one slot before the next capacity check.
        await f.fixture.events().enqueueIn(tx, event);
      }
    }, context);
    await assert.rejects(
      f.receive(),
      (error: unknown) => error instanceof Unavailable
    );
    await assertRejectedReport(f);
    const queue = await f.fixture.pi().snapshot(BotEventQueue, context);
    assert.equal(Object.keys(queue?.pending ?? {}).length, 96);
  } finally {
    release.resolve(true);
    await f.fixture.close();
  }
});

test("accepted report replay repairs a partial raw mirror failure after reopen without another event or native input", async () => {
  const f = await subject();
  try {
    f.failMirror(true);
    await assert.rejects(f.receive(), /Mirror tool write failed/u);
    const accepted = await f.state();
    assert.equal(accepted.work.status.kind, "completed");
    assert.equal(accepted.report?.receipt?.accepted, true);
    assert.deepEqual(accepted.canonical, reportDependencies);
    assert.deepEqual(accepted.sources, reportDependencies.sourceIds);
    assert.deepEqual(accepted.tools, []);
    assert.ok(accepted.event?.receipt);
    const eventTask = accepted.event.receipt.taskId;
    const currentDependencies =
      await f.source.coordinator.services?.contentDependencies();
    assert.ok(
      currentDependencies?.sourceIds.includes(reportDependencies.sourceIds[0])
    );
    assert.ok(currentDependencies?.toolIds.includes("report-tool"));
    f.failMirror(false);
    await f.fixture.reopen();
    const replay = await f.receive();
    assert.equal(replay.accepted, true);
    await f.fixture.pi().waitForTask(eventTask, context);
    const repaired = await f.state();
    assert.deepEqual(repaired.canonical, reportDependencies);
    assert.deepEqual(repaired.sources, reportDependencies.sourceIds);
    assert.deepEqual(repaired.tools, reportDependencies.toolIds);
    assert.equal(repaired.event?.receipt?.taskId, eventTask);
    assert.equal(
      f.fixture.eventSubmissions.filter((requestId) => requestId === f.eventId)
        .length,
      1
    );
    await f.receive();
    assert.deepEqual(await f.mirror.all(), reportDependencies.sourceIds);
    assert.deepEqual(await f.mirror.tools(), reportDependencies.toolIds);
    assert.equal(f.fixture.eventSubmissions.length, 1);
  } finally {
    await f.fixture.close();
  }
});

for (const operation of ["list", "recall"] as const) {
  test(`failed history ${operation} retention leaves canonical and raw provenance unchanged`, async () => {
    const f = await subject();
    try {
      const history = createCoordinatorHistory({
        pi: f.fixture.pi(),
        nativeId: f.source.native.id,
        binding: f.source.coordinator.binding,
        scanWorkKeys: () =>
          Promise.resolve({ keys: [f.record.admission.key.workId] }),
        contentAccess: {
          check: () => Promise.resolve(),
          retain: f.mirror.importDependencies,
        },
      });
      const api = {
        commit: async (change) =>
          await f.fixture.pi().commit(async (tx) => {
            await change(tx);
            throw new Error("History operation did not commit.");
          }, context),
      } satisfies Pick<ToolExecutionApi, "commit">;
      const read =
        operation === "list"
          ? history.list(undefined, api, context)
          : history.recall(f.record.admission.key.workId, api, context);
      await assert.rejects(read, /History operation did not commit/u);
      const state = await f.state();
      assert.deepEqual(state.canonical, { sourceIds: [], toolIds: [] });
      assert.deepEqual(state.sources, []);
      assert.deepEqual(state.tools, []);
    } finally {
      await f.fixture.close();
    }
  });
}
