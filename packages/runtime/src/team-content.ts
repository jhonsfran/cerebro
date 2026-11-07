import { id } from "@cerebro/contracts/identity";
import type { ContentDependencies } from "@cerebro/contracts/session";
import { digestToolArguments } from "@cerebro/contracts/tools";
import type { WorkAdmission } from "@cerebro/contracts/work";
import type { Harness } from "@earendil-works/pi-durable";

import { readImportedContent } from "./imported-content.ts";
import { piContext } from "./pi-harness.ts";
import { teamRoleKind } from "./team-composition.ts";
import { TeamState, requireTeamAdmission } from "./team-state.ts";

export type ReadTeamRoleImports = (
  roleIndex: number
) => Promise<ContentDependencies>;
export const teamRoleAddress = async (work: WorkAdmission, index: number) => {
  teamRoleKind(work, index);
  const digest = await digestToolArguments({ key: work.key, role: index });
  return {
    organizationId: work.key.organizationId,
    agentId: work.agent.agentId,
    conversationId: id.conversation(`team:${digest}`),
    sessionId: id.session(`team:${digest}`),
  };
};

export const readTeamRoleImports = async (
  pi: Harness,
  work: WorkAdmission,
  roleIndex: number
): Promise<ContentDependencies> => {
  const role = teamRoleKind(work, roleIndex);
  const state = await pi.snapshot(TeamState, piContext());
  if (state) {
    requireTeamAdmission(state, work);
  }
  const nativeId =
    role === "lead" ? state?.lead : state?.workers[roleIndex - 1]?.nativeId;
  return await readImportedContent(pi, nativeId ?? undefined);
};
