import { Denied, Unavailable } from "@cerebro/contracts/failures";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import { PrivateInspectionQuery } from "@cerebro/contracts/inspection";
import type { ContentDependencies } from "@cerebro/contracts/session";
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import { workCellName } from "@cerebro/contracts/work";
import type { WorkAdmission } from "@cerebro/contracts/work";
import { readRecordedContent } from "@cerebro/runtime/content-dependency-store";
import { piContext } from "@cerebro/runtime/pi-harness";
import type { Harness } from "@cerebro/runtime/pi-harness";
import {
  readTeamRoleImports,
  teamRoleAddress,
} from "@cerebro/runtime/team-content";
import { TeamState } from "@cerebro/runtime/team-state";
import { Schema } from "effect";

import type { WorkerEnv } from "../bindings";
import { runtimeConfiguration } from "../config";
import { requireInspectionRead } from "./inspection-access";
import { authenticateSessionRequest } from "./proof";

export const resolveTeamInspection = async (
  env: WorkerEnv,
  name: string | undefined,
  request: Request
) => {
  if (
    request.method !== "POST" ||
    new URL(request.url).pathname !== "/inspect"
  ) {
    throw new Denied({
      code: "unauthorized",
      reason: "Invalid private inspection route.",
    });
  }
  const parsed = Schema.decodeUnknownSync(PrivateInspectionQuery, {
    onExcessProperty: "error",
  })(await request.clone().json());
  const { work } = parsed;
  if (
    name !== workCellName(work.key) ||
    parsed.query.workId !== work.key.workId
  ) {
    throw new Denied({
      code: "unauthorized",
      reason: "The private inspection target changed.",
    });
  }
  const resolved = await authenticateSessionRequest(
    request,
    runtimeConfiguration(env).gatewaySigningKey,
    {
      organizationId: work.key.organizationId,
      ownerPrincipalId: work.key.ownerPrincipalId,
    }
  );
  if (
    canonicalToolArguments(resolved.address) !==
      canonicalToolArguments(work.sourceEventAddress) ||
    resolved.context.actor.id !== work.key.ownerPrincipalId ||
    "delegation" in resolved.context
  ) {
    throw new Denied({
      code: "unauthorized",
      reason: "The private inspection source changed.",
    });
  }
  return { ...parsed, context: resolved.context };
};
export const authorizeTeamInspection = async (
  env: WorkerEnv,
  storage: DurableObjectStorage,
  pi: Harness,
  work: WorkAdmission,
  context: ExecutionContext,
  signal?: AbortSignal
): Promise<void> => {
  const state = await pi.snapshot(TeamState, piContext(signal));
  if (!state?.admission) {
    throw new Unavailable({
      reason: "The private Team admission is not available yet.",
    });
  }
  if (
    canonicalToolArguments(state.admission) !== canonicalToolArguments(work)
  ) {
    throw new Denied({
      code: "unauthorized",
      reason: "The retained private admission changed.",
    });
  }
  const values: ContentDependencies[] = [
    work.contentDependencies,
    ...(state.report ? [state.report.contentDependencies] : []),
    ...state.workers.flatMap((worker) =>
      worker.inputDependencies ? [worker.inputDependencies] : []
    ),
  ];
  const roles = await Promise.all(
    Array.from({ length: work.limits.maxWorkers + 1 }, async (_, index) => {
      const address = await teamRoleAddress(work, index);
      const raw = await pi.commit(
        () => readRecordedContent(storage, address.sessionId),
        piContext(signal)
      );
      return { raw, canonical: await readTeamRoleImports(pi, work, index) };
    })
  );
  values.push(...roles.flatMap((role) => [role.raw, role.canonical]));
  await requireInspectionRead(env, {
    address: work.sourceEventAddress,
    context,
    signal,
    history: roles.flatMap((role) => role.raw.history),
    dependencies: {
      sourceIds: [...new Set(values.flatMap((value) => value.sourceIds))],
      toolIds: [...new Set(values.flatMap((value) => value.toolIds))],
    },
  });
};
