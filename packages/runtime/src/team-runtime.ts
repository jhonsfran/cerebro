import { Denied, InvalidInput } from "@cerebro/contracts/failures";
import { normalizeTeamCommand } from "@cerebro/contracts/team-events";
import {
  canonicalToolArguments,
  digestToolArguments,
} from "@cerebro/contracts/tools";
import {
  TeamCommandReceiptSchema,
  WorkAdmissionSchema,
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

import { importContentIn } from "./imported-content.ts";
import { trackNativeProgress } from "./native-progress.ts";
import { piContext } from "./pi-harness.ts";
import type { MetadataTransaction } from "./session-agent.ts";
import { createTeamAdmission } from "./team-admission.ts";
import { createTeamCompletion } from "./team-completion.ts";
import { requireRoleConfiguration } from "./team-composition.ts";
import type { TeamEvents } from "./team-events.ts";
import { createTeamRole } from "./team-role.ts";
import type { TeamRoleConfiguration } from "./team-role.ts";
import {
  TeamCommandReceipts,
  TeamState,
  requireTeamAdmission,
  teamChildren,
  teamCommandDependencies,
  teamConversationIds,
  teamInputRejection,
} from "./team-state.ts";
import { createTeamWorkerTool } from "./team-workers.ts";
import type { TeamWorker } from "./team-workers.ts";

export const createTeamRuntime = async (options: {
  readonly work: WorkAdmission;
  readonly configure: (index: number) => Promise<TeamRoleConfiguration>;
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
  readonly events?: TeamEvents;
}) => {
  const { pi } = options;
  const work = Schema.decodeUnknownSync(WorkAdmissionSchema, {
    onExcessProperty: "error",
  })(options.work);
  const now = options.now ?? Date.now;
  const role = async (index: number) => {
    const configuration = await options.configure(index);
    requireRoleConfiguration(work, configuration);
    return createTeamRole({ ...options, configuration, now });
  };
  const lead = await role(0);
  const openWorker = async (index: number): Promise<TeamWorker> => {
    const created = await role(index);
    return { ...created, agent: created.install() };
  };
  const workers = new Map<number, Promise<TeamWorker>>();
  const worker = async (index: number): Promise<TeamWorker> => {
    const opening = workers.get(index) ?? openWorker(index);
    workers.set(index, opening);
    try {
      return await opening;
    } catch (error) {
      workers.delete(index);
      throw error;
    }
  };
  const savedWorkers = async () => {
    const state = await pi.snapshot(TeamState, piContext());
    return await Promise.all(
      (state ? teamChildren(state) : []).map(async (child) => ({
        nativeId: child.nativeId,
        role: await worker(child.index),
      }))
    );
  };
  const reconcileLead = async () => {
    const current = await pi.snapshot(TeamState, piContext());
    if (
      current?.lead &&
      current.phase === "running" &&
      work.deadlineAt > now()
    ) {
      await lead.reconcileImports(current.lead, { kind: "handoff" });
    }
  };
  const leadAgent = lead.install([
    createTeamWorkerTool({
      lead,
      worker,
      maxWorkers: work.limits.maxWorkers,
      now,
    }),
    ...(options.events ? [options.events.tool(lead.permit)] : []),
  ]);
  const task = createTeamAdmission({
    pi,
    work,
    now,
    events: options.events,
    deliver: async (input, nativeId, signal) => {
      const { command, event } = normalizeTeamCommand(input);
      await lead.reconcileImports(nativeId, { kind: "handoff", signal });
      await lead.permit(teamCommandDependencies(command), signal);
      await options.submit(nativeId, work.goal, workStartOperationId(work.key));
      if (command.kind === "input") {
        await options.submit(
          nativeId,
          event
            ? `External event ${event.id}. Use return_event if it is unrelated to this work.\n${command.text}`
            : command.text,
          command.id
        );
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
    if (state) {
      requireTeamAdmission(state, work);
    }
    if (state?.lead) {
      const roles = [
        { nativeId: state.lead, role: { ...lead, agent: leadAgent } },
        ...(await savedWorkers()),
      ];
      await pi.commit(async (tx) => {
        await Promise.all(
          roles.map(({ nativeId, role: saved }) =>
            configure(tx, nativeId, saved.agent)
          )
        );
      }, piContext());
      if (state.phase === "running" && work.deadlineAt > now()) {
        await Promise.all(
          roles.map(({ nativeId, role: saved }) =>
            saved.reconcileImports(nativeId, { kind: "restore" })
          )
        );
      }
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
    await Promise.all(
      teamConversationIds(state).map(async (nativeId) => {
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
    const { command, wire, event } = normalizeTeamCommand(input);
    if (event && !options.events) {
      throw new InvalidInput({
        reason: "Team event delivery is not configured.",
      });
    }
    if (canonicalToolArguments(command.work) !== canonicalToolArguments(work)) {
      throw new InvalidInput({
        reason: "The command addresses another team admission.",
      });
    }
    const previous = await pi.snapshot(TeamState, piContext());
    if (previous) {
      requireTeamAdmission(previous, command.work);
    }
    const digest = await digestToolArguments(wire);
    const rejection = teamInputRejection(previous, work, now());
    if (wire.kind === "event-command" && options.events && rejection) {
      return await options.events.fallback(wire, rejection);
    }
    let revoked = false;
    if (command.kind !== "cancel" && !rejection) {
      try {
        await lead.admitDependencies(teamCommandDependencies(command));
      } catch (error) {
        if (!(error instanceof Denied)) {
          throw error;
        }
        revoked = true;
      }
    }
    if (revoked && wire.kind === "event-command" && options.events) {
      return await options.events.fallback(wire, "revoked");
    }
    await options.ensureWake(work.deadlineAt);
    const rejectedIn = async (
      tx: Tx,
      reason: "revoked" | "cancelled" | "terminal" | "expired"
    ) => {
      if (wire.kind === "event-command" && options.events) {
        await options.events.saveIn(tx, wire);
        await options.events.returnIn(
          tx,
          wire,
          "The subscribed work no longer accepts this event."
        );
      }
      return { digest, taskId: null, accepted: false, reason };
    };
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
        if (revoked) {
          throw new Denied({
            code: "revoked",
            reason: "Current access no longer permits this team handoff.",
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
      const reason = teamInputRejection(state, work, now());
      if (reason) {
        receipt.receipt = await rejectedIn(tx, reason);
        return { accepted: false, reason };
      }
      if (state.inputCount >= 8 || Object.keys(state.pending).length >= 8) {
        receipt.receipt = await rejectedIn(tx, "terminal");
        return { accepted: false, reason: "terminal" };
      }
      if (!state.lead) {
        const native = await tx.createConversation({
          ownership: { kind: "ownerless" },
        });
        await configure(tx, native.id, leadAgent);
        state.lead = native.id;
      }
      state.phase = "running";
      state.inputCount += 1;
      if (wire.kind === "event-command") {
        await options.events?.saveIn(tx, wire);
      }
      await importContentIn(tx, state.lead, teamCommandDependencies(command));
      const taskId = await tx.createTask(task, wire, {
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
    if (result.accepted && command.kind !== "cancel") {
      await reconcileLead();
    }
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
    roleDependencies: async () => {
      const saved = await savedWorkers();
      return await Promise.all(
        [lead, ...saved.map((child) => child.role)].map((member) =>
          member.dependencies()
        )
      );
    },
    now,
    abort,
    emitReport: options.emitReport,
    persistReportIn: options.persistReportIn,
    holdAdmissions,
  });
  await restore();
  return { receive, wake, abort, lead, worker, task, restore };
};
export type TeamRuntime = Awaited<ReturnType<typeof createTeamRuntime>>;
