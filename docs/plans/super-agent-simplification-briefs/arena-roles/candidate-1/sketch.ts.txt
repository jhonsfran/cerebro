/**
 * Candidate 1: one agent pin, constant role overlay in code.
 *
 * The admission pins exactly one thing about roles: the coordinator agent's
 * published version. Every role (lead, worker 1..N) is that agent plus a
 * system-owned overlay that lives in runtime code. The Team cell derives
 * roles from (admission, one PostgreSQL agent-version row, overlay constant).
 * Nothing about roles is stored twice, so nothing can drift.
 *
 * Invariants this shape encodes:
 *   - A Team acts as the agent of its source conversation. Schema filter:
 *     work.sourceEventAddress.agentId === work.agent.agentId.
 *   - Every role shares the pinned agent's grants, enabledToolIds and model.
 *     Authority checks receive the unmodified pinned definition, so the
 *     existing pinnedDenial/entitlement path applies unchanged.
 *   - Roles are positional: slot 0 is the lead, slots 1..limits.maxWorkers are
 *     workers. The count comes from limits, never from a literal.
 *
 * What is deleted: CoordinationProfileSchema, resolveRolePins, the per-role
 * agent loads in TeamAgent.configure, the `!config.coordination` denial in
 * TeamAgent.resolve, the legacy admission union, and the three-agent recipe.
 *
 * Imports below are illustrative; bodies are `not implemented`.
 */

import type { EventAddress } from "@cerebro/contracts/events";
import type { AgentId, OrganizationId, PrincipalId } from "@cerebro/contracts/identity";
import type { AgentDefinition, ContentDependencies } from "@cerebro/contracts/session";
import type { TeamCommandTransport } from "@cerebro/contracts/team-events";
import type { WorkAdmission as _ExistingWorkAdmission, WorkKey, WorkLimits } from "@cerebro/contracts/work";
import type { ConversationId, Harness, Registry, ToolRegistration } from "@earendil-works/pi-durable";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { Schema } from "effect";

const notImplemented = (name: string): never => {
  throw new Error(`${name} is not implemented`);
};

// ────────────────────────────────────────────────────────────────────────────
// packages/contracts/src/work.ts  (changed)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Rename of RolePinSchema. Same shape; the name no longer suggests one pin per
 * role. References: inspection.ts (InspectionRole.definition), coordination.ts,
 * coordinator-work.ts.
 */
export const AgentPinSchema = Schema.Struct({
  agentId: Schema.declare<AgentId>((v): v is AgentId => typeof v === "string"),
  agentVersion: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
});
export type AgentPin = typeof AgentPinSchema.Type;

/** Unchanged. Hard bounds stay until unit 7 replaces them with per-agent budgets. */
export declare const WorkLimitsSchema: Schema.Schema<WorkLimits>;

/**
 * Replaces CoordinationProfileSchema. Optional operator defaults for Team
 * limits only; no agent IDs. An absent `coordination` block decodes to
 * DEFAULT_TEAM_LIMITS. The decoded value is structurally a WorkLimits so the
 * coordinator can pin it into the admission without translation.
 */
export const TeamDefaultsSchema = Schema.Struct({
  // maxTeams: WorkLimits.maxTeams with decoding default 2
  // maxTurns: WorkLimits.maxTurns with decoding default 8
  // maxWorkers: WorkLimits.maxWorkers with decoding default 2
  // timeoutMs: WorkLimits.timeoutMs with decoding default 600_000
});
export type TeamDefaults = WorkLimits;
export declare const DEFAULT_TEAM_LIMITS: WorkLimits; // decode(TeamDefaultsSchema)({})

/**
 * Durable, queue-borne, version-bumped admission. `lead` and `worker` pins are
 * replaced by one `agent` pin. The legacy Slack variant and the union are
 * gone (deleted in unit 2; this shape assumes no pre-cutover data).
 *
 * Filter invariants (unchanged ones kept, one added):
 *   key.organizationId === sourceEventAddress.organizationId
 *   sourceEventAddress.agentId === agent.agentId            <- new
 *   admittedAt < deadlineAt <= admittedAt + limits.timeoutMs
 */
export const WorkAdmissionSchema = Schema.Struct({
  version: Schema.Literal(3),
  // admittedAt: timestamp,
  // contentDependencies: BoundedContentDependenciesSchema,
  // deadlineAt: timestamp,
  // goal: text,
  // key: WorkKeySchema,
  agent: AgentPinSchema,
  // limits: WorkLimitsSchema,
  // sourceEventAddress: { agentId, conversationId, organizationId, sessionId },
});
export interface WorkAdmission {
  readonly version: 3;
  readonly admittedAt: number;
  readonly contentDependencies: ContentDependencies;
  readonly deadlineAt: number;
  readonly goal: string;
  readonly key: WorkKey;
  readonly agent: AgentPin;
  readonly limits: WorkLimits;
  readonly sourceEventAddress: EventAddress;
}
// TeamCommandSchema, PrivateInspectionQuery, TeamEventReturnSchema embed
// WorkAdmissionSchema and change by reference only.

// ────────────────────────────────────────────────────────────────────────────
// apps/server/src/config.ts  (changed)
// ────────────────────────────────────────────────────────────────────────────

/**
 * `coordination` becomes optional TeamDefaults (zod .unknown() -> Effect decode,
 * as today). Teams no longer require the block. Deployments that still carry
 * leadAgentId/workerAgentId fail to parse with onExcessProperty: "error",
 * which is the intended signal to delete those keys.
 */
export declare const teamLimits: (config: { readonly coordination?: TeamDefaults }) => WorkLimits;
// = config.coordination ?? DEFAULT_TEAM_LIMITS

// ────────────────────────────────────────────────────────────────────────────
// packages/runtime/src/coordinator-work.ts  (changed)
// ────────────────────────────────────────────────────────────────────────────

/**
 * The coordinator needs two facts to admit work and nothing to resolve:
 * which agent version it is, and which limits to pin. Both are plain data
 * captured when the session composed its configuration.
 *
 * Authorization at `start_team` is unchanged and already sufficient:
 * requireCaller -> options.authorize -> runtime.authorize(owner, "coordinate")
 * requires execute + read on the pinned coordinator agent and verifies session
 * ownership. The model entitlement is re-checked in the Team cell at command
 * receipt (admitDependencies) and before every provider call, so the
 * start-time model check that lived in resolveRolePins is dropped as a
 * duplicate.
 */
export interface CoordinationServices {
  readonly ownerPrincipalId: PrincipalId;
  /** The coordinator conversation's own pinned definition. The Team acts as this agent. */
  readonly agent: AgentPin;
  /**
   * Limits pinned into each admission at start. Runtime defaults today; unit 7
   * derives them from the pinned agent's budgets without touching the admission.
   */
  readonly limits: WorkLimits;
  readonly contentDependencies: () => Promise<ContentDependencies>;
  readonly sendCommand: (command: TeamCommandTransport) => Promise<void>;
}

/**
 * start(): identical control flow (idempotent by work key, FIFO of 16,
 * maxTeams active). The only change is the admission literal:
 *
 *   const contentDependencies = await services.contentDependencies();
 *   const admission = decode(WorkAdmissionSchema)({
 *     version: 3,
 *     admittedAt,
 *     contentDependencies,
 *     deadlineAt: admittedAt + services.limits.timeoutMs,
 *     goal,
 *     key: { organizationId, ownerPrincipalId, workId: candidate },
 *     agent: services.agent,
 *     limits: services.limits,
 *     sourceEventAddress: source.address,
 *   });
 *
 * `services.profile.maxTeams` -> `services.limits.maxTeams`;
 * admissions timeoutMs -> `services.limits.timeoutMs`.
 */
export declare const createCoordinatorWork: (options: {
  readonly services?: CoordinationServices;
  // ...everything else unchanged
}) => unknown;

// ────────────────────────────────────────────────────────────────────────────
// apps/server/src/session/coordination.ts  (changed)
// ────────────────────────────────────────────────────────────────────────────

/**
 * No authority, no ownerContext, no database. Returns undefined only when the
 * conversation is not a coordinator conversation (web: always; slack: the
 * configured bot thread). The absence of a `coordination` block no longer
 * disables team tools.
 */
export const createCoordinatorServices = (_options: {
  readonly env: unknown;
  readonly address: EventAddress;
  readonly agent: AgentDefinition; // the session's pinned definition
  readonly conversation: { readonly ownerPrincipalId: string; readonly kind: "web" | "slack" };
  readonly limits: WorkLimits; // teamLimits(runtimeConfiguration(env))
  readonly contentDependencies: () => Promise<ContentDependencies>;
  readonly slack?: unknown;
}): CoordinationServices | undefined =>
  // if (!isCoordinatorConversation(conversation, slack)) return undefined;
  // return {
  //   ownerPrincipalId: id.principal(conversation.ownerPrincipalId),
  //   agent: { agentId: agent.agentId, agentVersion: agent.version },
  //   limits,
  //   contentDependencies,
  //   sendCommand: queue send with payload size assertion (unchanged),
  // };
  notImplemented("createCoordinatorServices");

// resolveRolePins: deleted.

// ────────────────────────────────────────────────────────────────────────────
// packages/runtime/src/team-content.ts  (changed)
// ────────────────────────────────────────────────────────────────────────────

export type TeamRoleKind = "lead" | "worker";

export interface TeamRoleSlot {
  readonly index: number; // 0 = lead, 1..maxWorkers = workers
  readonly role: TeamRoleKind;
}

/** Positional role layout of one Team. Length is 1 + work.limits.maxWorkers; never a literal. */
export const teamRoleSlots = (_work: WorkAdmission): readonly TeamRoleSlot[] =>
  notImplemented("teamRoleSlots");

/** Throws InvalidInput for an index outside 0..maxWorkers. */
export const teamRoleKind = (_work: WorkAdmission, _index: number): TeamRoleKind =>
  notImplemented("teamRoleKind");

/**
 * Unchanged derivation except agentId now comes from work.agent. Every role
 * address therefore carries the coordinator's agentId, which is what the
 * composition's checkSession compares against.
 */
export const teamRoleAddress = async (_work: WorkAdmission, _index: number): Promise<EventAddress> =>
  notImplemented("teamRoleAddress");

// readTeamRoleImports: unchanged (already keyed by index).

// ────────────────────────────────────────────────────────────────────────────
// packages/runtime/src/team-role.ts  (changed)
// ────────────────────────────────────────────────────────────────────────────

/**
 * What the system owns about a role. Everything else (grants, enabled tools,
 * tool read-only filter, budget) stays where it is today.
 *
 * `model` is the agent's model for both roles in this candidate. It is the one
 * seam for a stronger lead model later; see rationale. If that lands, it must
 * come from the pinned AgentDefinition (versioned, hence pinned for free), not
 * from runtime.json, and createCurrentEntitlements needs one extra disjunct.
 */
export interface TeamRoleOverlay {
  readonly instructions: string;
  readonly model: string;
}

/** System-owned text, prefixed to the agent's own instructions. A deploy may change it; the pin protects against republish, not deploys. */
export declare const LEAD_ROLE_INSTRUCTIONS: string;
// "You lead a private background team acting as this agent for one goal. You
//  have read-only tools and delegate_worker, which sends one bounded question
//  to a worker and returns its answer. Split the goal into bounded questions,
//  delegate when parallel reading helps, and finish with one complete answer:
//  your final message is the report. The model call budget is shared with
//  your workers."
export declare const WORKER_ROLE_INSTRUCTIONS: string;
// "You are a worker in a private background team acting as this agent. Answer
//  the single question you receive with read-only tools. Do not delegate,
//  schedule, or address the person. Your final message is the answer."

/** Pure. `${overlay}\n\n${agent.instructions}`; model = agent.model. */
export const teamRoleOverlay = (
  _role: TeamRoleKind,
  _agent: Pick<AgentDefinition, "instructions" | "model">
): TeamRoleOverlay => notImplemented("teamRoleOverlay");

/**
 * TeamRoleConfiguration is unchanged (still the execution composition plus
 * dependency hooks). The role kind is passed beside it, derived from the slot
 * by the runtime, so the server's configure() return type does not change.
 *
 * install() now returns
 *   instructions: teamRoleOverlay(role, configuration.agent).instructions
 * instead of configuration.agent.instructions verbatim. Tool filtering,
 * reserveModelCall, permit and admitDependencies are untouched: they already
 * operate on the unmodified pinned definition.
 */
export declare const createTeamRole: (options: {
  readonly work: WorkAdmission;
  readonly role: TeamRoleKind; // new
  readonly configuration: unknown; // TeamRoleConfiguration, unchanged
  readonly pi: Harness;
  readonly storage: DurableObjectStorage;
  readonly metadata: unknown;
  readonly models: MutableModels;
  readonly registry: Registry;
  readonly now: () => number;
}) => {
  readonly install: (extraTools?: readonly ToolRegistration[]) => {
    readonly instructions: string;
    readonly model: { readonly modelId: string; readonly provider: string };
    readonly extensions: readonly unknown[];
  };
  // permit, admitDependencies, reconcileImports, dependencies: unchanged
};

// ────────────────────────────────────────────────────────────────────────────
// packages/runtime/src/team-runtime.ts  (changed)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Replaces the inline loop that compared each configuration to work.lead /
 * work.worker. Fails with InvalidInput unless:
 *   configurations.length === teamRoleSlots(work).length
 *   every configuration.agent.{agentId, version, organizationId} matches
 *     work.agent / work.key.organizationId
 *   every configuration.address.agentId === work.agent.agentId
 *   session IDs are unique across roles
 */
export const requireRoleConfigurations = (
  _work: WorkAdmission,
  _configurations: readonly { readonly agent: AgentDefinition; readonly address: EventAddress }[]
): void => notImplemented("requireRoleConfigurations");

/**
 * createTeamRuntime: after requireRoleConfigurations,
 *   roles = configurations.map((configuration, index) =>
 *     createTeamRole({ ...options, configuration, role: teamRoleKind(work, index), now }))
 * Lead-only tool install keys on role === "lead" instead of index === 0.
 * Everything else (goal as first lead input, receive/restore/abort/wake) is unchanged.
 */

// ────────────────────────────────────────────────────────────────────────────
// apps/server/src/team-agent.ts  (changed)
// ────────────────────────────────────────────────────────────────────────────

/** One PostgreSQL read per cell open, by pinned version. Agent version rows are insert-only, so re-derivation on every open is stable. */
export const loadPinnedAgent = async (
  _env: unknown,
  _organizationId: OrganizationId,
  _pin: AgentPin
): Promise<AgentDefinition> => notImplemented("loadPinnedAgent");

/**
 * configure(work, metadata, importedDependencies):
 *   const agent = await loadPinnedAgent(env, work.key.organizationId, work.agent);
 *   return Promise.all(teamRoleSlots(work).map(async (slot) =>
 *     createExecutionComposition(
 *       env, storage, work.sourceEventAddress, await teamRoleAddress(work, slot.index),
 *       agent,                       // unmodified pinned definition, same for every role
 *       work.key.ownerPrincipalId, metadata, true, () => importedDependencies(slot.index))));
 *
 * resolve(): the `!config.coordination` branch is deleted. The
 * isCoordinatorConversation gate stays.
 */

// ────────────────────────────────────────────────────────────────────────────
// packages/runtime/src/team-inspection.ts  (changed)
// packages/contracts/src/inspection.ts      (changed, optional)
// ────────────────────────────────────────────────────────────────────────────

/**
 * readRole(): definition = input.work.agent for every slot (identical pins;
 * the Inspector keeps showing agentId and version). modelId still comes from
 * Pi's AgentDoc, which already satisfies "show which model each role used".
 *
 * Optional, forward-compatible: InspectionRole gains
 *   role: Schema.Literals(["lead", "worker"])
 * so the web label no longer has to be keyed by slot literal when workers
 * become N. Not required for this unit.
 */

// ────────────────────────────────────────────────────────────────────────────
// Deleted
// ────────────────────────────────────────────────────────────────────────────
// contracts/work.ts        CoordinationProfileSchema, CoordinationProfile, RolePinSchema (renamed), legacy admission union
// server/session/coordination.ts   resolveRolePins and the authority/ownerContext options
// server/team-agent.ts     per-role createAgentRepository.get loop; `!config.coordination` denial
// runtime/coordinator-work.ts      CoordinationServices.profile, CoordinationServices.resolveRolePins
// docs                     three-agent recipe (agent-teams.md), leadAgentId/workerAgentId rows
//                          (runtime-configuration.md), "Usually stronger / Usually cheaper" model
//                          column (slack-coordinator.md roles table)
