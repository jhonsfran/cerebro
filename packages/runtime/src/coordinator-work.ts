import type { EventAddress } from "@cerebro/contracts/events";
import {
  Conflict,
  Denied,
  InvalidInput,
  NotFound,
} from "@cerebro/contracts/failures";
import type { PrincipalId } from "@cerebro/contracts/identity";
import type { ContentDependencies } from "@cerebro/contracts/session";
import type {
  TeamCommandTransport,
  TeamEventCommand,
} from "@cerebro/contracts/team-events";
import {
  TeamCommandSchema,
  WorkAdmissionSchema,
  WorkIdSchema,
  transitionWorkStatus,
} from "@cerebro/contracts/work";
import type {
  BackgroundWorkSnapshot,
  CoordinationProfile,
  RolePin,
  WorkId,
} from "@cerebro/contracts/work";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Cursor,
  Harness,
  ToolExecutionApi,
  ToolRegistration,
  Tx,
} from "@earendil-works/pi-durable";
import type { LifecycleJobOutcome, LifecycleJobs } from "agents/lifecycle";
import { Schema } from "effect";

import { coordinationToolResult as output } from "./coordination-tool-result.ts";
import { createCoordinatorAdmissions } from "./coordinator-admission.ts";
import {
  canCancelWork,
  createCoordinatorCommands,
} from "./coordinator-commands.ts";
import { createCoordinatorDispatch } from "./coordinator-dispatch.ts";
import type { TerminalNoticeIn } from "./coordinator-event-content.ts";
import { createCoordinatorHistory } from "./coordinator-history.ts";
import type { ScanWorkKeys, WorkContentAccess } from "./coordinator-history.ts";
import {
  SourceOperations,
  SourceWork,
  WorkDocuments,
  WorkLedger,
  coordinatorOperationKey,
  pruneWorkIndex,
  requireCoordinatorWork,
  requireWorkIdentity,
  requireWorkSource,
  sameWorkSource,
  workHoldsSlot,
} from "./coordinator-ledger.ts";
import type {
  CoordinationBinding,
  CoordinatorWorkRecord,
} from "./coordinator-ledger.ts";
import { prepareInstructionCause } from "./instruction-cause.ts";
import { trackNativeProgress } from "./native-progress.ts";
import { piContext } from "./pi-harness.ts";
import type { MetadataTransaction } from "./session-agent.ts";

export interface CoordinationServices {
  readonly ownerPrincipalId: PrincipalId;
  readonly profile: CoordinationProfile;
  readonly resolveRolePins: () => Promise<{
    readonly lead: RolePin;
    readonly worker: RolePin;
  }>;
  readonly contentDependencies: () => Promise<ContentDependencies>;
  readonly sendCommand: (command: TeamCommandTransport) => Promise<void>;
}
const HEARTBEAT_MS = 5000;
const MAX_QUEUED_WORK = 16;

export const createCoordinatorWork = (options: {
  readonly shared?: {
    readonly admissions: ReturnType<typeof createCoordinatorAdmissions>;
    readonly dispatch: ReturnType<typeof createCoordinatorDispatch>;
  };
  readonly guardIn?: (tx: Tx) => Promise<void>;
  readonly dispatchAccess?: Parameters<
    typeof createCoordinatorDispatch
  >[0]["access"];
  readonly address: EventAddress;
  readonly scanWorkKeys: ScanWorkKeys;
  readonly contentAccess: WorkContentAccess;
  readonly nativeId: ConversationId;
  readonly services?: CoordinationServices;
  readonly pi: Harness;
  readonly jobs: LifecycleJobs;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly metadata: MetadataTransaction;
  readonly authorize: (signal?: AbortSignal) => Promise<void>;
  readonly persist: () => Promise<void>;
  readonly now?: () => number;
  readonly terminalNoticeIn?: TerminalNoticeIn;
  readonly returnEventIn?: (tx: Tx, command: TeamEventCommand) => Promise<void>;
}) => {
  const now = options.now ?? Date.now;
  const publicWork = (
    record: CoordinatorWorkRecord
  ): BackgroundWorkSnapshot => ({
    workId: record.admission.key.workId,
    status: { ...record.status },
    deadlineAt: record.admission.deadlineAt,
    canCancel: canCancelWork(record, now()),
  });

  const binding = (): CoordinationBinding => {
    if (!options.services) {
      throw new Denied({
        code: "revoked",
        reason: "Team coordination is disabled.",
      });
    }
    return {
      address: options.address,
      ownerPrincipalId: options.services.ownerPrincipalId,
    };
  };
  const requireCaller = async (api: ToolExecutionApi, signal?: AbortSignal) => {
    if (api.conversationId !== options.nativeId) {
      throw new Denied({
        code: "unauthorized",
        reason: "A child cannot control team work.",
      });
    }
    binding();
    await options.authorize(signal);
  };
  const records = async () => {
    const ledger = await options.pi.snapshot(WorkLedger, piContext());
    const documents = await Promise.all(
      [
        ...Object.entries(ledger?.active ?? {}),
        ...(ledger?.queue ?? []).map((entry): [string, typeof entry] => [
          entry.workId,
          entry,
        ]),
      ]
        .filter(([, entry]) => sameWorkSource(entry.source, options.address))
        .map(([workId]) =>
          options.pi.snapshot(WorkDocuments, workId, piContext())
        )
    );
    return documents.flatMap((document) =>
      document?.record ? [document.record] : []
    );
  };

  const dispatch =
    options.shared?.dispatch ??
    createCoordinatorDispatch({
      access: options.dispatchAccess,
      address: options.address,
      nativeId: options.nativeId,
      services: options.services,
      pi: options.pi,
      authorize: options.authorize,
      binding,
      now,
      terminalNoticeIn: options.terminalNoticeIn,
      checkDependencies: options.contentAccess.check,
      returnEventIn: options.returnEventIn,
    });

  const pendingDispatches = () =>
    options.pi.commit(async (tx) => {
      const states: ("pending" | "running" | "waiting" | "completing")[] = [
        "pending",
        "running",
        "waiting",
        "completing",
      ];
      const pages = await Promise.all(
        states.map(async (status) => {
          const tasks = [];
          let cursor: Cursor | undefined;
          do {
            // oxlint-disable-next-line no-await-in-loop -- Each cursor continues the same persisted dispatch scan.
            const page = await tx.scanTasks(
              {
                conversationId: options.nativeId,
                background: true,
                kind: dispatch.definition.name,
                status,
              },
              16,
              cursor
            );
            tasks.push(...page.items.map((task) => task.id));
            cursor = page.next;
          } while (cursor);
          return tasks;
        })
      );
      return pages.flat();
    }, piContext());
  const holdDispatches = async (): Promise<void> => {
    trackNativeProgress(
      options.pi,
      { tasks: await pendingDispatches() },
      options.waitUntil
    );
  };

  const { enqueueIn, enqueueAllIn, commandIn, eventCommandsIn } =
    createCoordinatorCommands({
      nativeId: options.nativeId,
      dispatch,
      binding,
      now,
      publicWork,
    });
  const admissions =
    options.shared?.admissions ??
    createCoordinatorAdmissions({
      pi: options.pi,
      nativeId: options.nativeId,
      sessionId: options.address.sessionId,
      jobs: options.jobs,
      metadata: options.metadata,
      persist: async () => {
        await options.persist();
        await holdDispatches();
      },
      now,
      timeoutMs: options.services?.profile.timeoutMs ?? 600_000,
    });

  const start = async (
    goal: string,
    api: ToolExecutionApi,
    context: Parameters<ToolExecutionApi["agent"]>[0]
  ) => {
    await requireCaller(api, context.abortSignal);
    const source = binding();
    const { services } = options;
    if (!services) {
      throw new Denied({
        code: "revoked",
        reason: "Team coordination is disabled.",
      });
    }
    const instructionCauseIn = await prepareInstructionCause({
      pi: options.pi,
      nativeId: options.nativeId,
      ...source,
    });
    const candidate = Schema.decodeUnknownSync(WorkIdSchema)(
      await coordinatorOperationKey(
        JSON.stringify([
          "work-task-v1",
          source.address.organizationId,
          source.ownerPrincipalId,
          source.address.agentId,
          source.address.conversationId,
          source.address.sessionId,
          String(api.taskId),
        ])
      )
    );
    const prior = await options.pi.snapshot(
      WorkDocuments,
      candidate,
      piContext(context.abortSignal)
    );
    if (prior?.record) {
      requireWorkSource(prior.record, source);
      if (prior.record.admission.goal !== goal) {
        throw new InvalidInput({
          reason: "The start task names another goal.",
        });
      }
      return publicWork(prior.record);
    }
    const admittedAt = now();
    const [pins, contentDependencies] = await Promise.all([
      services.resolveRolePins(),
      services.contentDependencies(),
    ]);
    return await admissions.commit(
      `start:${api.taskId}`,
      async (tx) => {
        const document = await tx.doc(WorkDocuments, candidate, null);
        if (document.record) {
          requireWorkSource(document.record, source);
          if (document.record.admission.goal !== goal) {
            throw new InvalidInput({
              reason: "The start task names another goal.",
            });
          }
          return publicWork(document.record);
        }
        const human = await instructionCauseIn(tx);
        const ledger = await tx.doc(WorkLedger);
        requireWorkIdentity(ledger, source);
        const expired = await pruneWorkIndex(tx, ledger, now());
        const { queue } = ledger;
        const queued =
          queue.length > 0 ||
          Object.keys(ledger.active).length >= services.profile.maxTeams;
        if (queued && queue.length >= MAX_QUEUED_WORK) {
          throw new InvalidInput({
            reason:
              "This identity already has its maximum sixteen queued work items.",
          });
        }
        const admission = Schema.decodeUnknownSync(WorkAdmissionSchema, {
          onExcessProperty: "error",
        })({
          version: 2,
          admittedAt,
          contentDependencies,
          deadlineAt: admittedAt + services.profile.timeoutMs,
          goal,
          key: {
            organizationId: source.address.organizationId,
            ownerPrincipalId: source.ownerPrincipalId,
            workId: candidate,
          },
          lead: pins.lead,
          worker: pins.worker,
          limits: {
            maxTeams: services.profile.maxTeams,
            maxWorkers: services.profile.maxWorkers,
            maxTurns: services.profile.maxTurns,
            timeoutMs: services.profile.timeoutMs,
          },
          sourceEventAddress: source.address,
        });
        const record: CoordinatorWorkRecord = {
          admission,
          humanOperationId: human.operationId,
          pendingCommands: {},
          reportId: null,
          terminalReport: null,
          dispatched: !queued,
          queuedCommands: {},
          status: { kind: queued ? "queued" : "accepted" },
        };
        document.record = record;
        const entry = {
          workId: candidate,
          source: source.address,
          deadlineAt: admission.deadlineAt,
        };
        if (queued) {
          queue.push(entry);
          ledger.queue = queue;
        } else {
          await enqueueIn(
            tx,
            document.record,
            Schema.decodeUnknownSync(TeamCommandSchema)({
              id: `start:${candidate}`,
              kind: "start",
              work: admission,
            })
          );
          ledger.active[candidate] = {
            source: entry.source,
            deadlineAt: entry.deadlineAt,
          };
        }
        const sourceWork = await tx.doc(SourceWork, options.nativeId);
        sourceWork.workId = candidate;
        await Promise.all(
          expired.map((item) => options.terminalNoticeIn?.(tx, item, "expired"))
        );
        return publicWork(record);
      },
      (change) => api.commit(change, context)
    );
  };

  const promoteIn = async (
    tx: Tx
  ): Promise<
    { record: CoordinatorWorkRecord; command: TeamCommandTransport }[]
  > => {
    const ledger = await tx.doc(WorkLedger);
    requireWorkIdentity(ledger, binding());
    const commands: {
      record: CoordinatorWorkRecord;
      command: TeamCommandTransport;
    }[] = [];
    for (;;) {
      const [head] = ledger.queue;
      if (!head || !sameWorkSource(head.source, options.address)) {
        break;
      }
      // oxlint-disable-next-line no-await-in-loop -- Each reservation changes the capacity available to the next FIFO head.
      const record = await requireCoordinatorWork(tx, binding(), head.workId);
      if (record.status.kind !== "queued") {
        ledger.queue = ledger.queue.slice(1);
        continue;
      }
      if (
        Object.keys(ledger.active).length >= record.admission.limits.maxTeams
      ) {
        break;
      }
      record.dispatched = true;
      record.status = { kind: "accepted" };
      const startCommand = Schema.decodeUnknownSync(TeamCommandSchema)({
        id: `start:${head.workId}`,
        kind: "start",
        work: record.admission,
      });
      commands.push(
        ...[startCommand, ...Object.values(record.queuedCommands)].map(
          (command) => ({ record, command })
        )
      );
      record.queuedCommands = {};
      ledger.active[head.workId] = {
        source: head.source,
        deadlineAt: head.deadlineAt,
      };
      ledger.queue = ledger.queue.slice(1);
    }
    return commands;
  };

  const history = createCoordinatorHistory({
    pi: options.pi,
    nativeId: options.nativeId,
    binding,
    scanWorkKeys: options.scanWorkKeys,
    contentAccess: options.contentAccess,
  });
  const tools: ToolRegistration[] = options.services
    ? [
        defineTool({
          callers: ["model"],
          name: "start_team",
          description:
            "Start bounded read-only team work for the current human request. Returns after durable admission while the team runs independently.",
          parameters: Type.Object({
            goal: Type.String({ minLength: 1, maxLength: 16_000 }),
          }),
          replay: "safe",
          execute: ({ goal }, api, context) =>
            output(() => start(goal, api, context)),
        }),
        defineTool({
          callers: ["model"],
          name: "get_work",
          description:
            "Read the saved status of work belonging to this conversation.",
          parameters: Type.Object({
            workId: Type.String({ minLength: 1, maxLength: 512 }),
          }),
          replay: "safe",
          execute: ({ workId }, api, context) =>
            output(async () => {
              await requireCaller(api, context.abortSignal);
              return await api.commit(
                async (tx) =>
                  publicWork(
                    await requireCoordinatorWork(tx, binding(), workId)
                  ),
                context
              );
            }),
        }),
        defineTool({
          callers: ["model"],
          name: "message_team",
          description:
            "Send a bounded update to this conversation's active team without waiting for its result.",
          parameters: Type.Object({
            workId: Type.String({ minLength: 1, maxLength: 512 }),
            text: Type.String({ minLength: 1, maxLength: 16_000 }),
          }),
          replay: "safe",
          execute: ({ workId, text }, api, context) =>
            output(async () => {
              await requireCaller(api, context.abortSignal);
              const contentDependencies =
                await options.services?.contentDependencies();
              if (!contentDependencies) {
                throw new Denied({
                  code: "revoked",
                  reason: "Team coordination is disabled.",
                });
              }
              return await admissions.commit(
                `input:${api.taskId}`,
                (tx) =>
                  commandIn(
                    tx,
                    workId,
                    String(api.taskId),
                    {
                      kind: "input",
                      text,
                      contentDependencies,
                    },
                    "tool"
                  ),
                (change) => api.commit(change, context)
              );
            }),
        }),
        defineTool({
          callers: ["model"],
          name: "stop_work",
          description:
            "Persist cancellation for this conversation's team and dispatch it durably. Late starts and reports cannot revive cancelled work.",
          parameters: Type.Object({
            workId: Type.String({ minLength: 1, maxLength: 512 }),
          }),
          replay: "safe",
          execute: ({ workId }, api, context) =>
            output(async () => {
              await requireCaller(api, context.abortSignal);
              return await admissions.commit(
                `stop:${api.taskId}`,
                (tx) =>
                  commandIn(
                    tx,
                    workId,
                    String(api.taskId),
                    { kind: "cancel" },
                    "tool"
                  ),
                (change) => api.commit(change, context)
              );
            }),
        }),
        defineTool({
          callers: ["model"],
          name: "list_work",
          description:
            "List a bounded creation-order page of work from this conversation. Continue with next even when a filtered page is empty. No exact total is provided.",
          parameters: Type.Object({
            cursor: Type.Optional(
              Type.String({ minLength: 1, maxLength: 4096 })
            ),
          }),
          replay: "safe",
          execute: ({ cursor }, api, context) =>
            output(async () => {
              await requireCaller(api, context.abortSignal);
              return await history.list(cursor, api, context);
            }),
        }),
        defineTool({
          callers: ["model"],
          name: "recall_work",
          description:
            "Recall one permitted work item's bounded goal and a terminal report chunk. Continue with nextReportOffset to read a longer report.",
          parameters: Type.Object({
            workId: Type.String({ minLength: 1, maxLength: 512 }),
            offset: Type.Optional(
              Type.Integer({ minimum: 0, maximum: 16_000 })
            ),
          }),
          replay: "safe",
          execute: ({ workId, offset }, api, context) =>
            output(async () => {
              await requireCaller(api, context.abortSignal);
              return await history.recall(workId, api, context, offset);
            }),
        }),
      ]
    : [];

  return {
    binding,
    services: options.services,
    tools,
    dispatch,
    tasks: [dispatch],
    admissions,
    notifyExpiredIn: async (
      tx: Tx,
      expired: readonly CoordinatorWorkRecord[]
    ): Promise<void> => {
      await Promise.all(
        expired.map((record) =>
          options.terminalNoticeIn?.(tx, record, "expired")
        )
      );
    },
    commandIn,
    eventCommandsIn,
    current: async (): Promise<BackgroundWorkSnapshot | undefined> => {
      if (!options.services) {
        return;
      }
      const source = await options.pi.snapshot(
        SourceWork,
        options.nativeId,
        piContext()
      );
      if (!source?.workId) {
        return;
      }
      const document = await options.pi.snapshot(
        WorkDocuments,
        source.workId,
        piContext()
      );
      if (!document?.record) {
        throw new NotFound({ resource: "Team work" });
      }
      requireWorkSource(document.record, binding());
      return publicWork(document.record);
    },
    cancel: async (input: {
      readonly workId: WorkId;
      readonly operationId: string;
      readonly signal?: AbortSignal;
    }) => {
      binding();
      await options.authorize(input.signal);
      const key = await coordinatorOperationKey(input.operationId);
      const digest = await coordinatorOperationKey(
        JSON.stringify({ kind: "stop-work", workId: input.workId })
      );
      return await admissions.commit(input.operationId, async (tx) => {
        await options.guardIn?.(tx);
        const operation = await tx.doc(
          SourceOperations,
          options.nativeId,
          key,
          input.operationId
        );
        if (operation.digest !== null && operation.digest !== digest) {
          throw new Conflict({
            code: "digest-mismatch",
            reason: "The source operation payload changed.",
          });
        }
        operation.digest = digest;
        return await commandIn(tx, input.workId, input.operationId, {
          kind: "cancel",
        });
      });
    },
    rememberHumanOperation: async (operationId: string): Promise<void> => {
      if (!options.services) {
        return;
      }
      const key = await coordinatorOperationKey(operationId);
      await options.pi.commit(async (tx) => {
        await options.guardIn?.(tx);
        const ledger = await tx.doc(WorkLedger);
        requireWorkIdentity(ledger, binding());
        const operation = await tx.doc(
          SourceOperations,
          options.nativeId,
          key,
          operationId
        );
        if (!operation.route) {
          operation.route = { kind: "coordinator", workId: null };
        }
      }, piContext());
    },
    restore: async (): Promise<void> => {
      const current = await records();
      const pending = await pendingDispatches();
      if (
        current.length > 0 ||
        pending.length > 0 ||
        (await admissions.pending())
      ) {
        await admissions.ensureWake();
        await holdDispatches();
      }
    },
    wake: async (): Promise<LifecycleJobOutcome> => {
      let authorized = false;
      try {
        await options.authorize();
        authorized = options.services !== undefined;
      } catch (error) {
        if (
          !(error instanceof Denied) &&
          !(error instanceof NotFound) &&
          !(error instanceof InvalidInput)
        ) {
          throw error;
        }
      }
      await options.pi.commit(async (tx) => {
        await options.guardIn?.(tx);
        const ledger = await tx.doc(WorkLedger);
        const terminal: CoordinatorWorkRecord[] = [];
        const expired = Object.entries(ledger.active).filter(
          ([, entry]) =>
            sameWorkSource(entry.source, options.address) &&
            entry.deadlineAt <= now()
        );
        const cancellations = await Promise.all(
          expired.map(async ([workId]) => {
            const document = await tx.doc(WorkDocuments, workId, null);
            const { record } = document;
            if (record) {
              if (
                record.status.kind === "accepted" ||
                record.status.kind === "running"
              ) {
                terminal.push(record);
              }
              record.status = transitionWorkStatus(record.status, {
                kind: "failed",
                reason: "The team work deadline expired.",
              });
              const command = Schema.decodeUnknownSync(TeamCommandSchema, {
                onExcessProperty: "error",
              })({
                kind: "cancel",
                id: `cancel:${workId}`,
                work: record.admission,
              });
              Reflect.deleteProperty(ledger.active, workId);
              return [{ record, command }];
            }
            Reflect.deleteProperty(ledger.active, workId);
            return [];
          })
        );
        terminal.push(...(await pruneWorkIndex(tx, ledger, now())));
        const promotions = authorized ? await promoteIn(tx) : [];
        await enqueueAllIn(tx, [...cancellations.flat(), ...promotions]);
        await Promise.all(
          terminal.map((record) =>
            options.terminalNoticeIn?.(tx, record, "expired")
          )
        );
      }, piContext());
      options.pi.resume();
      await holdDispatches();
      const pending = await pendingDispatches();
      const queued = await options.pi.snapshot(WorkLedger, piContext());
      const hasQueued = (queued?.queue ?? []).some((entry) =>
        sameWorkSource(entry.source, options.address)
      );
      if (pending.length > 0 || hasQueued || (await admissions.pending())) {
        return { rescheduleAt: now() + HEARTBEAT_MS };
      }
      const current = await records();
      const deadlines = current
        .filter((record) => workHoldsSlot(record, now()))
        .map((record) => record.admission.deadlineAt);
      return deadlines.length > 0
        ? { rescheduleAt: Math.min(...deadlines) }
        : undefined;
    },
  };
};

export const wakeCoordinatorJob = async (options: {
  readonly pi: Harness;
  readonly address: EventAddress;
  readonly restore: () => Promise<{
    readonly wake: () => Promise<LifecycleJobOutcome>;
  }>;
  readonly now?: () => number;
  readonly terminalNoticeIn?: TerminalNoticeIn;
}): Promise<LifecycleJobOutcome> => {
  const now = options.now ?? Date.now;
  let coordinator: Awaited<ReturnType<typeof options.restore>>;
  try {
    coordinator = await options.restore();
  } catch (error) {
    if (
      !(error instanceof Denied) &&
      !(error instanceof NotFound) &&
      !(error instanceof InvalidInput)
    ) {
      throw error;
    }
    return await options.pi.commit(async (tx) => {
      const ledger = await tx.doc(WorkLedger);
      const expired = await pruneWorkIndex(tx, ledger, now());
      await Promise.all(
        expired.map((record) =>
          options.terminalNoticeIn?.(tx, record, "expired")
        )
      );
      const remaining = [...Object.values(ledger.active), ...ledger.queue].some(
        (entry) => sameWorkSource(entry.source, options.address)
      );
      return remaining ? { rescheduleAt: now() + HEARTBEAT_MS } : undefined;
    }, piContext());
  }
  return await coordinator.wake();
};
