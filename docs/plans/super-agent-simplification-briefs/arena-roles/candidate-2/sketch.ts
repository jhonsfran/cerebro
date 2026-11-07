/**
 * Candidate 2: the admission carries the Team's COMPOSITION, not the agent's
 * DEFINITION.
 *
 * Composition = which agent version, which model per role, which limits.
 * Definition  = instructions, enabledToolIds, grants: stays in its immutable
 *               `agent_version` row in PostgreSQL.
 *
 * The starting direction (snapshot the whole definition into the admission so
 * the Team cell needs no PostgreSQL read) was dropped after reading the code:
 *   - `assertQueuePayloadSize` bounds every queue payload at 120 000 bytes and
 *     the admission rides inside every TeamCommand (start, input, cancel) and
 *     every PrivateInspectionQuery, next to a 16 000-char goal and a
 *     16 000-char input text. Instructions plus a few hundred grants would
 *     make `message_team` fail with 413 after a successful `start_team`.
 *   - `pinnedDenial` treats `pinnedAgent.grants`/`enabledToolIds` as the
 *     ceiling. A snapshot moves that ceiling from an immutable row to a queue
 *     payload; the cell would have to re-read the row to trust it.
 *   - The cell talks to PostgreSQL on every authority check anyway
 *     (`checkSession`, `createCurrentEntitlements`, `ownerContext`, catalog,
 *     skills). A PostgreSQL-free compose buys nothing.
 *
 * What survives: the admission records the DECISION (version, role models,
 * limits); the pinned row is the CEILING; the latest row plus runtime config
 * are the LIVE GATE. One pure function turns (pinned row, role) into the
 * AgentDefinition a role runs as, and the same function is what the
 * coordinator authorizes at admission.
 *
 * Module map (changed files only):
 *   packages/contracts/src/work.ts              TeamCompositionSchema, TeamDefaultsSchema,
 *                                               WorkAdmission v3; CoordinationProfileSchema deleted
 *   packages/runtime/src/team-composition.ts    NEW: TeamRole, teamRoles, teamRole,
 *                                               composeRoleDefinition, composeTeam, ROLE_OVERLAY
 *   packages/runtime/src/team-content.ts        teamRoleAddress / readTeamRoleImports use teamRole()
 *   packages/runtime/src/team-runtime.ts        validates configurations against work.team
 *   packages/runtime/src/team-inspection.ts     definition = work.team.agent for every slot
 *   packages/runtime/src/coordinator-work.ts    CoordinationServices { limits, resolveTeam }
 *   apps/server/src/session/coordination.ts     createCoordinatorServices without a profile; resolveTeam
 *   apps/server/src/session/agent.ts            passes config.coordination (always present)
 *   apps/server/src/team-agent.ts               configure(): one pinned read; resolve(): no coordination gate
 *   apps/server/src/session/team-inspection.ts  iterates teamRoles(work)
 *   apps/server/src/config.ts                   coordination decodes to TeamDefaults; {} when absent;
 *                                               leadModel must be a configured model id
 *   apps/server/src/access.ts                   createCurrentEntitlements accepts the configured lead model
 *   docs/operations/agent-teams.md              one agent, no profile, no IDs to copy
 *   docs/reference/runtime-configuration.md     Coordination section becomes optional defaults
 *   docs/architecture/slack-coordinator.md      "saves its agent pin and role composition at admission"
 *
 * Deleted: CoordinationProfileSchema, CoordinationProfile, resolveRolePins,
 * the per-role agent loads in TeamAgent.configure, the `!config.coordination`
 * gate in TeamAgent.resolve, WorkAdmission.lead, WorkAdmission.worker, the
 * v2/legacy admission union.
 */

// oxlint-disable -- design sketch; bodies are intentionally unimplemented.

import { Effect, Schema } from "effect";

import type { AuthorityService } from "@cerebro/contracts/authority-service";
import type { EventAddress } from "@cerebro/contracts/events";
import type { ContractFailure } from "@cerebro/contracts/failures";
import type { ExecutionContext, PrincipalId } from "@cerebro/contracts/identity";
import type {
  AgentDefinition,
  ContentDependencies,
} from "@cerebro/contracts/session";
import type { TeamCommandTransport } from "@cerebro/contracts/team-events";

// ─── packages/contracts/src/work.ts ──────────────────────────────────────────
// Only the changed or new declarations. WorkKeySchema, RolePinSchema,
// WorkLimitsSchema, BoundedContentDependenciesSchema, TeamCommandSchema,
// WorkReportSchema, workCellName and the rest are unchanged.

declare const identifier: <Name extends string>() => Schema.Codec<
  string & { readonly __brand: Name }
>;
declare const text: Schema.Codec<string>;
declare const timestamp: Schema.Codec<number>;
declare const WorkKeySchema: Schema.Codec<{
  readonly organizationId: string;
  readonly ownerPrincipalId: string;
  readonly workId: string;
}>;
declare const RolePinSchema: Schema.Codec<{
  readonly agentId: string;
  readonly agentVersion: number;
}>;
declare const WorkLimitsSchema: Schema.Codec<{
  readonly maxTeams: number;
  readonly maxTurns: number;
  readonly maxWorkers: number;
  readonly timeoutMs: number;
}>;
declare const BoundedContentDependenciesSchema: Schema.Codec<ContentDependencies>;

/** A configured model id, `provider/model`. Same bound as the catalog. */
const modelId = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(256)
);

/**
 * What one role was admitted with.
 *
 * `model` is recorded, not derived, because the lead's model may come from
 * installation defaults rather than from the pinned row, and runtime.json can
 * change while the Team is in flight. The cell composes the role with THIS
 * model; the live entitlement check decides whether it is still allowed.
 *
 * No tool policy here. Every role is read-only, no approval, no internal
 * tools (team-role.ts), and the pinned row's enabledToolIds is the ceiling.
 */
export const RoleModelSchema = Schema.Struct({ model: modelId });
export type RoleModel = typeof RoleModelSchema.Type;

/**
 * The composition snapshotted at admission.
 *
 * - `agent`: the one definition every role acts as. The admission filter
 *   requires `agent.agentId === sourceEventAddress.agentId`: a Team can only
 *   act as the agent whose conversation admitted it.
 * - `lead` / `worker`: role TEMPLATES, not an enumerated role list. How many
 *   workers exist is `limits.maxWorkers` today and a budget consumed by Pi
 *   child tasks after Unit 7. Neither change touches this struct.
 */
export const TeamCompositionSchema = Schema.Struct({
  agent: RolePinSchema,
  lead: RoleModelSchema,
  worker: RoleModelSchema,
});
export type TeamComposition = typeof TeamCompositionSchema.Type;

/**
 * Replaces CoordinationProfileSchema. The runtime.json `coordination` block.
 * Every field is optional and `{}` is valid, so Teams work with no block.
 *
 * `leadModel` must name a configured model (refined in apps/server config
 * parse so a typo fails at bootstrap, not at the first start_team).
 */
export const TeamDefaultsSchema = Schema.Struct({
  leadModel: Schema.optional(modelId),
  maxTeams: WorkLimitsSchema.fields.maxTeams.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(2))
  ),
  maxTurns: WorkLimitsSchema.fields.maxTurns.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(8))
  ),
  maxWorkers: WorkLimitsSchema.fields.maxWorkers.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(2))
  ),
  timeoutMs: WorkLimitsSchema.fields.timeoutMs.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(600_000))
  ),
});
export type TeamDefaults = typeof TeamDefaultsSchema.Type;

/**
 * Durable admission, version 3. A single struct: the legacy Slack variant and
 * v2 are deleted (plan assumption: no installation holds pre-cutover data).
 * The literal stays so a stale record fails with one clear reason.
 *
 * Invariants encoded in the filter:
 *   key.organizationId        === sourceEventAddress.organizationId
 *   team.agent.agentId        === sourceEventAddress.agentId
 *   admittedAt < deadlineAt   <= admittedAt + limits.timeoutMs
 *
 * Size: v3 adds two short model ids and removes one RolePin relative to v2.
 * The admission stays a few hundred bytes plus the goal.
 */
const WorkAdmissionV3Schema = Schema.Struct({
  version: Schema.Literal(3),
  admittedAt: timestamp,
  contentDependencies: BoundedContentDependenciesSchema,
  deadlineAt: timestamp,
  goal: text,
  key: WorkKeySchema,
  limits: WorkLimitsSchema,
  sourceEventAddress: Schema.Struct({
    agentId: identifier<"AgentId">(),
    conversationId: identifier<"ConversationId">(),
    organizationId: identifier<"OrganizationId">(),
    sessionId: identifier<"SessionId">(),
  }),
  team: TeamCompositionSchema,
}).check(
  Schema.makeFilter(
    (work) =>
      work.key.organizationId === work.sourceEventAddress.organizationId &&
      work.team.agent.agentId === work.sourceEventAddress.agentId &&
      work.deadlineAt > work.admittedAt &&
      work.deadlineAt - work.admittedAt <= work.limits.timeoutMs
  )
);
export const WorkAdmissionSchema = WorkAdmissionV3Schema;
export type WorkAdmission = typeof WorkAdmissionSchema.Type;

// Deleted from this module:
//   CoordinationProfileSchema, CoordinationProfile
//   LegacySlackWorkAdmissionSchema, WorkAdmissionV2Schema, the union
//   SlackThreadSchema's use in admissions (Unit 2)

// ─── packages/runtime/src/team-composition.ts (new) ──────────────────────────
// The one module that knows how a pinned definition becomes role definitions:
// slot layout, overlay text, and model substitution. Three callers: the
// coordinator (authorize at admission), the cell (compose at open), and
// inspection (slot to kind). Nothing else repeats this knowledge.

export type TeamRoleKind = "lead" | "worker";

/** One slot of a Team. Index 0 is the lead; 1..limits.maxWorkers are workers. */
export interface TeamRole {
  readonly index: number;
  readonly kind: TeamRoleKind;
  readonly model: string;
}

/**
 * System-owned role overlay, prefixed to the agent's own instructions.
 *
 * Constant text in code, not a field on AgentDefinition and not a field in
 * the admission: it is the runtime's policy, the person does not configure
 * it, and prompt text does not belong in durable queue payloads. A deploy
 * changes it for in-flight Teams at their next turn, the same rule every
 * other runtime behaviour follows.
 */
export const ROLE_OVERLAY: Readonly<Record<TeamRoleKind, string>> = {
  lead: [
    "You lead a background team working on one bounded, read-only request.",
    "The first message is the goal. Split it into independent questions and",
    "call delegate_worker once per question, then combine the answers into",
    "one complete final answer. The person is not in this conversation: do",
    "not ask them anything. Do not re-ask a question a worker already answered.",
  ].join(" "),
  worker: [
    "You are a worker in a background team. Answer the assigned question",
    "completely with the tools you have. Do not delegate, schedule, or address",
    "the person; your answer goes to the team lead.",
  ].join(" "),
};

/**
 * Slot layout for an admission: `[lead, worker × limits.maxWorkers]`.
 * The single place that knows slot 0 is the lead. Replaces the inline
 * `[work.lead, ...Array.from({length: maxWorkers}, () => work.worker)]` in
 * team-agent.ts and the `index === 0 ? work.lead : work.worker` branches in
 * team-content.ts, team-runtime.ts and team-inspection.ts.
 */
export const teamRoles = (work: WorkAdmission): readonly TeamRole[] => {
  throw new Error("not implemented");
};

/**
 * The role at one slot.
 * @throws InvalidInput when index is not an integer in 0..limits.maxWorkers.
 * Replaces the two copies of that range check in team-content.ts.
 */
export const teamRole = (work: WorkAdmission, index: number): TeamRole => {
  throw new Error("not implemented");
};

/**
 * Pure. The AgentDefinition a role runs as, and the one the coordinator
 * authorizes at admission.
 *
 * Keeps organizationId, agentId, version, enabledToolIds and grants from the
 * pinned row: that is the ceiling `pinnedDenial` enforces, and it must come
 * from the row, never from the admission. Replaces `model` with the admitted
 * role model. Prefixes ROLE_OVERLAY[kind] to the instructions.
 *
 * Never persisted and never published. team-runtime.ts verifies that each
 * composed configuration's agent matches `work.team.agent` and its model
 * matches `teamRole(work, index).model`.
 */
export const composeRoleDefinition = (
  pinned: AgentDefinition,
  role: Pick<TeamRole, "kind" | "model">
): AgentDefinition => {
  throw new Error("not implemented");
};

/**
 * Pure. The composition the coordinator admits for one start_team call.
 *
 * - agent: the version the coordinator session is running. No PostgreSQL
 *   read; the Team and the coordinator that started it share one version.
 * - lead.model: defaults.leadModel when set, else agent.model.
 * - worker.model: agent.model.
 */
export const composeTeam = (
  agent: AgentDefinition,
  defaults: Pick<TeamDefaults, "leadModel">
): TeamComposition => {
  throw new Error("not implemented");
};

// ─── packages/runtime/src/team-content.ts (changed) ──────────────────────────

/**
 * Unchanged contract; body now `teamRole(work, index)` for the range check
 * and `work.team.agent.agentId` for every slot's agentId. conversationId and
 * sessionId stay `team:${digest({key, role: index})}`.
 */
export declare const teamRoleAddress: (
  work: WorkAdmission,
  index: number
) => Promise<EventAddress>;

// readTeamRoleImports: range check via teamRole(work, index); otherwise unchanged.

// ─── packages/runtime/src/team-runtime.ts (changed) ──────────────────────────

/**
 * Replaces the inline pin comparison in createTeamRuntime.
 * For each index: configuration.agent.{organizationId, agentId, version}
 * equals work.key.organizationId / work.team.agent; configuration.agent.model
 * equals teamRole(work, index).model; configuration.address.agentId equals
 * work.team.agent.agentId; sessionIds are unique; count is teamRoles(work).length.
 * @throws InvalidInput "The team role configuration differs from its saved composition."
 */
export declare const requireRoleConfigurations: (
  work: WorkAdmission,
  configurations: readonly { readonly agent: AgentDefinition; readonly address: EventAddress }[]
) => void;

// ─── packages/runtime/src/team-inspection.ts (changed) ───────────────────────
// readRole: `definition: input.work.team.agent` for every slot. InspectionRole
// is unchanged: `modelId` (Pi's saved AgentDoc model) already shows which
// model each role used; `definition` keeps showing the pinned agent/version.

// ─── packages/runtime/src/coordinator-work.ts (changed) ──────────────────────

export interface CoordinationServices {
  readonly ownerPrincipalId: PrincipalId;
  /** Admission limits snapshotted into every admission. From TeamDefaults. */
  readonly limits: {
    readonly maxTeams: number;
    readonly maxTurns: number;
    readonly maxWorkers: number;
    readonly timeoutMs: number;
  };
  /**
   * Resolves and authorizes the composition for one admission.
   *
   * No PostgreSQL definition read: pins the version the session runs.
   * Requires `execute` on the agent through the session's agent authority
   * with `pinnedAgent = composeRoleDefinition(agent, lead)` and
   * `model = lead.model`, so an unconfigured or not-enabled lead model fails
   * here, at start_team, not at the lead's first turn.
   * @throws Denied when the owner context or current grants do not permit.
   */
  readonly resolveTeam: () => Promise<TeamComposition>;
  readonly contentDependencies: () => Promise<ContentDependencies>;
  readonly sendCommand: (command: TeamCommandTransport) => Promise<void>;
}

// start(goal, api, context), changed lines only:
//   const [team, contentDependencies] = await Promise.all([
//     services.resolveTeam(),
//     services.contentDependencies(),
//   ]);
//   admission = decode(WorkAdmissionSchema)({
//     version: 3, admittedAt, contentDependencies,
//     deadlineAt: admittedAt + services.limits.timeoutMs,
//     goal, key, limits: services.limits, sourceEventAddress: source.address, team,
//   });
// createCoordinatorAdmissions({ ..., timeoutMs: services.limits.timeoutMs })
// queued = queue.length > 0 || active >= services.limits.maxTeams

// ─── apps/server/src/session/coordination.ts (changed) ───────────────────────

type ConversationRow = { readonly kind: "web" | "slack"; readonly ownerPrincipalId: string };
type SlackConfiguration = { readonly agentId: string; readonly workspaceId: string };

/**
 * Returns services for every coordinator conversation. `undefined` only when
 * the conversation is not a coordinator conversation (isCoordinatorConversation
 * is unchanged). No profile, no agent IDs, no PostgreSQL read.
 */
export declare const createCoordinatorServices: (options: {
  readonly env: unknown;
  readonly address: EventAddress;
  /** The version this session runs. Becomes team.agent. */
  readonly agent: AgentDefinition;
  /** The session's agent authority: checkSession + entitlements + identity grants. */
  readonly authority: AuthorityService;
  readonly conversation: ConversationRow;
  /** Always present: config decodes `{}` when runtime.json has no block. */
  readonly defaults: TeamDefaults;
  readonly contentDependencies: () => Promise<ContentDependencies>;
  readonly slack?: SlackConfiguration;
  readonly ownerContext: () => Effect.Effect<ExecutionContext, ContractFailure>;
}) => CoordinationServices | undefined;

// resolveTeam body (pseudocode):
//   context = await ownerContext();  require actor.id === ownerPrincipalId && org matches  (as today)
//   team = composeTeam(options.agent, options.defaults)
//   lead = composeRoleDefinition(options.agent, { kind: "lead", model: team.lead.model })
//   await authority.require({
//     action: "execute", address: options.address, context,
//     pinnedAgent: lead, model: lead.model,
//     resource: { kind: "agent", id: agent.agentId, organizationId },
//   }, { deadlineAt: now + 10_000 })
//   // pinnedDenial: address.agentId === lead.agentId, model === lead.model  ✓
//   // configuredDenial: enabledModels.has(lead.model)                      ✓ if configured
//   // entitlements: latest.model === lead.model || coordination.leadModel  ✓ (access.ts change)
//   // identity: owner holds `execute` on the agent                          ✓
//   return team
// Deleted: resolveRolePins, the two `pin()` loads, createCurrentAuthority import.

// ─── apps/server/src/session/agent.ts (changed) ──────────────────────────────
//   coordination: createCoordinatorServices({ ..., defaults: config.coordination, ... })

// ─── apps/server/src/team-agent.ts (changed) ─────────────────────────────────

/**
 * One PostgreSQL read of the immutable pinned row, then one composition per
 * slot. Replaces `1 + maxWorkers` reads of two different agents.
 *
 *   const pinned = await loadPinnedAgent(env, work.key.organizationId, work.team.agent)
 *   return Promise.all(teamRoles(work).map(async (role) =>
 *     createExecutionComposition(
 *       env, storage, work.sourceEventAddress, await teamRoleAddress(work, role.index),
 *       composeRoleDefinition(pinned, role), work.key.ownerPrincipalId, metadata,
 *       true, () => importedDependencies(role.index))))
 *
 * Authorization per role is unchanged and lives in createExecutionComposition:
 * checkSession (source conversation owned, address matches), entitlements
 * (latest model / lead model, latest enabledToolIds), identity grants
 * (current), pinnedDenial (pinned grants/tools as ceiling).
 */
export declare const configure: (
  work: WorkAdmission,
  metadata: unknown,
  importedDependencies: (roleIndex: number) => Promise<ContentDependencies>
) => Promise<readonly unknown[]>;

/** @throws NotFound when the pinned version no longer exists (deleted agent). */
export declare const loadPinnedAgent: (
  env: unknown,
  organizationId: string,
  pin: TeamComposition["agent"]
) => Promise<AgentDefinition>;

// resolve(request): delete `!config.coordination ||` from the "no longer
// configured" denial; keep isCoordinatorConversation. authorizeEventSource is
// unchanged (reads the source agent at latest and requires `read`).

// ─── apps/server/src/session/team-inspection.ts (changed) ────────────────────
// authorizeTeamInspection: iterate `teamRoles(work)` and call
// `teamRoleAddress(work, role.index)` instead of `length: maxWorkers + 1`.

// ─── apps/server/src/config.ts (changed) ─────────────────────────────────────
//   coordination: z.unknown().optional().transform((value) =>
//     Schema.decodeUnknownSync(TeamDefaultsSchema, { onExcessProperty: "error" })(value ?? {}))
//   .superRefine: when coordination.leadModel is set it must equal some models[].id,
//   otherwise "coordination.leadModel is not a configured model".
//   RuntimeConfiguration.coordination: TeamDefaults   (no longer optional)

// ─── apps/server/src/access.ts (changed) ─────────────────────────────────────
// createCurrentEntitlements, kind "model":
//   allowed =
//     (request.model === current.value.model ||
//      request.model === configured.coordination.leadModel) &&
//     configured.models.some((model) => model.id === request.model);
// Scope of the widening: a role can only request a model equal to its pinned
// definition's model (pinnedDenial), and only a lead composition carries
// leadModel as its pinned model. A primary conversation of the same agent
// still cannot request it. Removing leadModel from runtime.json denies
// in-flight leads at their next call: "current permissions still apply".

// ─── tests to add ────────────────────────────────────────────────────────────
// contracts: WorkAdmissionSchema rejects team.agent.agentId !== sourceEventAddress.agentId;
//            TeamDefaultsSchema decodes {} to the documented defaults; v2 payload is rejected.
// runtime:   composeRoleDefinition keeps grants/enabledToolIds/version, replaces model,
//            prefixes the overlay; teamRoles length is 1 + maxWorkers with slot 0 lead;
//            requireRoleConfigurations rejects a model or version mismatch.
// server:    resolveTeam denies when leadModel is not enabled by the latest definition
//            or not configured; TeamAgent.configure performs exactly one agent read.
// docker:    start_team with no `coordination` block and one published agent runs a lead
//            and two workers under that agent's grants; Inspector shows the pinned
//            agent/version and saved model per slot.
