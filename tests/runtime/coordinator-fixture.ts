import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { LifecycleJob, LifecycleJobs } from "agents/lifecycle";
import { Schema } from "effect";

import type { BotEvent } from "../../packages/contracts/src/bot-events.ts";
import { Denied } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import { normalizeTeamCommand } from "../../packages/contracts/src/team-events.ts";
import type { TeamCommandTransport } from "../../packages/contracts/src/team-events.ts";
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
import type {
  Conversation,
  ConversationId,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { NodeSqliteDatabase } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js";
import { SqliteStorage } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/storage.js";
import { terminalNoticeIn } from "../../packages/runtime/src/coordinator-event-content.ts";
import {
  createCoordinatorEvents,
  BotEventReceipts,
} from "../../packages/runtime/src/coordinator-events.ts";
import type {
  CoordinatorEvents,
  BotEventScope,
} from "../../packages/runtime/src/coordinator-events.ts";
import {
  WorkDocuments,
  WorkLedger,
  applyCoordinatorReport,
} from "../../packages/runtime/src/coordinator-ledger.ts";
import type { CoordinatorWorkRecord } from "../../packages/runtime/src/coordinator-ledger.ts";
import { createCoordinatorSubscriptions } from "../../packages/runtime/src/coordinator-subscriptions.ts";
import { createCoordinatorWork } from "../../packages/runtime/src/coordinator-work.ts";
import { readImportedContent } from "../../packages/runtime/src/imported-content.ts";
import {
  chatPresentation,
  piContext,
} from "../../packages/runtime/src/pi-harness.ts";

const settleProgress = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    return await promise;
  } catch (error) {
    return error;
  }
};

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

export const setup = async (timeoutMs = 600_000, notices = false) => {
  const directory = await mkdtemp(path.join(tmpdir(), "cerebro-coordinator-"));
  const databasePath = path.join(directory, "state.sqlite");
  const queued = fakeJobs();
  const nativeIds = new Map<string, ConversationId>();
  const calls: TeamCommand[] = [];
  const delivered: TeamCommand[] = [];
  const transports: TeamCommandTransport[] = [];
  let localControl: BotEventScope["prepareLocalControl"];
  const progress: Promise<unknown>[] = [];
  let pinVersion = 1;
  let clock = Date.now();
  let failures = 0;
  let dispatchDenied = false;
  const eventSubmissions: string[] = [];
  let submitPause: "before" | "after" | undefined;
  let submitEntered = Promise.withResolvers<boolean>();
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
  const revokedContent = new Set<string>();
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
      agentId: id.agent(`coordinator-${name.toUpperCase()}`),
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
    const database = new DatabaseSync(databasePath, { timeout: 5000 });
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
    const storage = await SqliteStorage.open(new NodeSqliteDatabase(database));
    const models = createModels();
    const registry = createRegistry();
    const pi = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: {
          extensions: [],
          followUpMode: "one-at-a-time",
          compaction: { enabled: false },
          retry: { enabled: false },
        },
      },
      context
    );
    const scopeSources = new Map<
      string,
      {
        name: string;
        native: Conversation;
        coordinator: ReturnType<typeof createCoordinatorWork>;
        subscriptions: ReturnType<typeof createCoordinatorSubscriptions>;
      }
    >();
    const events: CoordinatorEvents = createCoordinatorEvents({
      pi,
      targetIn: (_tx, address) => {
        const source = sourceBindings.find(
          (item) => item.address.sessionId === address.sessionId
        );
        const nativeId = source && nativeIds.get(source.name);
        assert.ok(nativeId);
        return Promise.resolve({ nativeId, agentVersion: pinVersion });
      },
      resolve: (address): Promise<BotEventScope> => {
        const current = scopeSources.get(address.sessionId);
        assert.ok(current);
        const native = new Proxy(current.native, {
          get: (target, property) => {
            if (property === "submit") {
              return async (
                input: Parameters<typeof target.submit>[0],
                invocation: Parameters<typeof target.submit>[1]
              ) => {
                const pause = async () => {
                  submitEntered.resolve(true);
                  const stopped = Promise.withResolvers<never>();
                  invocation.abortSignal?.addEventListener(
                    "abort",
                    () => stopped.reject(new Error("Fixture process stopped.")),
                    { once: true }
                  );
                  await stopped.promise;
                };
                if (submitPause === "before") {
                  await pause();
                }
                eventSubmissions.push(input.requestId ?? "");
                const submission = await target.submit(input, invocation);
                if (submitPause === "after") {
                  await pause();
                }
                return submission;
              };
            }
            const value: unknown = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const authorize = (event: BotEvent) =>
          allowed.get(current.name) &&
          !event.dependencies.sourceIds.some((sourceId) =>
            revokedContent.has(sourceId)
          )
            ? Promise.resolve()
            : Promise.reject(
                new Denied({
                  code: "revoked",
                  reason: "Event content revoked.",
                })
              );
        return Promise.resolve({
          native,
          agentVersion: pinVersion,
          ownerPrincipalId,
          admissions: current.coordinator.admissions,
          prepareRoute: current.subscriptions.prepare,
          prepareLocalControl: localControl,
          routingAccess: (_context, content) =>
            allowed.get(current.name) &&
            !content.sourceIds.some((sourceId) => revokedContent.has(sourceId))
              ? Promise.resolve()
              : Promise.reject(
                  new Denied({
                    code: "revoked",
                    reason: "Subscribed source revoked.",
                  })
                ),
          authorize,
          readAccess: () =>
            allowed.get(current.name)
              ? Promise.resolve()
              : Promise.reject(
                  new Denied({ code: "revoked", reason: "Source revoked." })
                ),
        });
      },
      scan: (cursor) =>
        pi.commit(async () => {
          const page = await storage.scanDocuments(
            {
              scope: { kind: "session" },
              at: "current",
              kind: BotEventReceipts.definition.kind,
            },
            32,
            cursor,
            context
          );
          return {
            keys: page.items.flatMap((item) => (item.key ? [item.key] : [])),
            ...(page.next ? { next: page.next } : {}),
          };
        }, context),
      waitUntil: (promise) => {
        progress.push(settleProgress(promise));
      },
    });
    registry.install({
      name: "fixture.bot-events",
      tasks: [events.definition],
    });
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
        faux.setResponses([fauxAssistantMessage("Coordinator result.")]);
        const coordinator = createCoordinatorWork({
          returnEventIn: events.returnEventIn,
          terminalNoticeIn: notices ? terminalNoticeIn(events) : undefined,
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
            progress.push(settleProgress(promise));
          },
          now: () => clock,
          pi,
          scanWorkKeys: (cursor) =>
            pi.commit(async () => {
              const page = await storage.scanDocuments(
                {
                  scope: { kind: "session" },
                  at: "current",
                  kind: WorkDocuments.definition.kind,
                },
                32,
                cursor,
                context
              );
              return {
                keys: page.items.flatMap((entry) =>
                  entry.key ? [entry.key] : []
                ),
                ...(page.next ? { next: page.next } : {}),
              };
            }, context),
          contentAccess: {
            check: (content) =>
              allowed.get(source.name) &&
              !content.sourceIds.some((sourceId) =>
                revokedContent.has(sourceId)
              )
                ? Promise.resolve()
                : Promise.reject(
                    new Denied({
                      code: "revoked",
                      reason: "Content access revoked.",
                    })
                  ),
            retain: (content) => {
              dependencies = content;
            },
          },
          services: {
            contentDependencies: async () => {
              const imported = await readImportedContent(pi, native.id);
              return {
                sourceIds: [
                  ...new Set([
                    ...dependencies.sourceIds,
                    ...imported.sourceIds,
                  ]),
                ],
                toolIds: [
                  ...new Set([...dependencies.toolIds, ...imported.toolIds]),
                ],
              };
            },
            ownerPrincipalId,
            profile,
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
              const normalized = normalizeTeamCommand(command);
              calls.push(structuredClone(normalized.command));
              transports.push(structuredClone(normalized.wire));
              if (dispatchDenied) {
                throw new Denied({
                  code: "revoked",
                  reason: "Private transport failure details.",
                });
              }
              if (failures > 0) {
                failures -= 1;
                throw new Error("Queue unavailable");
              }
              if (held) {
                await held.promise;
              }
              delivered.push(structuredClone(normalized.command));
            },
          },
        });
        const owner = {
          actor: {
            id: ownerPrincipalId,
            organizationId: id.organization("org-A"),
            kind: "human" as const,
            state: "active" as const,
          },
        };
        const subscriptions = createCoordinatorSubscriptions({
          pi,
          nativeId: native.id,
          coordination: coordinator,
          ownerContext: () => Promise.resolve(owner),
          authorize: () =>
            allowed.get(source.name)
              ? Promise.resolve()
              : Promise.reject(
                  new Denied({
                    code: "revoked",
                    reason: "Source access revoked.",
                  })
                ),
          checkDependencies: (_context, content) =>
            allowed.get(source.name) &&
            !content.sourceIds.some((sourceId) => revokedContent.has(sourceId))
              ? Promise.resolve()
              : Promise.reject(
                  new Denied({
                    code: "revoked",
                    reason: "Content access revoked.",
                  })
                ),
          readEvent: events.read,
        });
        const extension = {
          name: `source-${source.name}`,
          tasks: coordinator.tasks,
          tools: [...coordinator.tools, ...subscriptions.tools],
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
        scopeSources.set(source.address.sessionId, {
          name: source.name,
          native,
          coordinator,
          subscriptions,
        });
        return { ...source, native, coordinator, subscriptions, faux };
      })
    );
    await Promise.all(scopes.map((scope) => scope.coordinator.restore()));
    await events.restore();
    return { pi, registry, scopes, storage, events, database };
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
    return {
      ...value,
      documents: page.items.length,
      works: Object.fromEntries(pairs),
    };
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
    transports,
    setLocalControl: (handler: BotEventScope["prepareLocalControl"]) => {
      localControl = handler;
    },
    jobs: queued.rows,
    waitDispatch,
    pi: () => host.pi,
    database: () => host.database,
    events: () => host.events,
    eventSubmissions,
    pauseEventSubmit: (at: "before" | "after") => {
      submitPause = at;
      submitEntered = Promise.withResolvers<boolean>();
      return submitEntered.promise;
    },
    clearEventPause: () => {
      submitPause = undefined;
    },
    now: () => clock,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    fail: (count: number) => {
      failures = count;
    },
    denyDispatch: () => {
      dispatchDenied = true;
    },
    setPinVersion: (version: number) => {
      pinVersion = version;
    },
    setDependencies: (value: typeof dependencies) => {
      dependencies = value;
    },
    revokeContent: (sourceId: string) => {
      revokedContent.add(sourceId);
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
      ) => Promise<void>,
      workId?: string
    ) => {
      const saved = await ledger();
      const record = workId ? saved.works[workId] : await work(name);
      assert.ok(record);
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
      host.pi.resume();
    },
    close: async () => {
      held?.resolve(true);
      await host.pi.close(context);
      await Promise.all(progress);
      await rm(directory, { recursive: true });
    },
  };
};
