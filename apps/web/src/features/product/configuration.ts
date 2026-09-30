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
  const connectorIds = [
    ...new Set(
      toolChoices.flatMap((choice) =>
        toolIds.includes(choice.id) &&
        choice.connectorId &&
        !toolIds.includes(choice.connectorId)
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

export const agentEditorValues = (agent: AgentDetail | null) => ({
  catalog: {
    connectorChoices: agent?.connectorChoices ?? [],
    modelChoices: agent?.modelChoices ?? [],
    sourceChoices: agent?.sourceChoices ?? [],
  },
  instructions:
    agent?.definition.instructions ??
    "Answer company questions. Cite each source. Ask for approval before a controlled action.",
  model: agent?.definition.model ?? "",
  name: agent?.name ?? "",
  sourceIds:
    agent?.definition.grants
      .filter(
        (grant) => grant.resource.kind === "memory" && grant.action === "read"
      )
      .map((grant) => grant.resource.id) ?? [],
  toolIds: agent?.definition.enabledToolIds ?? [],
});
