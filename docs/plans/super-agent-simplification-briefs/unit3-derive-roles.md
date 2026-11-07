# Unit 3: derive Team roles from the coordinator agent

Repository: /Users/jhonsfran/repos/cerebro, branch codex/persistent-super-agent. Units 1 and 2 have landed on the branch you start from: forks, legacy paths, policy versions, Slack-kind rows, and the legacy admission union are gone. Do not commit; the lead reviews and commits.

## Why

Today a Team needs three published agents and a `coordination` block naming two of them. After this unit every published agent gets Teams the moment it exists. The Team cell composes the lead and workers from the coordinator agent's own pinned definition plus a system-owned overlay. The design was chosen in a three-candidate arena; the synthesized shape is below. Read the base candidate for the full rationale: /private/tmp/claude-501/-Users-jhonsfran-repos-cerebro/165aaed4-2f2f-4d95-9258-566ce91c53c8/scratchpad/arena-roles/candidate-1/rationale.md and sketch.ts.

## Data shape

packages/contracts/src/work.ts
- Rename `RolePinSchema` to `AgentPinSchema` (same fields `agentId`, `agentVersion`), type `AgentPin`. Update every importer.
- Delete `CoordinationProfileSchema` and `CoordinationProfile`. Add `TeamDefaultsSchema`: `maxTeams`, `maxWorkers`, `maxTurns`, `timeoutMs`, each `WorkLimitsSchema.fields.*` with the same decoding defaults as today (2, 2, 8, 600000). Export `DEFAULT_TEAM_LIMITS = Schema.decodeUnknownSync(TeamDefaultsSchema)({})` and type `TeamDefaults = WorkLimits`.
- `WorkAdmissionSchema` becomes a single struct at `version: 3`: `admittedAt`, `contentDependencies`, `deadlineAt`, `goal`, `key`, `agent: AgentPinSchema`, `limits: WorkLimitsSchema`, `sourceEventAddress`. The filter keeps the organization and deadline invariants and adds `sourceEventAddress.agentId === agent.agentId`. No `lead`, no `worker`.
- `TeamCommandSchema`, `TeamEventReturnSchema`, `PrivateInspectionQuery` change by reference only.

packages/contracts/src/inspection.ts
- `InspectionRole.definition` stays an `AgentPinSchema`; every slot reports `work.agent`. Add `role: Schema.Literals(["lead", "worker"])` to `InspectionRole` so the web label stops depending on the slot literal.

## Runtime

packages/runtime/src/team-composition.ts (new; the one module that knows how a pinned definition becomes roles)
- `type TeamRoleKind = "lead" | "worker"`.
- `teamRoleSlots(work): readonly { index: number; role: TeamRoleKind }[]` with length `1 + work.limits.maxWorkers`, slot 0 the lead.
- `teamRoleKind(work, index)` throws `InvalidInput` outside `0..maxWorkers`. It replaces the two range checks in `team-content.ts` and the `index === 0 ? lead : worker` branches in `team-content.ts`, `team-runtime.ts`, `team-inspection.ts`, and `apps/server/src/team-agent.ts`.
- `LEAD_ROLE_INSTRUCTIONS` and `WORKER_ROLE_INSTRUCTIONS` constants. Lead: "You lead a background team working on one bounded, read-only request. The first message is the goal. Split it into independent questions and call delegate_worker once per question, then combine the answers into one complete final answer. The person is not in this conversation; do not ask them anything. Your final message is the report." Worker: "You are a worker in a background team. Answer the assigned question completely with the tools you have. Do not delegate, schedule, or address the person. Your final message is the answer."
- `teamRoleDefinition(agent, role): AgentDefinition`, a pure copying projection: `organizationId`, `agentId`, `version`, `enabledToolIds`, `grants`, and `model` are copied unchanged; `instructions` becomes `${overlay}\n\n${agent.instructions}`. Because it copies, a role can never hold more than the agent. The projection is what `createExecutionComposition` receives and therefore the `pinnedAgent` of every authority check; `pinnedDenial` compares model and the grant ceiling, never instructions, so `packages/authorization` stays untouched. A later per-agent lead model becomes a one-field change inside this function.
- `requireRoleConfigurations(work, configurations)`: count equals `teamRoleSlots(work).length`; every configuration's `agent.agentId`, `agent.version`, `agent.organizationId` match `work.agent` and `work.key.organizationId`; every `address.agentId === work.agent.agentId`; session IDs unique. Throws `InvalidInput`.

packages/runtime/src/team-content.ts
- `teamRoleAddress` takes `agentId` from `work.agent` and its range check from `teamRoleKind`. `readTeamRoleImports` likewise.

packages/runtime/src/team-role.ts
- Unchanged. `install()` already reads `configuration.agent.instructions`, which now carries the overlay from the projection.

packages/runtime/src/team-runtime.ts
- Replace the inline pin loop with `requireRoleConfigurations`. Key the lead-only tools on `teamRoleKind(work, index) === "lead"`.

packages/runtime/src/coordinator-work.ts
- `CoordinationServices` becomes `{ ownerPrincipalId, agent: AgentPin, limits: WorkLimits, contentDependencies, sendCommand }`. Delete `profile` and `resolveRolePins`.
- `start()` builds the v3 admission from `services.agent` and `services.limits` with no database read. `services.profile.maxTeams` and `services.profile.timeoutMs` become `services.limits.*`.

packages/runtime/src/team-inspection.ts
- `readRole` reports `definition: work.agent` and `role: slot === 0 ? "lead" : "worker"`.

packages/runtime/src/conversation-profile.ts and instruction-cause.ts
- Remove `allowLegacyUser` and its branch. Coordination services now exist for every web conversation, so the absent-coordination case is gone.
- Remove the conversation `notify` hook, the `cerebro-notify` lifecycle job, `scheduleNotify`, and `ConversationScope.notify`: the Slack-kind notifier was their only production consumer and Unit 2 deleted it. Update `tests/runtime/fixture-session.ts` (the `notify-*` conversations) and the `notifications` assertions in `native-journey`, `identity-journey`, and `coordinator-results` tests; delete assertions that only proved the hook fired.

A parallel delegate is rewriting the event pipeline (coordinator events, replies, instruction cause, saved timers, session-agent event wiring) on the same base commit. Keep your changes in those files to the minimum this brief needs so the two branches rebase cleanly: in `instruction-cause.ts` only delete the `allowLegacyUser` branch; in `session-agent.ts` only the notify job and the coordination services wiring; do not restructure `coordinator-events.ts`, `coordinator-replies.ts`, or `saved-timer-submit.ts`.

## Server

apps/server/src/config.ts
- `coordination` is optional in the file and always present after parsing: decode `value ?? {}` with `TeamDefaultsSchema` and `onExcessProperty: "error"`. A file that still carries `leadAgentId` or `workerAgentId` fails to parse; that is the intended signal. `RuntimeConfiguration.coordination: TeamDefaults`.

apps/server/src/session/coordination.ts
- Delete `resolveRolePins` and `isCoordinatorConversation` (after Unit 2 the only conversation kind is web). `createCoordinatorServices({ address, agent, conversation, limits, contentDependencies, env })` always returns services: `agent: { agentId: agent.agentId, agentVersion: agent.version }`, `limits`, `ownerPrincipalId`, `sendCommand` unchanged. It no longer takes `authority`, `profile`, `slack`, or `ownerContext`. `start_team` keeps its existing `runtime.authorize(owner, "coordinate")`, which already requires execute and read on the pinned coordinator agent; the model entitlement is re-checked in the Team cell at command receipt and before every provider call.

apps/server/src/session/agent.ts
- Pass `limits: config.coordination` to `createCoordinatorServices`.

apps/server/src/team-agent.ts
- `configure`: one `createAgentRepository(database).get(work.key.organizationId, work.agent.agentId, work.agent.agentVersion, ...)`, then `teamRoleSlots(work).map(slot => createExecutionComposition(env, storage, work.sourceEventAddress, await teamRoleAddress(work, slot.index), teamRoleDefinition(agent, slot.role), work.key.ownerPrincipalId, metadata, true, () => importedDependencies(slot.index)))`.
- `resolve`: delete the `!config.coordination` denial.

apps/server/src/session/team-inspection.ts
- Iterate `teamRoleSlots(work)` instead of `maxWorkers + 1`.

## Web

apps/web/src/features/product/inspection-role.tsx
- Label from `role.role` ("Lead", "Worker"), keep the slot number for workers. Show "Agent" and "Definition version" from `definition`.
- `types.ts` inspection schemas gain `role`.

## Docs

- `docs/operations/agent-teams.md`: rewrite the configuration section. One published agent. No lead or worker agents, no agent IDs, no bootstrap restart. The optional `coordination` block carries limits only. Keep the send-and-control section and the Inspector section; update the role table to say every role runs the agent's own model and grants with a system overlay.
- `docs/reference/runtime-configuration.md`: the Coordination section documents `TeamDefaults` only; remove the `leadAgentId` and `workerAgentId` rows and the "Publish ... lead and worker agents" sentences.
- `docs/architecture/slack-coordinator.md`: the roles table loses the "Usually stronger / Usually cheaper" model column; say roles derive from the agent's pinned definition. Replace "saves its lead and worker definition pins" with "saves the agent pin".
- `docs/architecture/overview.md` and `README.md`: fix the sentences that say to publish three agents or enable a coordination profile.

## Tests

Contracts: `tests/contracts/work-contracts.test.ts` builds v3 admissions and asserts the new filter; recompute any hard-coded digests. `tests/contracts/bot-routing.test.ts` adjusts its admission fixture.

Runtime fixtures and tests: `coordinator-fixture.ts`, `fixture-coordinator.ts`, `fixture-team.ts`, `team-provenance-fixture.ts`, `team-terminal-fixture.ts`, `inspection-occurrence-fixture.ts`, `inspection-fixture.ts`, and the tests `team-completion`, `event-migrations`, `inspection-native`, `inspection-expired`, `coordinator-work`, `coordinator-queue`, `conversation-publication` build one agent and v3 admissions. `team-runtime.test.ts`: replace "published role models" with a test that every role runs the agent's model and the lead and worker instructions carry their overlay in front of the agent's instructions; replace "receiving worker grants and lead grants both gate" with a test that a role is denied exactly when the agent's current grants deny it. Add a contracts test that `TeamDefaultsSchema` decodes `{}` to the defaults and that the v3 filter rejects a mismatched agent ID. Add a runtime test that `requireRoleConfigurations` rejects a version mismatch and a wrong count.

Channels: `coordinator-policy.test.ts`, `team-events.test.ts`, `team-reports.test.ts`, `inspection-support.ts`, `inspection-ui-data.ts`, `inspection.test.ts` adjust fixtures. Integration: `tests/integration/runtime-configuration.test.ts` tests the optional block and the rejection of agent IDs.

Native Docker suite under `tests/channels/native/`: `team-support.ts` and `web-team-support.ts` publish one agent and stop patching `coordination`; `web-coordinator.test.ts` test "a profile-free primary keeps ordinary coordinator chat without ... Team execution" inverts: a primary with no block can start a Team. Tests that identify roles by distinct wire models (`wireModels.lead`, `wireModels.worker`) must identify them by role conversation instead; the fake provider in `tests/slice-1/persistent-responses.mjs` already chooses replies by offered tools, so one wire model serves every role. Make these sources type-check and keep their intent; the lead runs the suite.

## Standards

- Read /Users/jhonsfran/repos/cerebro/.claude/CLAUDE.md and follow it. Run `pnpm check`; `pnpm fix` is allowed for formatting.
- No narrating comments. No compatibility branches for the old profile. No optional fields "for later".
- Work contracts first, then let `pnpm check-types` walk you through runtime, server, web, tests, docs.

## Done when

1. `pnpm check-types`, `pnpm check`, `pnpm test:contracts` pass.
2. `rtk proxy grep -rn "leadAgentId\|workerAgentId\|resolveRolePins\|CoordinationProfile\|RolePin\b\|isCoordinatorConversation\|allowLegacyUser" apps packages tests docs deploy --exclude-dir=node_modules --exclude-dir=dist` reports only files under `docs/plans`.
3. A runtime test proves a Team composed from one agent runs a lead and workers whose instructions start with the overlay and whose model equals the agent's.

Do not run the Docker suites; the lead runs them after review. Report the exact commands you ran with results, every file deleted, every change outside this brief and why, and anything in the brief that was wrong.
