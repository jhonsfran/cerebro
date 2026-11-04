import type { EventAddress } from "@cerebro/contracts/events";
import {
  Denied,
  InvalidInput,
  failureToHttp,
  toContractFailure,
} from "@cerebro/contracts/failures";
import type { PrincipalId } from "@cerebro/contracts/identity";
import type { ContentDependencies } from "@cerebro/contracts/session";
import {
  TeamCommandSchema,
  WorkAdmissionSchema,
  WorkIdSchema,
  transitionWorkStatus,
} from "@cerebro/contracts/work";
import type {
  CoordinationProfile,
  RolePin,
  TeamCommand,
} from "@cerebro/contracts/work";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Harness,
  TaskId,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
  Tx,
} from "@earendil-works/pi-durable";
import type { LifecycleJobOutcome, LifecycleJobs } from "agents/lifecycle";
import { Schema } from "effect";

import { createCoordinatorAdmissions } from "./coordinator-admission.ts";
import { createCoordinatorDispatch } from "./coordinator-dispatch.ts";
import {
  CommandReceipts,
  SourceOperations,
  SourceWork,
  WorkDocuments,
  WorkLedger,
  coordinatorOperationKey,
  currentHumanCandidates,
  currentHumanOperation,
  pruneWorkIndex,
  requireCoordinatorWork,
  requireWorkIdentity,
  sameWorkSource,
  workHoldsSlot,
} from "./coordinator-ledger.ts";
import type {
  CoordinationBinding,
  CoordinatorWorkRecord,
} from "./coordinator-ledger.ts";
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
  readonly sendCommand: (command: TeamCommand) => Promise<void>;
}
type CoordinatorInput =
  | { readonly kind: "cancel" }
  | {
      readonly kind: "input";
      readonly text: string;
      readonly contentDependencies: ContentDependencies;
    };
const matchesCommandInput = (
  saved: TeamCommand,
  input: CoordinatorInput
): boolean =>
  saved.kind === input.kind &&
  (saved.kind !== "input" ||
    input.kind !== "input" ||
    saved.text === input.text);
const HEARTBEAT_MS = 5000;
const publicWork = (record: CoordinatorWorkRecord) => ({
  workId: record.admission.key.workId,
  status: { ...record.status },
  deadlineAt: record.admission.deadlineAt,
});

const output = async (
  operation: () => Promise<unknown>
): Promise<ToolExecutionResult> => {
  try {
    const value = await operation();
    return { output: [{ type: "text", text: JSON.stringify(value) }] };
  } catch (error) {
    const failure = failureToHttp(
      toContractFailure(error, "The team operation is unavailable.")
    );
    return {
      isError: true,
      output: [{ type: "text", text: failure.body.message }],
    };
  }
};

export const createCoordinatorWork = (options: {
  readonly address: EventAddress;
  readonly nativeId: ConversationId;
  readonly services?: CoordinationServices;
  readonly pi: Harness;
  readonly jobs: LifecycleJobs;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly metadata: MetadataTransaction;
  readonly authorize: (signal?: AbortSignal) => Promise<void>;
  readonly persist: () => Promise<void>;
  readonly now?: () => number;
}) => {
  const now = options.now ?? Date.now;

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
      Object.entries(ledger?.active ?? {})
        .filter(([, entry]) => sameWorkSource(entry.source, options.address))
        .map(([workId]) =>
          options.pi.snapshot(WorkDocuments, workId, piContext())
        )
    );
    return documents.flatMap((document) =>
      document?.record ? [document.record] : []
    );
  };

  const dispatch = createCoordinatorDispatch({
    address: options.address,
    nativeId: options.nativeId,
    services: options.services,
    pi: options.pi,
    authorize: options.authorize,
    binding,
    now,
  });

  const commandReceipt = async (tx: Tx, command: TeamCommand) => {
    const digest = await coordinatorOperationKey(JSON.stringify(command));
    const document = await tx.doc(CommandReceipts, command.id, null);
    if (!document.receipt) {
      return { digest, document, taskId: undefined };
    }
    const task = await tx.task(document.receipt.taskId);
    if (
      !task ||
      task.kind !== dispatch.definition.name ||
      document.receipt.digest !== digest
    ) {
      throw new InvalidInput({
        reason: "The team command ID names another input.",
      });
    }
    const saved = Schema.decodeUnknownSync(TeamCommandSchema, {
      onExcessProperty: "error",
    })(task.input);
    if ((await coordinatorOperationKey(JSON.stringify(saved))) !== digest) {
      throw new InvalidInput({ reason: "The saved team command changed." });
    }
    return { digest, document, taskId: document.receipt.taskId };
  };
  const enqueueIn = async (
    tx: Tx,
    record: CoordinatorWorkRecord,
    command: TeamCommand
  ): Promise<TaskId> => {
    const previous = await commandReceipt(tx, command);
    if (previous.taskId !== undefined) {
      return previous.taskId;
    }
    const pending = await Promise.all(
      Object.entries(record.pendingCommands).map(
        async ([commandId, receipt]) => ({
          commandId,
          task: await tx.task(receipt.taskId),
        })
      )
    );
    for (const item of pending) {
      if (!item.task || item.task.state.status === "terminal") {
        Reflect.deleteProperty(record.pendingCommands, item.commandId);
      }
    }
    const limit = command.kind === "cancel" ? 8 : 7;
    if (Object.keys(record.pendingCommands).length >= limit) {
      throw new InvalidInput({
        reason: "This work already has its maximum pending commands.",
      });
    }
    const taskId = await tx.createTask(dispatch, command, {
      background: true,
      conversationId: options.nativeId,
      ownership: { kind: "conversation" },
    });
    const receipt = { digest: previous.digest, taskId };
    previous.document.receipt = receipt;
    record.pendingCommands[command.id] = receipt;
    return taskId;
  };
  const pendingDispatches = () =>
    options.pi.commit(async (tx) => {
      const states: ("pending" | "running" | "waiting" | "completing")[] = [
        "pending",
        "running",
        "waiting",
        "completing",
      ];
      const pages = await Promise.all(
        states.map((status) =>
          tx.scanTasks(
            {
              conversationId: options.nativeId,
              background: true,
              kind: dispatch.definition.name,
              status,
            },
            16
          )
        )
      );
      return pages.flatMap((page) => page.items.map((task) => task.id));
    }, piContext());
  const holdDispatches = async (): Promise<void> => {
    trackNativeProgress(
      options.pi,
      { tasks: await pendingDispatches() },
      options.waitUntil
    );
  };

  const admissions = createCoordinatorAdmissions({
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
    const candidates = await currentHumanCandidates(
      options.pi,
      options.nativeId
    );
    const [pins, contentDependencies] = await Promise.all([
      services.resolveRolePins(),
      services.contentDependencies(),
    ]);
    const candidate = Schema.decodeUnknownSync(WorkIdSchema)(
      crypto.randomUUID()
    );
    return await admissions.commit(
      `start:${api.taskId}`,
      async (tx) => {
        const human = await currentHumanOperation(
          tx,
          source,
          options.nativeId,
          candidates
        );
        const operation = await tx.doc(
          SourceOperations,
          options.nativeId,
          human.key,
          human.operationId
        );
        const ledger = await tx.doc(WorkLedger);
        requireWorkIdentity(ledger, source);
        await pruneWorkIndex(tx, ledger, now());
        const priorId = operation.route?.workId;
        const activeId = Object.entries(ledger.active).find(([, entry]) =>
          sameWorkSource(entry.source, source.address)
        )?.[0];
        const reusableId = priorId ?? activeId;
        if (reusableId) {
          const reusable = await requireCoordinatorWork(tx, source, reusableId);
          operation.route = { kind: "coordinator", workId: reusableId };
          const sourceWork = await tx.doc(SourceWork, options.nativeId);
          sourceWork.workId = reusableId;
          return publicWork(reusable);
        }
        if (Object.keys(ledger.active).length >= services.profile.maxTeams) {
          throw new InvalidInput({
            reason: "This identity already has its maximum active teams.",
          });
        }
        const admittedAt = now();
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
          pendingCommands: {},
          reportId: null,
          status: { kind: "accepted" },
        };
        const document = await tx.doc(WorkDocuments, candidate, null);
        document.record = record;
        const command = Schema.decodeUnknownSync(TeamCommandSchema, {
          onExcessProperty: "error",
        })({
          id: `start:${candidate}`,
          kind: "start",
          work: admission,
        });
        await enqueueIn(tx, document.record, command);
        ledger.active[candidate] = {
          source: source.address,
          deadlineAt: admission.deadlineAt,
        };
        operation.route = { kind: "coordinator", workId: candidate };
        const sourceWork = await tx.doc(SourceWork, options.nativeId);
        sourceWork.workId = candidate;
        return publicWork(record);
      },
      (change) => api.commit(change, context)
    );
  };

  const commandIn = async (
    tx: Tx,
    workId: string,
    operationId: string,
    input: CoordinatorInput,
    origin: "human" | "tool" = "human"
  ) => {
    const { kind } = input;
    const suffix = await coordinatorOperationKey(
      JSON.stringify([origin, operationId])
    );
    const commandId =
      kind === "cancel" ? `cancel:${workId}` : `input:${workId}:${suffix}`;
    const operation =
      origin === "human"
        ? await tx.doc(
            SourceOperations,
            options.nativeId,
            await coordinatorOperationKey(operationId),
            operationId
          )
        : undefined;
    if (operation?.route) {
      const expected = JSON.stringify({ kind: "team", workId, commandId });
      if (JSON.stringify(operation.route) !== expected) {
        throw new InvalidInput({
          reason: "The source operation already chose another route.",
        });
      }
    }
    const record = await requireCoordinatorWork(tx, binding(), workId);
    if (operation) {
      operation.route = { kind: "team", workId, commandId };
    }
    const receipt = await tx.doc(CommandReceipts, commandId, null);
    if (receipt.receipt) {
      const task = await tx.task(receipt.receipt.taskId);
      const saved = task
        ? Schema.decodeUnknownSync(TeamCommandSchema, {
            onExcessProperty: "error",
          })(task.input)
        : undefined;
      if (
        !saved ||
        saved.id !== commandId ||
        !matchesCommandInput(saved, input) ||
        JSON.stringify(saved.work) !== JSON.stringify(record.admission)
      ) {
        throw new InvalidInput({
          reason: "The team command ID names another input.",
        });
      }
      await commandReceipt(tx, saved);
      return { ...publicWork(record), accepted: false };
    }
    const command = Schema.decodeUnknownSync(TeamCommandSchema, {
      onExcessProperty: "error",
    })({
      id: commandId,
      work: record.admission,
      ...input,
    });
    if (kind === "cancel") {
      if (record.reportId !== null) {
        return { ...publicWork(record), accepted: false };
      }
      record.status = transitionWorkStatus(record.status, {
        kind: "cancelled",
        commandId: command.id,
      });
    } else if (
      !workHoldsSlot(record, now()) ||
      (record.status.kind !== "accepted" && record.status.kind !== "running")
    ) {
      throw new InvalidInput({ reason: "This work no longer accepts input." });
    }
    await enqueueIn(tx, record, command);
    return { ...publicWork(record), accepted: true };
  };

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
      ]
    : [];

  return {
    binding,
    services: options.services,
    tools,
    tasks: [dispatch],
    admissions,
    commandIn,
    rememberHumanOperation: async (operationId: string): Promise<void> => {
      if (!options.services) {
        return;
      }
      const key = await coordinatorOperationKey(operationId);
      await options.pi.commit(async (tx) => {
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
      await options.pi.commit(async (tx) => {
        const ledger = await tx.doc(WorkLedger);
        const expired = Object.entries(ledger.active).filter(
          ([, entry]) =>
            sameWorkSource(entry.source, options.address) &&
            entry.deadlineAt <= now()
        );
        await Promise.all(
          expired.map(async ([workId]) => {
            const document = await tx.doc(WorkDocuments, workId, null);
            const { record } = document;
            if (record) {
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
              await enqueueIn(tx, record, command);
            }
            Reflect.deleteProperty(ledger.active, workId);
          })
        );
      }, piContext());
      options.pi.resume();
      await holdDispatches();
      const pending = await pendingDispatches();
      if (pending.length > 0 || (await admissions.pending())) {
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
