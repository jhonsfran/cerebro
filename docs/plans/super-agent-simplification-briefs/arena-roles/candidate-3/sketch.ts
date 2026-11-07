/**
 * Candidate 3: team configuration lives on the published AgentDefinition.
 *
 * Publishing an agent is the only configuration step. The admission pins the
 * coordinator agent's version plus a resolved limits snapshot. The Team cell
 * derives the lead and worker definitions from that one pinned row and a
 * system-owned role overlay. runtime.json `coordination` keeps only limits
 * defaults. No second or third published agent exists anywhere.
 *
 * Sections follow the module map in rationale.md. Bodies are `not implemented`;
 * `// TODO` lines are pseudocode. Signatures that do not change are omitted.
 */

import { Effect, Schema } from "effect";

// ---------------------------------------------------------------------------
// 1. packages/contracts/src/session.ts  (delta)
// ---------------------------------------------------------------------------

export type TeamRoleName = "lead" | "worker";

/**
 * Per-role overrides a person publishes with the agent. Every field is
 * optional; absent means "same as the agent". `model` must be a configured
 * model id and is entitled exactly like `AgentDefinition.model`.
 */
export interface TeamRoleOverride {
  readonly model?: string;
  /** Appended after the agent's instructions for this role only. */
  readonly instructions?: string;
}

/**
 * Per-team budgets. `maxTeams` is deliberately absent: it is per-person
 * concurrency across all of that person's agents, owned by the installation.
 */
export interface TeamBudget {
  readonly maxWorkers?: number;
  readonly maxTurns?: number;
  readonly timeoutMs?: number;
}

export interface AgentTeamSection {
  readonly lead?: TeamRoleOverride;
  readonly worker?: TeamRoleOverride;
  readonly limits?: TeamBudget;
}

export interface AgentDefinition {
  readonly organizationId: string; // OrganizationId
  readonly agentId: string; // AgentId
  readonly version: number;
  readonly instructions: string;
  readonly model: string;
  readonly enabledToolIds: readonly string[];
  readonly grants: readonly { readonly action: string; readonly resource: unknown }[];
  /**
   * Optional. Stored inside the same JSONB `agent_version.definition`; rows
   * published before this change decode without it and receive defaults.
   * Pinned by version with everything else, so a republish never changes an
   * in-flight Team's roles or budgets.
   */
  readonly team?: AgentTeamSection;
}

// ---------------------------------------------------------------------------
// 2. packages/contracts/src/team.ts  (new)
// ---------------------------------------------------------------------------

declare const WorkLimitsSchema: Schema.Struct<{
  maxTeams: Schema.Int;
  maxTurns: Schema.Int;
  maxWorkers: Schema.Int;
  timeoutMs: Schema.Int;
}>; // unchanged, from ./work.ts; caps stay (constraint 5)
export type WorkLimits = typeof WorkLimitsSchema.Type;

const modelId = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(512)
);
const roleText = Schema.NonEmptyString.check(Schema.isMaxLength(16_000));
const TeamRoleOverrideSchema = Schema.Struct({
  model: Schema.optional(modelId),
  instructions: Schema.optional(roleText),
});

/**
 * Validated once, at publish (channels service, `onExcessProperty: "error"`).
 * Inside the system the stored definition is trusted, as `AgentDefinition`
 * already is today. Same `satisfies` pattern as BoundedContentDependenciesSchema.
 */
export const AgentTeamSectionSchema = Schema.Struct({
  lead: Schema.optional(TeamRoleOverrideSchema),
  worker: Schema.optional(TeamRoleOverrideSchema),
  limits: Schema.optional(
    Schema.Struct({
      maxWorkers: Schema.optional(WorkLimitsSchema.fields.maxWorkers),
      maxTurns: Schema.optional(WorkLimitsSchema.fields.maxTurns),
      timeoutMs: Schema.optional(WorkLimitsSchema.fields.timeoutMs),
    })
  ),
}) satisfies Schema.Codec<AgentTeamSection>;

/**
 * The runtime.json `coordination` block after this change: limits defaults
 * only. Decoding `{}` yields today's defaults, so the block is optional and
 * Teams work with no block at all. Replaces CoordinationProfileSchema.
 */
export const TeamDefaultsSchema = Schema.Struct({
  maxTeams: WorkLimitsSchema.fields.maxTeams.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(2))
  ),
  maxWorkers: WorkLimitsSchema.fields.maxWorkers.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(2))
  ),
  maxTurns: WorkLimitsSchema.fields.maxTurns.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(8))
  ),
  timeoutMs: WorkLimitsSchema.fields.timeoutMs.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(600_000))
  ),
});
export type TeamDefaults = typeof TeamDefaultsSchema.Type;

/**
 * Every model a definition may run: its own plus each role override, agent
 * model first, deduplicated. This is the single source for "is this model
 * entitled for this agent" (apps/server access.ts) and for role composition
 * (runtime team-roles.ts). Nothing else lists models.
 */
export const agentModels = (
  _definition: AgentDefinition
): readonly string[] => {
  // TODO [...new Set([definition.model, definition.team?.lead?.model,
  //        definition.team?.worker?.model].filter((m) => m !== undefined))]
  throw new Error("not implemented");
};

/** The model one role runs. Absent override means the agent's own model. */
export const teamRoleModel = (
  _definition: AgentDefinition,
  _role: TeamRoleName
): string => {
  // TODO definition.team?.[role]?.model ?? definition.model
  throw new Error("not implemented");
};

/**
 * Agent budgets win over installation defaults, field by field. `maxTeams`
 * always comes from the installation. The result is re-validated against
 * WorkLimitsSchema when the admission is decoded, so schema caps still bind.
 */
export const resolveWorkLimits = (
  _definition: AgentDefinition,
  _defaults: TeamDefaults
): WorkLimits => {
  // TODO {
  //   maxTeams: defaults.maxTeams,
  //   maxWorkers: definition.team?.limits?.maxWorkers ?? defaults.maxWorkers,
  //   maxTurns: definition.team?.limits?.maxTurns ?? defaults.maxTurns,
  //   timeoutMs: definition.team?.limits?.timeoutMs ?? defaults.timeoutMs,
  // }
  throw new Error("not implemented");
};

// ---------------------------------------------------------------------------
// 3. packages/contracts/src/work.ts  (delta)
// ---------------------------------------------------------------------------

declare const identifier: <Name extends string>() => Schema.Codec<string>;
declare const text: Schema.Codec<string>;
declare const timestamp: Schema.Codec<number>;
declare const WorkKeySchema: Schema.Codec<unknown>;
declare const BoundedContentDependenciesSchema: Schema.Codec<unknown>;
declare const SourceEventAddressSchema: Schema.Codec<{
  agentId: string;
  conversationId: string;
  organizationId: string;
  sessionId: string;
}>;

/** Renamed from RolePinSchema: it pins the agent, not a role. */
export const AgentPinSchema = Schema.Struct({
  agentId: identifier<"AgentId">(),
  agentVersion: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
  ),
});
export type AgentPin = typeof AgentPinSchema.Type;

// DELETED: CoordinationProfileSchema, RolePinSchema, LegacySlackWorkAdmissionSchema,
//          WorkAdmissionV2Schema, the Schema.Union around WorkAdmissionSchema.

/**
 * v3. Roles are no longer pinned individually. The Team is composed from the
 * coordinator agent's `agentVersion`; its id is `sourceEventAddress.agentId`,
 * so there is no second id field to keep in sync. `limits` is the resolved
 * snapshot (agent budgets over installation defaults) taken at admission.
 * Invariants unchanged: key org matches source org; deadline within timeoutMs.
 */
const WorkAdmissionV3Schema = Schema.Struct({
  version: Schema.Literal(3),
  admittedAt: timestamp,
  contentDependencies: BoundedContentDependenciesSchema,
  deadlineAt: timestamp,
  goal: text,
  key: WorkKeySchema,
  agentVersion: AgentPinSchema.fields.agentVersion,
  limits: WorkLimitsSchema,
  sourceEventAddress: SourceEventAddressSchema,
});
export const WorkAdmissionSchema = WorkAdmissionV3Schema;
export type WorkAdmission = typeof WorkAdmissionSchema.Type;

/** The one pin every role shares. Used by the Inspector and the Team cell read. */
export const admittedAgent = (_work: WorkAdmission): AgentPin => {
  // TODO { agentId: work.sourceEventAddress.agentId, agentVersion: work.agentVersion }
  throw new Error("not implemented");
};

// ---------------------------------------------------------------------------
// 4. packages/contracts/src/inspection.ts  (delta)
// ---------------------------------------------------------------------------

/** `definition: RolePinSchema` becomes `role`; the pin moves up to the team. */
export const InspectionRoleDelta = Schema.Struct({
  slot: Schema.Literals([0, 1, 2]),
  role: Schema.Literals(["lead", "worker"]),
  modelId: Schema.NullOr(Schema.String), // unchanged: constraint 4, read from Pi AgentDoc
  // ...running, ownerTaskId, requestId, usage, toolUsage, attempt, retryAt unchanged
});
export const InspectionTeamAvailableDelta = Schema.Struct({
  kind: Schema.Literal("available"),
  /** Which published version every role was composed from. */
  agent: AgentPinSchema,
  // ...cell, phase, sealed, requestReservations, requestLimit, roles, result, monetaryCost unchanged
});

// ---------------------------------------------------------------------------
// 5. packages/runtime/src/team-roles.ts  (new)
// ---------------------------------------------------------------------------

/**
 * System-owned overlay. Lives in runtime because it names runtime tools
 * (`delegate_worker`). Not configurable; agent authors add to it through
 * `team.<role>.instructions`, never replace it.
 */
export const TEAM_ROLE_OVERLAY: Readonly<Record<TeamRoleName, string>> = {
  lead:
    "You lead a background Team acting for this agent. Your tools are read-only. Split the goal into bounded questions, call delegate_worker for each, combine the answers, and finish with one complete answer. Nobody will reply to questions.",
  worker:
    "You are a Team worker acting for this agent. Answer the one question you receive using read-only tools. Do not delegate.",
};

export interface TeamRoleDefinition {
  readonly role: TeamRoleName;
  /** 0 is the lead; 1.. are workers. Matches teamRoleAddress and TeamState.workers[index - 1]. */
  readonly index: number;
  /** Projection of the pinned definition for this role. See invariants on teamRoleDefinition. */
  readonly agent: AgentDefinition;
}

/** overlay, then the agent's instructions, then the optional role addendum. */
export const composeRoleInstructions = (
  _definition: AgentDefinition,
  _role: TeamRoleName
): string => {
  // TODO [TEAM_ROLE_OVERLAY[role], definition.instructions,
  //       definition.team?.[role]?.instructions].filter(Boolean).join("\n\n")
  throw new Error("not implemented");
};

/**
 * Invariants, encoded by construction (the function copies, it never widens):
 *  - organizationId, agentId, version, enabledToolIds, grants are identical
 *    to the source. A role cannot hold more than the agent (constraint 2).
 *  - model = teamRoleModel(definition, role); instructions = composeRoleInstructions.
 *  - `team` is omitted from the projection: a role definition is not itself
 *    a team definition, so agentModels(role.agent) === [role model].
 * The projection is what createExecutionComposition receives and what every
 * authority request names as `pinnedAgent`, so pinnedDenial's
 * `model === pinnedAgent.model` holds for a stronger lead with no authority change.
 */
export const teamRoleDefinition = (
  _definition: AgentDefinition,
  _role: TeamRoleName
): AgentDefinition => {
  throw new Error("not implemented");
};

/** Length is 1 + maxWorkers; nothing here assumes two workers (constraint 5). */
export const teamRoleDefinitions = (
  _definition: AgentDefinition,
  _maxWorkers: number
): readonly TeamRoleDefinition[] => {
  // TODO [lead, ...Array.from({ length: maxWorkers }, worker)].map((role, index) =>
  //        ({ role, index, agent: teamRoleDefinition(definition, role) }))
  throw new Error("not implemented");
};

// ---------------------------------------------------------------------------
// 6. packages/runtime/src/coordinator-work.ts  (delta)
// ---------------------------------------------------------------------------

export interface TeamPin {
  readonly agentVersion: number;
  readonly limits: WorkLimits;
}

/** Replaces `profile` and `resolveRolePins`. */
export interface CoordinationServices {
  readonly ownerPrincipalId: string; // PrincipalId
  /** Installation defaults. `maxTeams` and the admissions wake timeout read from here. */
  readonly defaults: TeamDefaults;
  /**
   * Authorizes `execute` under current permissions for the coordinator
   * definition this conversation runs and for each role definition with a
   * distinct model, then returns what the admission pins. No PostgreSQL agent
   * read: the pinned definition is already in hand. Denial here surfaces to
   * the person at `start_team` instead of silently in the cell.
   */
  readonly pinTeam: (signal?: AbortSignal) => Promise<TeamPin>;
  readonly contentDependencies: () => Promise<unknown>; // ContentDependencies
  readonly sendCommand: (command: unknown) => Promise<void>; // TeamCommandTransport
}

/** Inside createCoordinatorWork.start(); only the admission construction changes. */
export const startAdmissionSketch = (): void => {
  // TODO const [pinned, contentDependencies] = await Promise.all([
  //        services.pinTeam(context.abortSignal), services.contentDependencies()]);
  // TODO queued = queue.length > 0 || activeCount >= pinned.limits.maxTeams
  // TODO admission = decode(WorkAdmissionSchema, { onExcessProperty: "error" })({
  //        version: 3, admittedAt, contentDependencies,
  //        deadlineAt: admittedAt + pinned.limits.timeoutMs, goal, key,
  //        agentVersion: pinned.agentVersion, limits: pinned.limits,
  //        sourceEventAddress: source.address })
  // TODO createCoordinatorAdmissions({ ..., timeoutMs: services.defaults.timeoutMs })
  // promoteIn keeps reading record.admission.limits.maxTeams (unchanged).
  throw new Error("not implemented");
};

// ---------------------------------------------------------------------------
// 7. packages/runtime/src/team-content.ts, team-runtime.ts, team-inspection.ts  (deltas)
// ---------------------------------------------------------------------------

/** Signature unchanged; `agentId` now comes from work.sourceEventAddress.agentId. */
export const teamRoleAddress = (
  _work: WorkAdmission,
  _index: number
): Promise<{
  organizationId: string;
  agentId: string;
  conversationId: string;
  sessionId: string;
}> => {
  throw new Error("not implemented");
};

/**
 * Replaces the inline pin loop in createTeamRuntime. Every configuration must
 * name the admitted agent and version, the work's organization, and a unique
 * session id. Count must equal 1 + work.limits.maxWorkers.
 */
export const requireRoleConfigurations = (
  _work: WorkAdmission,
  _configurations: readonly { agent: AgentDefinition; address: { agentId: string; organizationId: string; sessionId: string } }[]
): void => {
  throw new Error("not implemented");
};

/** readRole: `role: slot === 0 ? "lead" : "worker"`. readSummary: `agent: admittedAgent(work)`. */

// ---------------------------------------------------------------------------
// 8. apps/server/src/config.ts  (delta)
// ---------------------------------------------------------------------------

/**
 * `coordination` is optional in the file and always present after parsing.
 * `leadAgentId` and `workerAgentId` are accepted and dropped for one release,
 * like `maxRequestsPerRun`, so an upgraded installation's bootstrap does not
 * fail on its existing runtime.json.
 */
export const parseCoordinationDefaults = (_value: unknown): TeamDefaults => {
  // TODO const { leadAgentId: _l, workerAgentId: _w, ...rest } = (value ?? {}) as Record<string, unknown>;
  // TODO return Schema.decodeUnknownSync(TeamDefaultsSchema, { onExcessProperty: "error" })(rest);
  throw new Error("not implemented");
};
// RuntimeConfiguration.coordination: TeamDefaults   (no longer optional in the type)

// ---------------------------------------------------------------------------
// 9. apps/server/src/session/coordination.ts  (delta)
// ---------------------------------------------------------------------------

/**
 * Returns undefined only when the conversation is not a coordinator
 * conversation. `profile` is gone; `defaults` always exists. `agent` is the
 * pinned version this conversation is executing (createRuntimeComposition
 * already loaded and authorized it), so admission makes no agent reads.
 */
export const createCoordinatorServices = (_options: {
  readonly env: unknown; // WorkerEnv
  readonly address: unknown; // EventAddress
  readonly agent: AgentDefinition;
  readonly authority: unknown; // AuthorityService
  readonly conversation: unknown; // channelConversation row
  readonly defaults: TeamDefaults;
  readonly contentDependencies: () => Promise<unknown>;
  readonly slack?: unknown; // SlackConfiguration
  readonly ownerContext: () => unknown; // Effect<ExecutionContext>
}): CoordinationServices | undefined => {
  // TODO pinTeam: async (signal) => {
  //   context = ownerContext(); require actor === ownerPrincipalId && org matches;
  //   limits = resolveWorkLimits(agent, defaults);
  //   roles = teamRoleDefinitions(agent, limits.maxWorkers); distinct = unique by agent.model;
  //   for (definition of [agent, ...distinct.map((r) => r.agent)])
  //     await authority.require({ action: "execute", address, context,
  //       pinnedAgent: definition, model: definition.model,
  //       resource: { kind: "agent", id: agent.agentId, organizationId } }, readOptions);
  //   return { agentVersion: agent.version, limits };
  // }
  throw new Error("not implemented");
};
// createRuntimeComposition passes `defaults: config.coordination` instead of `profile`.
// DELETED: resolveRolePins and its two latest-version loads and execute checks.

// ---------------------------------------------------------------------------
// 10. apps/server/src/team-agent.ts  (delta)
// ---------------------------------------------------------------------------

/**
 * One PostgreSQL read by pinned version, then pure derivation. Re-running
 * after a cell restart recomposes byte-identical roles: the overlay is a
 * constant and agent versions are append-only. No role snapshot is stored.
 */
export const configureSketch = async (
  _work: WorkAdmission,
  _metadata: unknown, // MetadataTransaction
  _importedDependencies: (index: number) => Promise<unknown>
): Promise<readonly unknown[]> /* TeamRoleConfiguration[] */ => {
  // TODO agent = fromPortResult(repository.get(work.key.organizationId,
  //        work.sourceEventAddress.agentId, work.agentVersion, deadline))
  // TODO return Promise.all(teamRoleDefinitions(agent, work.limits.maxWorkers).map(
  //        async ({ index, agent: role }) => createExecutionComposition(env, storage,
  //          work.sourceEventAddress, await teamRoleAddress(work, index), role,
  //          work.key.ownerPrincipalId, metadata, /* readOnly */ true,
  //          () => importedDependencies(index))))
  throw new Error("not implemented");
};
// resolve(): the gate becomes `if (!isCoordinatorConversation(conversation, slack))`;
// `!config.coordination ||` is deleted.

// ---------------------------------------------------------------------------
// 11. apps/server/src/access.ts  (delta)  — the only authorization edit
// ---------------------------------------------------------------------------

/**
 * createCurrentEntitlements, `kind === "model"` branch:
 *   allowed = agentModels(current.value).includes(request.model)
 *          && configured.models.some((model) => model.id === request.model)
 * "Current permissions still apply": a republish that drops a role model
 * denies that role's next model call, exactly as a changed `model` does today.
 * pinnedDenial is untouched because each role's pinnedAgent is its own projection.
 */
export const entitlementModelCheckSketch = (): void => {
  throw new Error("not implemented");
};

// ---------------------------------------------------------------------------
// 12. packages/channels/src/service.ts  (delta)  — the publish boundary
// ---------------------------------------------------------------------------

export interface AgentInput {
  readonly operationId: string;
  readonly name: string;
  readonly instructions: string;
  readonly model: string;
  readonly enabledToolIds: readonly string[];
  readonly grants: readonly unknown[]; // AgentGrant[]
  readonly expectedVersion?: number;
  /** Raw from the request; decoded with AgentTeamSectionSchema inside publishAgent. */
  readonly team?: unknown;
}

/**
 * publishAgent additions (validate at the boundary, trust inside):
 *  - team = input.team === undefined ? undefined
 *         : decode(AgentTeamSectionSchema, { onExcessProperty: "error" })(input.team)
 *  - every id in agentModels({ ...definition, team }) must be in configured.modelChoices
 *    (replaces the single `input.model` check)
 *  - definition.team = team; `team` participates in requestDigest via `definition`
 */
export const publishAgentDelta = (): void => {
  throw new Error("not implemented");
};

// ---------------------------------------------------------------------------
// 13. apps/web/src/features/product  (deltas)
// ---------------------------------------------------------------------------

/**
 * types.ts: agentDetailSchema.definition gains `team: teamSectionSchema.optional()`.
 * This is load-bearing: `z.object` strips unknown keys, so an undeclared `team`
 * would be dropped on read and silently deleted by the next publish.
 */
export interface AgentEditorTeamValues {
  readonly leadModel: string | null; // null = same as agent
  readonly workerModel: string | null;
  readonly leadInstructions: string;
  readonly workerInstructions: string;
  readonly maxWorkers: number | null; // null = installation default
  readonly maxTurns: number | null;
  readonly timeoutMs: number | null;
}

/** configuration.ts: agentEditorValues returns `team` and reports unavailable role models beside `unavailableSelections.model`. */
export const agentEditorTeamValues = (
  _definition: AgentDefinition | null,
  _modelChoices: readonly { id: string }[]
): { team: AgentEditorTeamValues; unavailableTeamModels: readonly string[] } => {
  throw new Error("not implemented");
};

/** Inverse: all-null values produce `undefined`, so an untouched section publishes no `team` key. */
export const agentTeamSectionFromEditor = (
  _values: AgentEditorTeamValues
): AgentTeamSection | undefined => {
  throw new Error("not implemented");
};

// agent-editor.tsx: a collapsed "Teams" FieldSet with two model selects (first
// item "Same as agent"), two textareas, three numeric fields; the save input
// always carries `team: agentTeamSectionFromEditor(values)`.
// inspection-role.tsx: per role ["Role", role.role] and ["Saved model", role.modelId];
// at team level ["Agent", team.agent.agentId] and ["Definition version", team.agent.agentVersion].

// ---------------------------------------------------------------------------
// Deleted by this change
// ---------------------------------------------------------------------------
// contracts/work.ts: CoordinationProfileSchema, RolePinSchema (renamed), legacy
//   and v2 admission schemas and their union.
// runtime/coordinator-work.ts: CoordinationServices.profile, resolveRolePins.
// server/session/coordination.ts: resolveRolePins body (two latest loads, two execute checks),
//   the `!profile` early return.
// server/team-agent.ts: the per-role repository loads in configure; the config.coordination gate.
// docs: agent-teams.md steps 4-6 (three agents, agent IDs, bootstrap restart);
//   runtime-configuration.md Coordination table rows leadAgentId/workerAgentId.
// tests: tests/runtime/{fixture-coordinator,coordinator-fixture}.ts and
//   tests/channels/native/{team-support,web-team-support}.ts stop publishing lead/worker agents.
