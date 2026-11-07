# Grounding: derive Team roles from the coordinator agent

Repository: /Users/jhonsfran/repos/cerebro, branch codex/persistent-super-agent. Read-only for runners. Do not edit repository files. Write your candidate only under your own output directory.

## Product goal

Every published agent gets background Teams the moment it exists. A person configures one agent (instructions, model, tools, grants). When the coordinator conversation for that agent calls `start_team`, the Team cell composes a lead and workers from that same agent's pinned definition, with a role overlay the system owns. No second or third published agent. No `coordination` block in `runtime.json` is required for Teams to work; it may still carry optional defaults such as limits or a stronger lead model.

## Current shape (what exists today)

- `packages/contracts/src/work.ts`: `RolePinSchema {agentId, agentVersion}`, `CoordinationProfileSchema {leadAgentId, workerAgentId, maxTeams, maxWorkers, maxTurns, timeoutMs}`, `WorkLimitsSchema` with hard bounds (maxTeams 1-2, maxWorkers 1-2, maxTurns 1-8, timeoutMs ≤ 600000), `WorkAdmissionV2Schema {version: 2, admittedAt, contentDependencies, deadlineAt, goal, key, lead: RolePin, limits, sourceEventAddress, worker: RolePin}` plus a legacy Slack variant that is being deleted in an earlier unit.
- `apps/server/src/session/coordination.ts`: `createCoordinatorServices` returns undefined unless `profile` exists and the conversation is a coordinator conversation; without services the coordinator registers no team tools. `resolveRolePins` authorizes `execute` on the coordinator agent and then loads the lead and worker definitions at `latest`, authorizes `execute` on each, and returns their pins.
- `packages/runtime/src/coordinator-work.ts` `start()`: builds the `WorkAdmission` from `services.resolveRolePins()`, `services.profile` limits, the goal, and the source address; FIFO queue of 16 and `maxTeams` active per person.
- `apps/server/src/team-agent.ts` `configure(work, metadata, importedDependencies)`: for `[work.lead, ...work.worker × maxWorkers]` loads each pinned agent definition by version from PostgreSQL and composes an execution (`createExecutionComposition(env, storage, work.sourceEventAddress, roleAddress, agent, ownerPrincipalId, metadata, readOnly = true, ...)`). Role addresses come from `teamRoleAddress(work, index)` in `packages/runtime/src/team-content.ts`.
- `packages/runtime/src/team-runtime.ts`: validates `configurations.length === 1 + work.limits.maxWorkers` and that each configuration's `agent.agentId/version/organizationId` matches its pin. The lead receives `work.goal` as its first user input (`options.submit(nativeId, work.goal, workStartOperationId(work.key))`). Team inputs from the coordinator (`message_team`) are later submissions.
- `packages/runtime/src/team-role.ts`: role instructions are `configuration.agent.instructions` verbatim (no overlay); model is `configuration.provider.model`; tools are filtered to read-only, no approval, no internal tools; `reserveModelCall` enforces `work.limits.maxTurns` shared across lead and workers; `permit`/`admitDependencies` check `execute` on the role's pinned agent and content dependencies against the role's grants.
- `packages/runtime/src/team-workers.ts`: `delegate_worker` tool on the lead submits text to a worker conversation and waits for its answer.
- Inspector: `packages/runtime/src/team-inspection.ts`, `inspection-work.ts`, `apps/web/src/features/product/conversation-inspector*.tsx` show saved role models and agent IDs from the admission.
- `AgentDefinition` (`packages/contracts/src/session.ts`): `{organizationId, agentId, version, instructions, model, enabledToolIds, grants}`.
- Authorization: `createCurrentAuthority(env).require({action: "execute", address, context, pinnedAgent, model, resource: {kind: "agent", id}})` checks current grants and that the model is enabled. Current permissions must keep applying before execution and before content transfer.
- Docs that describe today's design: `docs/operations/agent-teams.md`, `docs/reference/runtime-configuration.md` (Coordination section), `docs/architecture/slack-coordinator.md`.

## Constraints the design must honor

1. Pin by agent version at admission so a republished agent does not change an in-flight Team.
2. Current permissions still apply at execution and content transfer. A Team acting for agent X must have exactly agent X's grants and enabled tools, nothing more.
3. The admission is durable JSON validated with Effect Schema and travels over a queue to a separate Durable Object cell named by the work key. The Team cell must be able to compose roles from the admission plus PostgreSQL reads.
4. Keep the Inspector able to show which model each role used.
5. Out of scope here: replacing `delegate_worker` with Pi child tasks, lifting the schema caps, the reply tool. Design so those later changes do not force a second contract rewrite (for example, do not bake "exactly two workers" into the new shape).
6. Prefer deletion. The coordination profile with agent IDs, `resolveRolePins`, and the per-role agent loads should disappear if the design makes them unnecessary.

## Design questions to answer

- What does `WorkAdmission` carry about roles: a single pin of the coordinator agent plus role names, a snapshot of role definitions, or something else?
- Where does the role overlay (lead vs worker instructions) live: constant text in code, a field on `AgentDefinition`, or a runtime default?
- Can the lead use a stronger model than the agent's own model, and where is that configured?
- Where do limits come from once the profile has no agent IDs: runtime defaults, per-agent fields, or both?
- Which authorization checks remain and where?

## Deliverable

Write under your output directory:

- `sketch.ts`: the new or changed contract types and the signatures of the server and runtime functions that change, with `not implemented` bodies and doc comments stating intent and invariants.
- `rationale.md`: shaped per the architect rationale template (Problem, Usage from the caller's view, Shape, Tradeoffs accepted, Alternatives considered, Open questions and risks, Next implementation step). Keep it to one page.
