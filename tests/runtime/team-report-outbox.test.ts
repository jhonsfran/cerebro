import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Schema } from "effect";

import {
  TeamReportDeliverySchema,
  WorkReportSchema,
} from "../../packages/contracts/src/work.ts";
import type { TeamReportDelivery } from "../../packages/contracts/src/work.ts";
import {
  createModels,
  fauxAssistantMessage,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  Harness,
  createRegistry,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { openNodeSqliteStorage } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js";
import { piContext } from "../../packages/runtime/src/pi-harness.ts";
import { createTeamCompletion } from "../../packages/runtime/src/team-completion.ts";
import {
  TeamReportOutbox,
  createTeamReportOutbox,
} from "../../packages/runtime/src/team-report-outbox.ts";
import { TeamState } from "../../packages/runtime/src/team-state.ts";
import { setup } from "./coordinator-fixture.ts";
import { waitFor } from "./helpers.ts";

const context = piContext();
test("terminal report and outbox commit together, and an uncertain send retries the same payload after reopen", async () => {
  const source = await setup();
  const directory = await mkdtemp(path.join(tmpdir(), "team-outbox-"));
  try {
    await source.invoke("a", "start_team", { goal: "Read." }, "human");
    const record = await source.work("a");
    const work = record.admission;
    const report = Schema.decodeUnknownSync(WorkReportSchema)({
      id: `report:${work.key.workId}`,
      key: work.key,
      kind: "completed",
      text: "Private completed result.",
      contentDependencies: { sourceIds: ["source-A"], toolIds: [] },
    });
    const calls: TeamReportDelivery[] = [];
    const progress: Promise<unknown>[] = [];
    let unavailable = true;
    let invalid = true;
    const open = async () => {
      const models = createModels();
      const registry = createRegistry();
      const pi = await Harness.open(
        await openNodeSqliteStorage(path.join(directory, "state.sqlite")),
        { models, registry, settings: { extensions: [] } },
        context
      );
      const root = await pi.root(context);
      const outbox = createTeamReportOutbox({
        pi,
        registry,
        nativeId: root.id,
        persist: () => Promise.resolve(),
        waitUntil: (promise) => {
          const settled = async () => {
            try {
              return await promise;
            } catch (error) {
              return error;
            }
          };
          progress.push(settled());
        },
        transport: {
          prepare: (value) => {
            if (invalid) {
              throw new Error("Preparation failed.");
            }
            return Schema.decodeUnknownSync(TeamReportDeliverySchema)({
              report: value,
              sourceEventAddress: work.sourceEventAddress,
              sourceSlackThread: work.sourceSlackThread,
            });
          },
          send: (delivery) => {
            calls.push(structuredClone(delivery));
            if (unavailable) {
              throw new Error("Queue accepted but its response was lost.");
            }
            return Promise.resolve();
          },
        },
      });
      return { pi, outbox, root, models };
    };
    let host = await open();
    try {
      const save = () =>
        host.pi.commit(async (tx) => {
          const state = await tx.doc(TeamState);
          state.admission = work;
          state.phase = "completed";
          state.report = report;
          await host.outbox.enqueueIn(tx, report);
        }, context);
      await assert.rejects(save(), /Preparation failed/u);
      assert.equal(await host.pi.snapshot(TeamState, context), undefined);
      assert.equal(
        await host.pi.snapshot(TeamReportOutbox, context),
        undefined
      );
      invalid = false;
      await save();
      const saved = await host.pi.snapshot(TeamReportOutbox, context);
      assert.ok(saved?.taskId);
      const originalTaskId = saved.taskId;
      assert.equal(calls.length, 0);
      await host.outbox.wake();
      await waitFor(
        () => host.pi.getTask(originalTaskId, context),
        (task) =>
          task?.state.status === "running" &&
          task.state.checkpoint.phase === "retry"
      );
      await host.pi.close(context);
      await Promise.all(progress);
      unavailable = false;
      host = await open();
      await host.outbox.wake();
      await host.pi.waitForTask(originalTaskId, context);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0], calls[1]);
      const terminal = await host.pi.snapshot(TeamState, context);
      assert.deepEqual(terminal?.report, report);
      await host.pi.commit((tx) => host.outbox.enqueueIn(tx, report), context);
      await host.outbox.wake();
      assert.equal(calls.length, 2);
    } finally {
      await host.pi.close(context);
    }
  } finally {
    await source.close();
    await rm(directory, { recursive: true });
  }
});

test("a whitespace-only lead answer creates a constant failure report instead of an empty completed reply", async () => {
  const source = await setup();
  try {
    await source.invoke("a", "start_team", { goal: "Read." }, "human");
    const record = await source.work("a");
    const pi = source.pi();
    const lead = source.source("b");
    lead.faux.setResponses([fauxAssistantMessage(" \n\t ")]);
    const input = await lead.native.submit(
      { type: "input", content: "Read.", requestId: "lead-input" },
      context
    );
    await input.wait(context);
    await pi.commit(async (tx) => {
      const state = await tx.doc(TeamState);
      state.admission = record.admission;
      state.phase = "running";
      state.lead = lead.native.id;
      state.requests = ["lead-input"];
    }, context);
    const wake = createTeamCompletion({
      pi,
      work: record.admission,
      now: Date.now,
      roles: [],
      abort: () => Promise.resolve(),
      holdAdmissions: () => Promise.resolve(),
    });
    await wake(record.admission.deadlineAt);
    const state = await pi.snapshot(TeamState, context);
    assert.equal(state?.phase, "failed");
    assert.equal(state?.report?.kind, "failed");
  } finally {
    await source.close();
  }
});
