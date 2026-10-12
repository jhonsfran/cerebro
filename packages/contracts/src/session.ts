import type { AgentId, OrganizationId, SourceId } from "./identity.ts";
import type { Action, Resource } from "./policy.ts";
import type { EffectOptions, PortResult, ReadOptions } from "./port.ts";

export interface ContentDependencies {
  readonly sourceIds: readonly SourceId[];
  readonly toolIds: readonly string[];
}

export interface AgentGrant {
  readonly action: Action;
  readonly resource: Resource;
}

export interface AgentDefinition {
  readonly organizationId: OrganizationId;
  readonly agentId: AgentId;
  readonly version: number;
  readonly instructions: string;
  readonly model: string;
  readonly enabledToolIds: readonly string[];
  readonly grants: readonly AgentGrant[];
}

export interface AgentRepository {
  readonly get: (
    organizationId: OrganizationId,
    agentId: AgentId,
    version: number | "latest",
    options: ReadOptions
  ) => Promise<PortResult<AgentDefinition>>;
  readonly publish: (
    definition: AgentDefinition,
    expectedVersion: number | undefined,
    options: EffectOptions
  ) => Promise<PortResult<AgentDefinition>>;
}
