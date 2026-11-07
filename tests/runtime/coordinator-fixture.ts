/* oxlint-disable unicorn/no-await-expression-member -- Assertions read one field of freshly awaited durable state. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { LifecycleJob, LifecycleJobs } from "agents/lifecycle";
import { Schema } from "effect";

import { Denied } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import { normalizeTeamCommand } from "../../packages/contracts/src/team-events.ts";
import type { TeamCommandTransport } from "../../packages/contracts/src/team-events.ts";
import { triggerId } from "../../packages/contracts/src/triggers.ts";
import type { Trigger } from "../../packages/contracts/src/triggers.ts";
import {
  TeamDefaultsSchema,
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
import {
  Receipts,
  createTriggers,
} from "../../packages/runtime/src/triggers.ts";
import type {
  TriggerPlacement,
  TriggerScope,
  Triggers,
} from "../../packages/runtime/src/triggers.ts";
import { waitFor } from "./helpers.ts";

const settleProgress = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    return await promise;
  } catch (error) {
    return error;
  }
};

export const context = piContext();
export const actor = {
  actor: {
    id: id.principal("owner-A"),
    organizationId: id.organization("org-A"),
    kind: "human" as const,
    state: "active" as const,
  },
};
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
const finished = new Set<TriggerPlacement["kind"]>([
  "done",
  "unanswered",
  "withdrawn",
  "local-answer",
]);

export const setup = async (
  timeoutMs = 600_000,
  notices = false,
  agentIds: Readonly<Record<string, string>> = {},
  followUpMode: "all" | "one-at-a-time" = "all"
) => {
  const directory = await mkdtemp(path.join(tmpdir(), "cerebro-coordinator-"));
  const databasePath = path.join(directory, "state.sqlite");
  const queued = fakeJobs();
  const nativeIds = new Map<string, ConversationId>();
  const calls: TeamCommand[] = [];
  const delivered: TeamCommand[] = [];
  const transports: TeamCommandTransport[] = [];
  let localAnswer: TriggerScope["localAnswer"];
  let deliveryAuthorization: ((trigger: Trigger) => Promise<void>) | undefined;
  let gate: "open" | "waiting" = "open";
  const progress: Promise<unknown>[] = [];
  let pinVersion = 1;
  let clock = Date.now();
  let failures = 0;
  let dispatchDenied = false;
  const eventSubmissions: string[] = [];
  let submitPause: "before" | "after" | undefined;
  let submitEntered = Promise.withResolvers<boolean>();
  let stopped = new AbortController();
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
  const limits = Schema.decodeUnknownSync(TeamDefaultsSchema)({ timeoutMs });
  const sourceBindings = ["a", "b", "c"].map((name, index) => ({
    name,
    address: {
      organizationId: id.organization("org-A"),
      agentId: id.agent(agentIds[name] ?? `coordinator-${name.toUpperCase()}`),
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
          followUpMode,
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
    const triggers: Triggers = createTriggers({
      pi,
      targetIn: (_tx, address) => {
        const source = sourceBindings.find(
          (item) => item.address.sessionId === address.sessionId
        );
        const nativeId = source && nativeIds.get(source.name);
        assert.ok(nativeId);
        return Promise.resolve({ nativeId });
      },
      resolve: (address): Promise<TriggerScope> => {
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
                  const halted = Promise.withResolvers<never>();
                  const stop = () =>
                    halted.reject(new Error("Fixture process stopped."));
                  invocation.abortSignal?.addEventListener("abort", stop, {
                    once: true,
                  });
                  stopped.signal.addEventListener("abort", stop, {
                    once: true,
                  });
                  await halted.promise;
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
        const authorize: TriggerScope["authorize"] = async (
          trigger,
          _caller,
          action
        ) => {
          await (allowed.get(current.name) &&
          !trigger.dependencies.sourceIds.some((sourceId) =>
            revokedContent.has(sourceId)
          )
            ? Promise.resolve()
            : Promise.reject(
                new Denied({
                  code: "revoked",
                  reason: "Event content revoked.",
                })
              ));
          if (action === "deliver") {
            await deliveryAuthorization?.(trigger);
          }
        };
        return Promise.resolve({
          native,
          ownerPrincipalId,
          requireCurrent: () => assert.ok(scopeSources.has(address.sessionId)),
          commit: (key, change) =>
            current.coordinator.admissions.commit(key, change),
          gate: () => Promise.resolve(gate),
          route: current.subscriptions.prepare,
          localAnswer,
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
              kind: Receipts.definition.kind,
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
        const owner = {
          actor: {
            id: ownerPrincipalId,
            organizationId: id.organization("org-A"),
            kind: "human" as const,
            state: "active" as const,
          },
        };
        const coordinator = createCoordinatorWork({
          returnEventIn: triggers.returnEventIn,
          terminalNoticeIn: notices ? terminalNoticeIn(triggers) : undefined,
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
            get agent() {
              return {
                agentId: source.address.agentId,
                agentVersion: pinVersion,
              };
            },
            limits,
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
          readEvent: triggers.read,
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
    await triggers.drainAll(scopes.map((scope) => scope.native.id));
    return { pi, registry, models, scopes, storage, triggers, database };
  };
  let host = await open();
  const source = (name: string) => {
    const value = host.scopes.find((item) => item.name === name);
    assert.ok(value);
    return value;
  };
  const webTrigger = async (
    name: string,
    operationId: string,
    text = operationId
  ): Promise<Trigger> => {
    const { address } = source(name);
    const origin = {
      kind: "web",
      operationId: id.operation(operationId),
    } as const;
    return {
      version: 2,
      id: await triggerId(address, origin),
      address,
      ownerPrincipalId,
      origin,
      text,
      reference: null,
      reply: null,
      dependencies: { sourceIds: [], toolIds: [] },
    };
  };
  const receipt = async (eventId: string) => {
    const saved = await host.pi.snapshot(Receipts, eventId, context);
    assert.ok(saved?.receipt, `no receipt for ${eventId}`);
    return saved.receipt;
  };
  const placement = async (eventId: string) =>
    host.triggers.placement(await receipt(eventId));
  const settled = (eventId: string, limitMs = 10_000) =>
    waitFor(
      () => placement(eventId),
      (value) => finished.has(value.kind),
      limitMs,
      10
    );
  const ledger = async () => {
    const value = (await host.pi.snapshot(WorkLedger, context)) ?? {
      identity: null,
      active: {},
      queue: [],
    };
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
    webTrigger,
    receipt,
    placement,
    settled,
    setLocalAnswer: (handler: TriggerScope["localAnswer"]) => {
      localAnswer = handler;
    },
    setEventDeliveryAuthorization: (handler: typeof deliveryAuthorization) => {
      deliveryAuthorization = handler;
    },
    setGate: (value: "open" | "waiting") => {
      gate = value;
    },
    registry: () => host.registry,
    models: () => host.models,
    lifecycleJobs: queued.jobs,
    jobs: queued.rows,
    waitDispatch,
    pi: () => host.pi,
    database: () => host.database,
    storage: () => host.storage,
    triggers: () => host.triggers,
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
    // A human turn is a web trigger through the real admission path, so tool calls from that turn carry a human cause.
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
      let status: string;
      if (human) {
        const trigger = await webTrigger(name, requestId);
        await host.triggers.admit(trigger, actor);
        status = (await settled(trigger.id)).kind;
      } else {
        const submission = await current.native.submit(
          { type: "input", content: requestId, requestId },
          context
        );
        ({ status } = await submission.wait(context));
      }
      const watch = await current.native.watch(context);
      try {
        return { settled: { status }, snapshot: chatPresentation(watch.value) };
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
      stopped.abort();
      stopped = new AbortController();
      await host.pi.close(context);
      host = await open();
      host.pi.resume();
    },
    close: async () => {
      held?.resolve(true);
      stopped.abort();
      await host.pi.close(context);
      await Promise.all(progress);
      await rm(directory, { recursive: true });
    },
  };
};
