import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LifecycleJob, LifecycleJobs } from "agents/lifecycle";
import { Schema } from "effect";

import { Denied } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import {
  CoordinationProfileSchema,
  SlackThreadSchema,
  WorkReportSchema,
} from "../../packages/contracts/src/work.ts";
import type { TeamCommand } from "../../packages/contracts/src/work.ts";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  Harness,
  createRegistry,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import type { ConversationId } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { openNodeSqliteStorage } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js";
import {
  WorkDocuments,
  WorkLedger,
  applyCoordinatorReport,
} from "../../packages/runtime/src/coordinator-ledger.ts";
import type { CoordinatorWorkRecord } from "../../packages/runtime/src/coordinator-ledger.ts";
import { createCoordinatorWork } from "../../packages/runtime/src/coordinator-work.ts";
import {
  chatPresentation,
  piContext,
} from "../../packages/runtime/src/pi-harness.ts";

export const context = piContext();
const fakeJobs = () => {
  const rows = new Map<string, LifecycleJob>();
  const jobs: LifecycleJobs = {
    cancel: (name) => Promise.resolve(rows.delete(name)),
    get: (name) => rows.get(name),
    list: () => [...rows.values()],
    push: (value) => {
      assert.ok(value.id);
      const row: LifecycleJob = {
        capability: "host",
        createdAt: 0,
        exclusive: value.exclusive ?? false,
        fn: value.fn,
        id: value.id,
        payload: structuredClone(value.payload),
        recoveryLoop: value.recoveryLoop ?? false,
        retry: value.retry,
        singleflight: value.singleflight ?? false,
        time: value.time,
      };
      rows.set(row.id, row);
      return Promise.resolve(row);
    },
    rearm: () => Promise.resolve(),
    reschedule: (name, time) => {
      const previous = rows.get(name);
      if (!previous) {
        return Promise.resolve(false);
      }
      rows.set(name, { ...previous, time });
      return Promise.resolve(true);
    },
  };
  return { jobs, rows };
};

export const setup = async (timeoutMs = 600_000) => {
  const directory = await mkdtemp(path.join(tmpdir(), "cerebro-coordinator-"));
  const databasePath = path.join(directory, "state.sqlite");
  const queued = fakeJobs();
  const nativeIds = new Map<string, ConversationId>();
  const calls: TeamCommand[] = [];
  const delivered: TeamCommand[] = [];
  const progress: Promise<unknown>[] = [];
  let pinVersion = 1;
  let clock = Date.now();
  let failures = 0;
  let dependencies = {
    sourceIds: [id.source("source-A")],
    toolIds: ["tool-A"],
  };
  let held: ReturnType<typeof Promise.withResolvers<boolean>> | undefined;
  const allowed = new Map([
    ["a", true],
    ["b", true],
    ["c", true],
  ]);
  const ownerPrincipalId = id.principal("owner-A");
  const profile = Schema.decodeUnknownSync(CoordinationProfileSchema)({
    leadAgentId: "lead-A",
    timeoutMs,
    workerAgentId: "worker-A",
  });
  const sourceBindings = ["a", "b", "c"].map((name, index) => ({
    name,
    address: {
      organizationId: id.organization("org-A"),
      agentId: id.agent("coordinator-A"),
      conversationId: id.conversation(`public-${name}`),
      sessionId: id.session(`source-${name}`),
    },
    thread: Schema.decodeUnknownSync(SlackThreadSchema)({
      channelId: `D-${name}`,
      workspaceId: "T-A",
      rootTimestamp: `180000000${index}.000001`,
    }),
    ownerPrincipalId,
  }));
  const open = async () => {
    const storage = await openNodeSqliteStorage(databasePath);
    const models = createModels();
    const registry = createRegistry();
    const pi = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: {
          extensions: [],
          compaction: { enabled: false },
          retry: { enabled: false },
        },
      },
      context
    );
    const scopes = await Promise.all(
      sourceBindings.map(async (source) => {
        const savedId = nativeIds.get(source.name);
        const native = savedId
          ? await pi.conversation(savedId, context)
          : await pi.createConversation(
              { ownership: { kind: "ownerless" } },
              context
            );
        assert.ok(native);
        nativeIds.set(source.name, native.id);
        const faux = fauxProvider({
          provider: `coordinator-${source.name}`,
          models: [{ id: "test" }],
        });
        models.setProvider(faux.provider);
        const coordinator = createCoordinatorWork({
          address: source.address,
          nativeId: native.id,
          authorize: () =>
            allowed.get(source.name)
              ? Promise.resolve()
              : Promise.reject(
                  new Denied({
                    code: "revoked",
                    reason: "Source access was revoked.",
                  })
                ),
          jobs: queued.jobs,
          metadata: (operation) => pi.commit(operation, context),
          persist: () => Promise.resolve(),
          waitUntil: (promise) => {
            progress.push(promise.catch((error: unknown) => error));
          },
          now: () => clock,
          pi,
          services: {
            contentDependencies: () =>
              Promise.resolve(structuredClone(dependencies)),
            ownerPrincipalId,
            profile,
            thread: source.thread,
            resolveRolePins: () =>
              Promise.resolve({
                lead: {
                  agentId: profile.leadAgentId,
                  agentVersion: pinVersion,
                },
                worker: {
                  agentId: profile.workerAgentId,
                  agentVersion: pinVersion,
                },
              }),
            sendCommand: async (command) => {
              calls.push(structuredClone(command));
              if (failures > 0) {
                failures -= 1;
                throw new Error("Queue unavailable");
              }
              if (held) {
                await held.promise;
              }
              delivered.push(structuredClone(command));
            },
          },
        });
        const extension = {
          name: `source-${source.name}`,
          tasks: coordinator.tasks,
          tools: coordinator.tools,
        };
        registry.install(extension);
        const model = faux.getModel();
        await native.configure(
          {
            extensions: [extension],
            model: { modelId: model.id, provider: model.provider },
          },
          context
        );
        await coordinator.restore();
        return { ...source, native, coordinator, faux };
      })
    );
    return { pi, registry, scopes, storage };
  };
  let host = await open();
  const source = (name: string) => {
    const value = host.scopes.find((item) => item.name === name);
    assert.ok(value);
    return value;
  };
  const ledger = async () => {
    const value = await host.pi.snapshot(WorkLedger, context);
    assert.ok(value);
    const page = await host.storage.scanDocuments(
      {
        scope: { kind: "session" },
        at: "current",
        kind: WorkDocuments.definition.kind,
      },
      256,
      undefined,
      context
    );
    const documents = await Promise.all(
      page.items.map(async (entry) =>
        entry.key
          ? await host.pi.snapshot(WorkDocuments, entry.key, context)
          : undefined
      )
    );
    const pairs = documents.flatMap(
      (document): [string, CoordinatorWorkRecord][] =>
        document?.record
          ? [[document.record.admission.key.workId, document.record]]
          : []
    );
    return { ...value, works: Object.fromEntries(pairs) };
  };

  const work = async (name: string) => {
    const value = await ledger();
    const record = Object.values(value.works).findLast(
      (item) =>
        item.admission.sourceEventAddress.sessionId ===
        source(name).address.sessionId
    );
    assert.ok(record);
    return record;
  };
  const waitDispatch = async () => {
    const value = await ledger();
    await Promise.all(
      Object.values(value.works).flatMap((record) =>
        Object.values(record.pendingCommands).map(({ taskId }) =>
          host.pi.waitForTask(taskId, context)
        )
      )
    );
  };
  return {
    source,
    ledger,
    work,
    calls,
    delivered,
    jobs: queued.rows,
    waitDispatch,
    pi: () => host.pi,
    now: () => clock,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    fail: (count: number) => {
      failures = count;
    },
    setPinVersion: (version: number) => {
      pinVersion = version;
    },
    setDependencies: (value: typeof dependencies) => {
      dependencies = value;
    },
    revoke: (name: string) => {
      allowed.set(name, false);
    },
    hold: () => {
      held = Promise.withResolvers<boolean>();
    },
    release: () => {
      held?.resolve(true);
      held = undefined;
    },
    invoke: async (
      name: string,
      tool: string,
      args: Record<string, unknown>,
      requestId: string,
      human = true,
      count = 1
    ) => {
      const current = source(name);
      current.faux.setResponses([
        fauxAssistantMessage(
          Array.from({ length: count }, (_, index) =>
            fauxToolCall(tool, args, { id: `${requestId}-${index}` })
          ),
          { stopReason: "toolUse" }
        ),
        fauxAssistantMessage("The command was handled."),
      ]);
      if (human) {
        await current.coordinator.rememberHumanOperation(requestId);
      }
      const submission = await current.native.submit(
        { type: "input", content: requestId, requestId },
        context
      );
      const settled = await submission.wait(context);
      const watch = await current.native.watch(context);
      try {
        return { settled, snapshot: chatPresentation(watch.value) };
      } finally {
        await watch.stop();
      }
    },
    report: async (
      name: string,
      reportId: string,
      admit?: (
        tx: Parameters<typeof applyCoordinatorReport>[0]
      ) => Promise<void>
    ) => {
      const record = await work(name);
      const report = Schema.decodeUnknownSync(WorkReportSchema)({
        kind: "completed",
        id: reportId,
        key: record.admission.key,
        contentDependencies: { sourceIds: [], toolIds: [] },
        text: "Team result.",
      });
      return await host.pi.commit(
        (tx) =>
          applyCoordinatorReport(
            tx,
            source(name),
            report,
            admit ?? (() => Promise.resolve()),
            clock
          ),
        context
      );
    },
    reopen: async () => {
      await host.pi.close(context);
      host = await open();
    },
    close: async () => {
      held?.resolve(true);
      await host.pi.close(context);
      await Promise.all(progress);
      await rm(directory, { recursive: true });
    },
  };
};
