import { Denied, InvalidInput } from "@cerebro/contracts/failures";
import { digestToolArguments } from "@cerebro/contracts/tools";
import { TeamCommandReceiptSchema } from "@cerebro/contracts/work";
import type { TeamCommand, WorkAdmission } from "@cerebro/contracts/work";
import type { Harness, Registry } from "@earendil-works/pi-durable";
import { Schema } from "effect";

import { piContext } from "./pi-harness.ts";
import { createTeamAdmission } from "./team-admission.ts";
import {
  TeamCommandReceipts,
  TeamState,
  requireTeamAdmission,
} from "./team-state.ts";

export const expireTeam = async (
  pi: Harness,
  registry: Registry,
  work: WorkAdmission
): Promise<void> => {
  const task = createTeamAdmission({
    pi,
    work,
    now: Date.now,
    deliver: () =>
      Promise.reject(
        new Denied({ code: "revoked", reason: "The team deadline expired." })
      ),
  });
  registry.install({ name: "cerebro-team-admission", tasks: [task] });
  await pi.commit(async (tx) => {
    const state = await tx.doc(TeamState);
    requireTeamAdmission(state, work);
    if (state.phase === "running" || state.phase === "waiting") {
      state.phase = "failed";
    }
  }, piContext());
  const state = await pi.snapshot(TeamState, piContext());
  pi.resume();
  const ids = state?.lead
    ? [state.lead, ...state.workers.map((worker) => worker.nativeId)]
    : [];
  await Promise.all(
    ids.map(async (id) => {
      const native = await pi.conversation(id, piContext());
      await native?.abort(piContext(), { background: true });
    })
  );
  await Promise.all(
    Object.values(state?.pending ?? {}).map((taskId) =>
      pi.abortTask(taskId, piContext())
    )
  );
};

export const receiveExpiredTeam = async (
  pi: Harness,
  registry: Registry,
  command: TeamCommand
) => {
  const digest = await digestToolArguments(command);
  const result = await pi.commit(async (tx) => {
    const state = await tx.doc(TeamState);
    requireTeamAdmission(state, command.work);
    const document = await tx.doc(TeamCommandReceipts, command.id, null);
    if (document.receipt) {
      if (document.receipt.digest !== digest) {
        throw new InvalidInput({
          reason: "The team command ID names another payload.",
        });
      }
      return {
        accepted: document.receipt.accepted,
        reason: document.receipt.reason,
      };
    }
    const accepted = command.kind === "cancel";
    document.receipt = {
      digest,
      taskId: null,
      accepted,
      reason: accepted ? null : "expired",
    };
    return { accepted, reason: accepted ? null : "expired" };
  }, piContext());
  await expireTeam(pi, registry, command.work);
  return Schema.decodeUnknownSync(TeamCommandReceiptSchema)({
    commandId: command.id,
    key: command.work.key,
    kind: result.accepted ? "accepted" : "rejected",
    ...(result.reason ? { reason: result.reason } : {}),
  });
};
