# Candidate 1: one agent pin, constant overlay in code

## Problem

A Team today needs three published agents and a `coordination` block naming two of them; `resolveRolePins` loads lead and worker at `latest`, and `TeamAgent.configure` reloads one definition per role slot. The goal is that every published agent gets Teams with no extra configuration, while keeping four things the current code already guarantees: the admission pins by agent version and travels as Effect-validated JSON to a separate cell; current grants and enabled tools apply at execution and content transfer; the Inspector shows each role's model; the shape must not bake in "two workers". Two facts from the code constrain the shape. `TeamAgent.configure` runs on every cold open, so anything role-specific that is not derivable from the pinned agent version must itself be pinned in the admission. And the authority path refuses a model that differs from the pinned agent's model twice (`pinnedDenial` in `agent-authority.ts`, `createCurrentEntitlements` in `access.ts`), so "stronger lead model" is not a Team-cell decision, it is an entitlement decision.

## Usage (caller's view)

A person publishes one agent and talks to it. `runtime.json` needs no `coordination` block; an optional one carries only limits (`{"coordination": {"maxTurns": 6}}`). When the coordinator calls `start_team`, the Team runs as that same agent.

```ts
// apps/server/src/session/agent.ts: fewer inputs, no authority, no database
coordination: createCoordinatorServices({
  env, address, agent, conversation, slack,
  limits: teamLimits(config),
  contentDependencies: execution.contentDependencies,
}),

// packages/runtime/src/coordinator-work.ts start(): plain data in, nothing to resolve
const admission = decode(WorkAdmissionSchema)({
  version: 3, admittedAt, contentDependencies, goal, key,
  deadlineAt: admittedAt + services.limits.timeoutMs,
  agent: services.agent,            // { agentId, agentVersion } of the session's own definition
  limits: services.limits,
  sourceEventAddress: source.address,
});

// apps/server/src/team-agent.ts configure(): one read, N compositions
const agent = await loadPinnedAgent(this.env, work.key.organizationId, work.agent);
return Promise.all(teamRoleSlots(work).map(async (slot) =>
  createExecutionComposition(env, storage, work.sourceEventAddress,
    await teamRoleAddress(work, slot.index), agent, ownerPrincipalId, metadata, true,
    () => importedDependencies(slot.index))));

// packages/runtime/src/team-role.ts install(): the only place the overlay is applied
instructions: teamRoleOverlay(options.role, configuration.agent).instructions,
```

## Shape

Data first. `WorkAdmission` v3 replaces `lead`/`worker` with one `agent: AgentPin` and adds the filter `sourceEventAddress.agentId === agent.agentId`: a Team acts as the agent of its source conversation, encoded in the schema rather than checked in three places. `limits` stays in the admission, pinned at start. `CoordinationProfileSchema` becomes `TeamDefaultsSchema`, limits with decoding defaults and no agent IDs; `teamLimits(config)` returns `DEFAULT_TEAM_LIMITS` when the block is absent.

Roles are positional and derived, per derive-instead-of-sync: `teamRoleSlots(work)` yields `[lead, worker × limits.maxWorkers]`, `teamRoleKind(work, index)` names a slot, and `teamRoleOverlay(role, agent)` returns `{instructions, model}` where instructions are a code constant prefixed to the agent's own text and model is `agent.model`. The Team cell loads the pinned definition once and passes it unmodified to every composition, so `pinnedDenial`, entitlements, `permit`, `admitDependencies`, and the read-only tool filter run exactly as today against exactly the agent's grants (per boundary-discipline: validation stays at the existing boundaries, the derivation is pure). The overlay is applied only in `createTeamRole.install()`, next to the tool filter and budget hook, which is where the rest of the role policy already lives. `requireRoleConfigurations` replaces the inline pin comparison in `createTeamRuntime`.

Authorization that remains: `start_team` keeps `runtime.authorize(owner, "coordinate")` (execute + read on the pinned coordinator agent plus session ownership); the Team cell keeps `admitDependencies` at receipt and `permit` before each handoff and model call. `resolveRolePins`' owner check and coordinator execute check were duplicates of the first; its lead/worker loads have no counterpart and are deleted. The admission is built from data the session already holds, so `start_team` performs zero database reads.

Interface depth: the public surface shrinks (`CoordinationServices` loses `profile` and `resolveRolePins`; `createCoordinatorServices` loses `authority` and `ownerContext`; `configure` loses a loop) while hiding the whole role question behind two pure functions. What stays exposed is `limits` in the admission, deliberately, because unit 7 owns budgets. What this shape deliberately does not do: it does not let the lead use a different model. That is the main thing the minimal contract does not solve, and it is honest about why: the seam is `teamRoleOverlay.model`, but making it differ from `agent.model` requires a versioned per-agent field (so the pin covers it for free) and one extra disjunct in `createCurrentEntitlements`. A runtime.json `leadModel` default would be the wrong place: it is not pinned by the agent version, so a config edit would change an in-flight Team's model on the next cold open, and it would leak the model across every agent.

## Synthesis decision

Filled in by arena.

## Tradeoffs accepted

- We accept that lead and workers run the agent's own model in exchange for no new configuration surface, no entitlement change, and no second thing to pin.
- We accept that a code deploy changes the overlay text for in-flight Teams in exchange for not storing role prompts in durable state; the pin protects against the person's republish, not against deploys, exactly as the tool filter does today.
- We accept that every role carries the agent's full instructions plus the overlay (previously lead and worker had their own short texts) in exchange for one source of truth; see the risk on input size.
- We accept three execution compositions per cell open, each with its own catalog and skills reads, as today, in exchange for not touching `createExecutionComposition`.
- We accept `version: 3` with no migration, per the plan's assumption that no pre-cutover data exists.

## Alternatives considered

- Snapshot the role definitions into the admission (instructions, model, tools per role). Hides nothing more than the pin does, duplicates the agent version row, and puts up to three 16 KB instruction texts into a queue payload that `assertQueuePayloadSize` bounds. Lost.
- One pin plus per-role overrides in the admission (`roles: {lead: {model}}`). Solves the stronger lead model but spreads role policy across contract, runtime.json, and entitlements, and becomes redundant once unit 7 moves budgets onto the agent. Lost for this unit; it is the obvious graft if the model question must land now.
- Overlay as a person-editable field on `AgentDefinition` (`teamInstructions`). Needs editor UI and a publish per change; the product goal says the system owns the overlay. Lost.

## Open questions and risks

- Is a stronger lead model required in this unit? If yes, should it be `AgentDefinition.teamLeadModel` (versioned, pinned for free, one entitlement disjunct) rather than a runtime default?
- Should the admission record an `overlayVersion` so the Inspector can show which overlay text a Team ran under, or is the deploy history enough?
- Keep the optional `coordination` limits block at all, or hardcode `DEFAULT_TEAM_LIMITS` until unit 7 makes limits per-agent?
- Should `InspectionRole` gain `role: "lead" | "worker"` now so the web label stops depending on the slot literal when workers become N?
- Risk: agent instructions plus overlay must fit the provider's `maxInputBytes` for every role; an agent with very long instructions now pays that three times. Worth a bound or a truncation rule in `teamRoleOverlay`.
- Risk: Slack coordinator conversations still gate on `slack.agentId`; this shape does not change that gate, so a Slack-linked agent other than the configured bot still gets no team tools.

## Next implementation step

Change `WorkAdmissionSchema` to v3 with `agent: AgentPinSchema`, delete `CoordinationProfileSchema`, run `pnpm check-types`, and follow the compiler through `coordinator-work.ts`, `session/coordination.ts`, `team-agent.ts`, `team-content.ts`, `team-runtime.ts`, `team-role.ts`, and `team-inspection.ts`.
