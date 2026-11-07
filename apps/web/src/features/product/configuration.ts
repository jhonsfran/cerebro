import type { AgentDetail, Grant } from "./types";

export const agentExecutionGrants = (
  organizationId: string,
  toolIds: readonly string[],
  sourceIds: readonly string[],
  current: readonly Grant[] = [],
  toolChoices: readonly {
    readonly id: string;
    readonly connectorId?: string;
  }[] = []
): Grant[] => {
  const selectedToolIds = new Set(toolIds);
  const connectorIds = [
    ...new Set(
      toolChoices.flatMap((choice) =>
        selectedToolIds.has(choice.id) &&
        choice.connectorId &&
        !selectedToolIds.has(choice.connectorId)
          ? [choice.connectorId]
          : []
      )
    ),
  ];
  return [
    ...current.filter(
      (grant) =>
        !(
          (grant.resource.kind === "tool" &&
            (grant.action === "read" || grant.action === "execute")) ||
          (grant.resource.kind === "memory" && grant.action === "read")
        )
    ),
    ...toolIds.flatMap((toolId) =>
      (["read", "execute"] as const).map((action): Grant => ({
        action,
        resource: { id: toolId, kind: "tool", organizationId },
      }))
    ),
    ...connectorIds.map((connectorId): Grant => ({
      action: "execute",
      resource: { id: connectorId, kind: "tool", organizationId },
    })),
    ...sourceIds.map((sourceId): Grant => ({
      action: "read",
      resource: { id: sourceId, kind: "memory", organizationId },
    })),
  ];
};

const MS_PER_SECOND = 1000;
type TeamLimits = NonNullable<
  NonNullable<AgentDetail["definition"]["team"]>["limits"]
>;
export interface TeamBudgets {
  readonly maxTurns: string;
  readonly maxWorkers: string;
  readonly timeoutSeconds: string;
}
const teamBudgets = (limits: TeamLimits | undefined): TeamBudgets => ({
  maxTurns: limits?.maxTurns?.toString() ?? "",
  maxWorkers: limits?.maxWorkers?.toString() ?? "",
  timeoutSeconds:
    limits?.timeoutMs === undefined
      ? ""
      : String(limits.timeoutMs / MS_PER_SECOND),
});
export const agentTeamSection = (
  budgets: TeamBudgets
): { limits: TeamLimits } | undefined => {
  const limits: TeamLimits = {
    ...(budgets.maxTurns.trim() ? { maxTurns: Number(budgets.maxTurns) } : {}),
    ...(budgets.maxWorkers.trim()
      ? { maxWorkers: Number(budgets.maxWorkers) }
      : {}),
    ...(budgets.timeoutSeconds.trim()
      ? {
          timeoutMs: Math.round(Number(budgets.timeoutSeconds) * MS_PER_SECOND),
        }
      : {}),
  };
  return Object.keys(limits).length > 0 ? { limits } : undefined;
};

export const agentEditorValues = (agent: AgentDetail | null) => {
  const catalog = {
    connectorChoices: agent?.connectorChoices ?? [],
    modelChoices: agent?.modelChoices ?? [],
    sourceChoices: agent?.sourceChoices ?? [],
  };
  const modelIds = new Set(catalog.modelChoices.map((choice) => choice.id));
  const toolIds = new Set(catalog.connectorChoices.map((choice) => choice.id));
  const sourceIds = new Set(catalog.sourceChoices.map((choice) => choice.id));
  const definition = agent?.definition ?? {
    enabledToolIds: [],
    grants: [],
    instructions:
      "Answer company questions. Cite each source. Ask for approval before a controlled action.",
    model: "",
  };
  const selectedSources = definition.grants
    .filter(
      (grant) => grant.resource.kind === "memory" && grant.action === "read"
    )
    .map((grant) => grant.resource.id);
  const selectedTools = definition.enabledToolIds;
  const unavailableModel =
    agent && !modelIds.has(definition.model) ? definition.model : null;
  return {
    catalog,
    instructions: definition.instructions,
    model:
      unavailableModel === null
        ? definition.model
        : (catalog.modelChoices[0]?.id ?? ""),
    name: agent?.name ?? "",
    sourceIds: selectedSources.filter((id) => sourceIds.has(id)),
    team: teamBudgets(agent?.definition.team?.limits),
    toolIds: selectedTools.filter((id) => toolIds.has(id)),
    unavailableSelections: {
      model: unavailableModel,
      sourceIds: selectedSources.filter((id) => !sourceIds.has(id)),
      toolIds: selectedTools.filter((id) => !toolIds.has(id)),
    },
  };
};
