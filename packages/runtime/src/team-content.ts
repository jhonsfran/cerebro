import { InvalidInput } from "@cerebro/contracts/failures";
import type { ContentDependencies } from "@cerebro/contracts/session";
import type { WorkAdmission } from "@cerebro/contracts/work";
import type { Harness } from "@earendil-works/pi-durable";

import { readImportedContent } from "./imported-content.ts";
import { piContext } from "./pi-harness.ts";
import { TeamState, requireTeamAdmission } from "./team-state.ts";

export type ReadTeamRoleImports = (
  roleIndex: number
) => Promise<ContentDependencies>;

export const readTeamRoleImports = async (
  pi: Harness,
  work: WorkAdmission,
  roleIndex: number
): Promise<ContentDependencies> => {
  if (
    !Number.isInteger(roleIndex) ||
    roleIndex < 0 ||
    roleIndex > work.limits.maxWorkers
  ) {
    throw new InvalidInput({ reason: "The team role index is invalid." });
  }
  const state = await pi.snapshot(TeamState, piContext());
  if (state) {
    requireTeamAdmission(state, work);
  }
  const nativeId =
    roleIndex === 0 ? state?.lead : state?.workers[roleIndex - 1]?.nativeId;
  return await readImportedContent(pi, nativeId ?? undefined);
};
