export type BrandedId<Name extends string> = string & {
  readonly __brand: Name;
};

export type OrganizationId = BrandedId<"OrganizationId">;
export type AgentId = BrandedId<"AgentId">;
export type ConversationId = BrandedId<"ConversationId">;
export type SessionId = BrandedId<"SessionId">;
export type RunId = BrandedId<"RunId">;
export type ExecutionId = BrandedId<"ExecutionId">;
export type AnswerId = BrandedId<"AnswerId">;
export type EventId = BrandedId<"EventId">;
export type OperationId = BrandedId<"OperationId">;
export type PrincipalId = BrandedId<"PrincipalId">;
export type DelegationId = BrandedId<"DelegationId">;
export type ToolId = BrandedId<"ToolId">;
export type SourceId = BrandedId<"SourceId">;
export type ArtifactId = BrandedId<"ArtifactId">;
export type ReservationId = BrandedId<"ReservationId">;
export type Digest = BrandedId<"Digest">;

const parseId = <Name extends string>(value: string): BrandedId<Name> => {
  if (value.trim().length === 0 || value !== value.trim()) {
    throw new Error(
      "An identifier must be a nonempty string without surrounding whitespace."
    );
  }
  return value as BrandedId<Name>;
};

export const id = {
  agent: (value: string): AgentId => parseId<"AgentId">(value),
  answer: (value: string): AnswerId => parseId<"AnswerId">(value),
  artifact: (value: string): ArtifactId => parseId<"ArtifactId">(value),
  conversation: (value: string): ConversationId =>
    parseId<"ConversationId">(value),
  delegation: (value: string): DelegationId => parseId<"DelegationId">(value),
  digest: (value: string): Digest => parseId<"Digest">(value),
  event: (value: string): EventId => parseId<"EventId">(value),
  execution: (value: string): ExecutionId => parseId<"ExecutionId">(value),
  operation: (value: string): OperationId => parseId<"OperationId">(value),
  organization: (value: string): OrganizationId =>
    parseId<"OrganizationId">(value),
  principal: (value: string): PrincipalId => parseId<"PrincipalId">(value),
  reservation: (value: string): ReservationId =>
    parseId<"ReservationId">(value),
  run: (value: string): RunId => parseId<"RunId">(value),
  session: (value: string): SessionId => parseId<"SessionId">(value),
  source: (value: string): SourceId => parseId<"SourceId">(value),
  tool: (value: string): ToolId => parseId<"ToolId">(value),
} as const;

export interface Principal {
  readonly id: PrincipalId;
  readonly organizationId: OrganizationId;
  readonly kind: "human" | "service" | "agent";
  readonly state: "active" | "disabled";
}

export interface Delegation {
  readonly id: DelegationId;
  readonly organizationId: OrganizationId;
  readonly actorId: PrincipalId;
  readonly representedId: PrincipalId;
  readonly expiresAt: number;
}

export type ExecutionContext =
  | {
      readonly actor: Principal;
      readonly delegation?: never;
      readonly represented?: never;
    }
  | {
      readonly actor: Principal;
      readonly delegation: Delegation;
      readonly represented: Principal;
    };

// Adapters must derive this context from trusted credentials and current grants.
export const isExecutionContextActiveAt = (
  context: ExecutionContext,
  organizationId: OrganizationId,
  now: number
): boolean => {
  if (
    context.actor.state !== "active" ||
    context.actor.organizationId !== organizationId
  ) {
    return false;
  }
  if (!context.delegation) {
    return true;
  }
  return (
    context.represented.state === "active" &&
    context.represented.organizationId === organizationId &&
    context.delegation.organizationId === organizationId &&
    context.delegation.actorId === context.actor.id &&
    context.delegation.representedId === context.represented.id &&
    context.delegation.expiresAt > now
  );
};

export const sameExecutionContext = (
  first: ExecutionContext,
  second: ExecutionContext
): boolean => {
  const firstActor = first.actor;
  const secondActor = second.actor;
  if (
    firstActor.id !== secondActor.id ||
    firstActor.organizationId !== secondActor.organizationId ||
    firstActor.kind !== secondActor.kind ||
    firstActor.state !== secondActor.state
  ) {
    return false;
  }
  if (!first.delegation || !second.delegation) {
    return !first.delegation && !second.delegation;
  }
  return (
    first.delegation.id === second.delegation.id &&
    first.delegation.organizationId === second.delegation.organizationId &&
    first.delegation.actorId === second.delegation.actorId &&
    first.delegation.representedId === second.delegation.representedId &&
    first.delegation.expiresAt === second.delegation.expiresAt &&
    first.represented.id === second.represented.id &&
    first.represented.organizationId === second.represented.organizationId &&
    first.represented.kind === second.represented.kind &&
    first.represented.state === second.represented.state
  );
};
