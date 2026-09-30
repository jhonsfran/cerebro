import type { AgentId, OrganizationId } from "@cerebro/contracts/identity";
import type { AgentDefinition } from "@cerebro/contracts/session";

export interface PinnedAgentConfig {
  readonly agentId: AgentId;
  readonly organizationId: OrganizationId;
  readonly version: number;
  readonly instructions: string;
  readonly model: string;
  readonly enabledToolIds: readonly string[];
  readonly grants?: AgentDefinition["grants"];
}

export const pinAgent = (definition: AgentDefinition): PinnedAgentConfig => ({
  agentId: definition.agentId,
  enabledToolIds: [...definition.enabledToolIds],
  grants: structuredClone(definition.grants),
  instructions: definition.instructions,
  model: definition.model,
  organizationId: definition.organizationId,
  version: definition.version,
});

export const isPinnedAgent = (value: unknown): value is PinnedAgentConfig => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.agentId === "string" &&
    typeof candidate.organizationId === "string" &&
    typeof candidate.version === "number" &&
    Number.isSafeInteger(candidate.version) &&
    candidate.version > 0 &&
    typeof candidate.instructions === "string" &&
    typeof candidate.model === "string" &&
    Array.isArray(candidate.enabledToolIds) &&
    candidate.enabledToolIds.every((toolId) => typeof toolId === "string")
  );
};
