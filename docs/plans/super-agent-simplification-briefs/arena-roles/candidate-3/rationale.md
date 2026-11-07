# Team roles from the published agent (candidate 3)

## Problem

Every published agent should get background Teams the moment it exists, composed from its own pinned definition with a system-owned role overlay. Today a Team needs three published agents and a `coordination` block with agent IDs; `resolveRolePins` loads lead and worker at `latest`, and the cell reloads each pin. Two facts make the shape non-obvious. `pinnedDenial` in `packages/authorization/src/agent-authority.ts` rejects any `model !== pinnedAgent.model`, and `createCurrentEntitlements` in `apps/server/src/access.ts` compares the request model to the _latest_ definition's `model`, so a stronger lead model must be something the pinned definition itself names. And `AgentDefinition` is a JSONB blob (`agent_version.definition`) with one publish boundary (`publishAgent` in `packages/channels/src/service.ts`), so adding a versioned, optional section costs no migration. Constraints kept: pin by version, current permissions at execution and transfer, durable Effect-validated admission, Inspector shows each role's model, nothing bakes in two workers.

## Usage (caller's view)

Editor: publish an agent as today (instructions, model, tools, sources). Teams already work. Optionally open **Teams**: lead model, worker model (default "Same as agent"), extra instructions per role, and budgets `maxWorkers`, `maxTurns`, `timeoutMs` (default: installation). Save publishes one new version carrying all of it.

```ts
// packages/channels/src/service.ts  publishAgent
const team = decode(AgentTeamSectionSchema)(input.team);           // optional
requireConfigured(agentModels({ ...definition, team }));            // every role model is a configured model
// apps/server/src/session/coordination.ts  createCoordinatorServices(...).pinTeam
await authority.require({ action: "execute", pinnedAgent: agent, model: agent.model, ... });
return { agentVersion: agent.version, limits: resolveWorkLimits(agent, defaults) };
// apps/server/src/team-agent.ts  configure
const agent = await repository.get(org, work.sourceEventAddress.agentId, work.agentVersion);
return teamRoleDefinitions(agent, work.limits.maxWorkers).map(({ index, agent: role }) =>
  createExecutionComposition(env, storage, work.sourceEventAddress, roleAddress(index), role, owner, metadata, true, imports(index)));
```

`runtime.json` may keep `"coordination": { "maxTeams", "maxWorkers", "maxTurns", "timeoutMs" }`; all optional, all defaulted. `leadAgentId`/`workerAgentId` are accepted and dropped for one release.

## Shape

Data first. `AgentDefinition.team?: { lead?, worker?: { model?, instructions? }, limits?: { maxWorkers?, maxTurns?, timeoutMs? } }`, validated at publish by `AgentTeamSectionSchema` and trusted inside, per boundary-discipline. `WorkAdmission` v3 drops `lead`/`worker` and carries `agentVersion` plus the resolved `limits` snapshot; the agent id is already `sourceEventAddress.agentId`, so there is one pin and nothing to keep in sync. `TeamDefaultsSchema` replaces `CoordinationProfileSchema` with limits only; `maxTeams` stays installation-owned because it is per-person concurrency, not an agent budget.

Flow. Admission: `pinTeam()` authorizes `execute` under current permissions for the coordinator's pinned definition and for each role definition with a distinct model, then returns `{agentVersion, limits}`. No agent reads: the conversation already holds its pinned definition. Cell: one read by version, then `teamRoleDefinitions(agent, maxWorkers)` derives a projection per role: identical `organizationId`, `agentId`, `version`, `enabledToolIds`, `grants`; `model = team?.[role]?.model ?? model`; `instructions = overlay + agent + addendum`; `team` omitted. That projection is the `pinnedAgent` for every authority request, so `pinnedDenial` holds for a stronger lead and the authority layer learns nothing about teams. The only authorization edit is the entitlement model check widening from one id to `agentModels(latest)`, the single function that defines which models a definition may run, per single-source-of-truth. `team-role.ts` is unchanged: it already reads `configuration.agent.instructions` and `provider.model`.

Invariants in types: a role can never exceed the agent because `teamRoleDefinition` copies and has no field to widen (encode-lessons-in-structure). Idempotent: `start()` stays keyed by task id; `configure` recomposes byte-identical roles after a restart from a constant overlay and append-only versions, so no role snapshot is stored (derive, do not sync). Interface depth: callers see `pinTeam`, `teamRoleDefinitions`, `agentModels`, `resolveWorkLimits`; behind them sit authorization, limit layering, overlay composition, and worker-count expansion. Deleted: `CoordinationProfileSchema`, `RolePinSchema` (renamed `AgentPinSchema`), `resolveRolePins`, `CoordinationServices.profile`, the per-role loads in `configure`, the `config.coordination` gates, and the legacy/v2 admission union.

Editor and authorization gains and losses. Gains: one screen and one publish configure a Team; budgets and models are versioned and pinned with the agent, which is stronger than today where limits came from a mutable file; no IDs to copy, no bootstrap restart; an agent with no section still works. Losses: the editor must round-trip `team` because `agentDetailSchema` uses non-strict `z.object` and would otherwise delete the section on the next publish; the "unavailable model" warning must cover role models; a cost policy such as "all leads use model X" has no fleet-wide switch; the model entitlement check now consults a small set instead of one id.

## Synthesis decision

Filled by arena.

## Tradeoffs accepted

- We accept no installation-level lead model in exchange for a Team that is fully determined by the admission plus one pinned row; a file-sourced model could not be entitled by the pinned definition and would change on cell recovery after a bootstrap.
- We accept that changing a budget publishes a new agent version in exchange for budgets that in-flight Teams keep.
- We accept passing a derived projection as `pinnedAgent` in exchange for leaving `agent-authority.ts` untouched.
- We accept up to three authority evaluations at `start_team` (same count as today) in exchange for denials surfacing to the person instead of inside the cell.
- We accept a worker model override nobody asked for in exchange for one symmetric `TeamRoleOverride` type.

## Alternatives considered

- Snapshot role definitions into the admission (instructions and model per role). Hides the cell's PostgreSQL read but leaks definition content into queue JSON (16 KB instructions per role against `assertQueuePayloadSize`) and creates a second source of truth the Inspector would read. Lost on leakage.
- Installation-level roles (`coordination.lead.model`, overlay in `runtime.json`) with the admission pinning only the version. Small editor, but the authority must consult runtime config to entitle the model, and a mid-flight bootstrap changes the lead model on recovery. Lost on determinism and on moving policy out of the pinned definition.
- Role-aware authority (`AuthorityRequest.role`) instead of a projection. Every `require` call and `pinnedDenial` learn about teams; the projection hides that behind one function. Lost on interface depth.

## Open questions and risks

- Should installation `coordination` values be ceilings for agent budgets rather than defaults, given a manager can set `maxTurns: 8` on any agent?
- Should an installation restrict which models may be role overrides, since model choice is a cost decision the editor now exposes per agent?
- Keep the worker model override, or restrict overrides to the lead as the direction stated?
- Should the editor show the system overlay read-only so authors see the full role prompt they are adding to?
- Is version `3` right, or edit v2 in place given the "no pre-cutover data" assumption?
- Accept-and-drop `leadAgentId`/`workerAgentId` for one release, or fail bootstrap loudly?

## Next implementation step

Add `packages/contracts/src/team.ts` and `AgentDefinition.team`, cut `WorkAdmission` to v3 with `AgentPinSchema`, and run `pnpm check-types` to let the compiler enumerate every consumer of `lead`/`worker`/`profile` before touching server or runtime code.
