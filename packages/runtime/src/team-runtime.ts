import { Denied, InvalidInput } from "@cerebro/contracts/failures";
import {
  canonicalToolArguments,
  digestToolArguments,
} from "@cerebro/contracts/tools";
import {
  TeamCommandSchema,
  TeamCommandReceiptSchema,
  workStartOperationId,
} from "@cerebro/contracts/work";
import type { WorkAdmission, WorkReport } from "@cerebro/contracts/work";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { configure } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Harness,
  Registry,
  Tx,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";

import { trackNativeProgress } from "./native-progress.ts";
import { piContext } from "./pi-harness.ts";
import type { MetadataTransaction } from "./session-agent.ts";
import { createTeamAdmission } from "./team-admission.ts";
import { createTeamCompletion } from "./team-completion.ts";
import { createTeamRole } from "./team-role.ts";
import type { TeamRoleConfiguration } from "./team-role.ts";
import {
  TeamCommandReceipts,
  TeamState,
  requireTeamAdmission,
  teamCommandDependencies,
} from "./team-state.ts";
import { createTeamWorkerTool } from "./team-workers.ts";

export const createTeamRuntime = async (options: {
  readonly work: WorkAdmission;
  readonly configurations: readonly TeamRoleConfiguration[];
  readonly pi: Harness;
  readonly storage: DurableObjectStorage;
  readonly metadata: MetadataTransaction;
  readonly models: MutableModels;
  readonly registry: Registry;
  readonly now?: () => number;
  readonly ensureWake: (deadlineAt: number) => Promise<void>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly submit: (
    nativeId: ConversationId,
    text: string,
    operationId: string
  ) => Promise<unknown>;
  readonly persistReportIn: (tx: Tx, report: WorkReport) => Promise<void>;
  readonly emitReport?: (report: WorkReport) => Promise<void>;
}) => {
  const { pi, work } = options;
  const now = options.now ?? Date.now;
  if (options.configurations.length !== 1 + work.limits.maxWorkers) {
    throw new InvalidInput({
      reason: "The team role configuration count changed.",
    });
  }
  const roleSessions = new Set<string>();
  for (const [index, configuration] of options.configurations.entries()) {
    const pin = index === 0 ? work.lead : work.worker;
    if (
      configuration.agent.agentId !== pin.agentId ||
      configuration.agent.version !== pin.agentVersion ||
      configuration.agent.organizationId !== work.key.organizationId ||
      configuration.address.agentId !== pin.agentId ||
      configuration.address.organizationId !== work.key.organizationId ||
      roleSessions.has(configuration.address.sessionId)
    ) {
      throw new InvalidInput({
        reason: "The team role configuration differs from its saved pin.",
      });
    }
    roleSessions.add(configuration.address.sessionId);
  }
  const roles = options.configurations.map((configuration) =>
    createTeamRole({ ...options, configuration, now })
  );
  const [lead] = roles;
  if (!lead) {
    throw new InvalidInput({
      reason: "The team lead configuration is missing.",
    });
  }
  const workers = roles.slice(1);
  const agents = roles.map((role, index) =>
    role.install(
      index === 0 ? [createTeamWorkerTool({ pi, lead, workers, now })] : []
    )
  );
  const task = createTeamAdmission({
    pi,
    work,
    now,
    deliver: async (command, nativeId, signal) => {
      await lead.permit(teamCommandDependencies(command), signal);
      await options.submit(nativeId, work.goal, workStartOperationId(work.key));
      if (command.kind === "input") {
        await options.submit(nativeId, command.text, command.id);
      }
    },
  });
  options.registry.install({ name: "cerebro-team-admission", tasks: [task] });
  const holdAdmissions = async (): Promise<void> => {
    const state = await pi.snapshot(TeamState, piContext());
    const pending = Object.values(state?.pending ?? {});
    if (pending.length > 0) {
      trackNativeProgress(pi, { tasks: pending }, options.waitUntil);
    }
  };
  const restore = async () => {
    const state = await pi.snapshot(TeamState, piContext());
    if (state?.lead) {
      await pi.commit(async (tx) => {
        const ids = [
          state.lead,
          ...state.workers.map((worker) => worker.nativeId),
        ];
        await Promise.all(
          ids.map(async (nativeId, index) => {
            const agent = agents[index];
            if (!nativeId || !agent) {
              throw new InvalidInput({
                reason: "The saved team role is missing.",
              });
            }
            await configure(tx, nativeId, agent);
          })
        );
      }, piContext());
    }
    if (
      state?.admission &&
      (!state.report || Object.keys(state.pending).length > 0)
    ) {
      await options.ensureWake(state.admission.deadlineAt);
    }
    await holdAdmissions();
  };
  const abort = async () => {
    const state = await pi.snapshot(TeamState, piContext());
    const ids = state?.lead
      ? [state.lead, ...state.workers.map((worker) => worker.nativeId)]
      : [];
    await Promise.all(
      ids.map(async (nativeId) => {
        const native = await pi.conversation(nativeId, piContext());
        await native?.abort(piContext());
      })
    );
    await Promise.all(
      Object.values(state?.pending ?? {}).map((taskId) =>
        pi.abortTask(taskId, piContext())
      )
    );
  };
  const receive = async (input: unknown) => {
    const command = Schema.decodeUnknownSync(TeamCommandSchema, {
      onExcessProperty: "error",
    })(input);
    if (canonicalToolArguments(command.work) !== canonicalToolArguments(work)) {
      throw new InvalidInput({
        reason: "The command addresses another team admission.",
      });
    }
    const previous = await pi.snapshot(TeamState, piContext());
    if (previous) {
      requireTeamAdmission(previous, command.work);
    }
    const digest = await digestToolArguments(command);
    let revoked = false;
    if (
      command.kind !== "cancel" &&
      previous?.phase !== "cancelled" &&
      previous?.phase !== "completed" &&
      previous?.phase !== "failed" &&
      work.deadlineAt > now()
    ) {
      try {
        await lead.admitDependencies(teamCommandDependencies(command));
      } catch (error) {
        if (!(error instanceof Denied)) {
          throw error;
        }
        revoked = true;
      }
    }
    await options.ensureWake(work.deadlineAt);
    const result = await pi.commit(async (tx) => {
      const state = await tx.doc(TeamState);
      requireTeamAdmission(state, command.work);
      const receipt = await tx.doc(TeamCommandReceipts, command.id, null);
      if (receipt.receipt) {
        if (receipt.receipt.digest !== digest) {
          throw new InvalidInput({
            reason: "The team command ID names another payload.",
          });
        }
        return {
          accepted: receipt.receipt.accepted,
          reason: receipt.receipt.reason,
        };
      }
      if (command.kind === "cancel") {
        if (state.phase !== "completed" && state.phase !== "failed") {
          state.phase = "cancelled";
        }
        receipt.receipt = {
          digest,
          taskId: null,
          accepted: true,
          reason: null,
        };
        return { accepted: true, reason: null };
      }
      if (revoked) {
        if (state.phase === "waiting") {
          state.phase = "failed";
        }
        receipt.receipt = {
          digest,
          taskId: null,
          accepted: false,
          reason: "revoked",
        };
        return { accepted: false, reason: "revoked" };
      }
      let reason: "cancelled" | "terminal" | "expired" | null = null;
      if (state.phase === "cancelled") {
        reason = "cancelled";
      } else if (state.phase === "completed" || state.phase === "failed") {
        reason = "terminal";
      } else if (work.deadlineAt <= now()) {
        reason = "expired";
      }
      if (reason) {
        receipt.receipt = { digest, taskId: null, accepted: false, reason };
        return { accepted: false, reason };
      }
      if (state.inputCount >= 8 || Object.keys(state.pending).length >= 8) {
        receipt.receipt = {
          digest,
          taskId: null,
          accepted: false,
          reason: "terminal",
        };
        return { accepted: false, reason: "terminal" };
      }
      if (!state.lead) {
        const natives = await Promise.all(
          agents.map(async (agent) => {
            const native = await tx.createConversation({
              ownership: { kind: "ownerless" },
            });
            await configure(tx, native.id, agent);
            return native.id;
          })
        );
        const [leadId] = natives;
        if (!leadId) {
          throw new InvalidInput({
            reason: "The lead conversation was not created.",
          });
        }
        state.lead = leadId;
        state.workers = natives.slice(1).map((nativeId) => ({
          nativeId,
          ownerTaskId: null,
          digest: null,
          requestId: null,
          inputDependencies: null,
        }));
      }
      state.phase = "running";
      state.inputCount += 1;
      lead.configuration.importDependencies(teamCommandDependencies(command));
      const taskId = await tx.createTask(task, command, {
        background: true,
        conversationId: state.lead,
        ownership: { kind: "conversation" },
      });
      state.pending[command.id] = taskId;
      const startId = workStartOperationId(work.key);
      if (!state.requests.includes(startId)) {
        state.requests.push(startId);
      }
      if (command.kind === "input") {
        state.requests.push(command.id);
      }
      receipt.receipt = { digest, taskId, accepted: true, reason: null };
      return { accepted: true, reason: null };
    }, piContext());
    await options.storage.sync();
    await holdAdmissions();
    if (command.kind === "cancel") {
      await abort();
    }
    pi.resume();
    return Schema.decodeUnknownSync(TeamCommandReceiptSchema)({
      commandId: command.id,
      key: work.key,
      kind: result.accepted ? "accepted" : "rejected",
      ...(result.reason ? { reason: result.reason } : {}),
    });
  };
  const wake = createTeamCompletion({
    pi,
    work,
    roles,
    now,
    abort,
    emitReport: options.emitReport,
    persistReportIn: options.persistReportIn,
    holdAdmissions,
  });
  await restore();
  return { receive, wake, abort, roles, task, restore };
};
export type TeamRuntime = Awaited<ReturnType<typeof createTeamRuntime>>;
