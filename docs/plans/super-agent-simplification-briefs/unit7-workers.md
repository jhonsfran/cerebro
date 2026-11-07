# Unit 7: workers as Pi child tasks, limits as budgets on the agent

Repository: /Users/jhonsfran/repos/cerebro, branch codex/persistent-super-agent. Units 1 to 3 have landed on the base commit you start from: Team roles derive from the agent's pinned definition (one `agent` pin in `WorkAdmission`, `teamRoleDefinition` and `teamRoleSlots` in `packages/runtime/src/team-composition.ts`, `TeamDefaultsSchema` for installation defaults). Do not commit; the lead reviews and commits.

A parallel delegate is rewriting the coordinator event pipeline (Units 5 and 6) on an earlier base: it replaces `coordinator-events.ts`, `coordinator-event-*.ts`, `conversation-event-scope.ts`, `coordinator-replies.ts`, `bot-events.ts`, `bot-routing.ts`, `saved-timer-*.ts`, `instruction-cause.ts`, `coordinator-subscriptions.ts`, `coordinator-web.ts`, `coordinator-report.ts`, `coordinator-event-content.ts`, and the event wiring in `session-agent.ts` and `conversation-scope.ts`. Do not edit those files beyond what a type error forces. In `coordinator-work.ts` keep your change to how the admission's `limits` are computed. The lead rebases the trigger branch onto yours afterwards.

## Why

Today a Team pre-creates one lead and exactly `maxWorkers` worker conversations, tracks them in `TeamState.workers` slots, and `delegate_worker` hands one question to a free slot and waits. The limits live in `WorkLimitsSchema` with hard bounds (two workers, eight model calls, ten minutes) that no agent can exceed. After this unit the lead delegates by creating Pi child conversations on demand, several in one tool round run in parallel, and the limits are budgets published with the agent, with installation defaults.

## Decisions

1. A worker is a fresh Pi conversation owned by the lead's `delegate_worker` tool task, created when the tool runs, configured from the worker projection of the pinned agent (`teamRoleDefinition(agent, "worker")`), and reused by the same call after a restart (the call's memo holds the child id and the submission request id, the pattern the deleted foreground subagent tool used; see git history of `packages/runtime/src/conversation-work.ts` at commit fe6d4db for the replay-safe shape, and Pi's `test/examples/22-subagent-foreground.ts` in node_modules for the primitive). The tool submits the question with `requestId = worker:<taskId>`, waits for the answer, imports the child's content dependencies into the lead, and returns the text. No worker slots, no pre-created worker conversations, no `TeamState.workers` array; `TeamState` keeps `lead`, `phase`, `pending`, `requests`, `report`, `modelCalls`, and gains `children: Record<string, { nativeId, ownerTaskId, startedAt }>` for the Inspector.
2. Parallelism comes from Pi: the lead may issue several `delegate_worker` calls in one round and Pi's default `toolExecution: "parallel"` runs them at once. `maxWorkers` becomes the bound on children alive at the same time; a call beyond it returns a tool error telling the lead to wait for running workers.
3. Limits become budgets on the agent. Add an optional `team` section to `AgentDefinition` in `packages/contracts/src/session.ts`: `{ limits?: { maxWorkers?, maxTurns?, timeoutMs? } }`, validated at publish in `packages/channels/src/service.ts` with `AgentTeamSectionSchema` (new, in contracts). `resolveWorkLimits(agent, defaults)` picks the agent's value over the installation default field by field; `maxTeams` stays installation-only. Widen `WorkLimitsSchema` to safety bounds instead of product caps: `maxWorkers` 1 to 8, `maxTurns` 1 to 256, `timeoutMs` 1 s to 4 h. `TeamDefaultsSchema` keeps today's defaults (2, 8, 600000) so an unconfigured agent behaves as today. The admission snapshots the resolved limits as it does now.
4. The web agent editor gains a collapsed "Teams" field set with the three numeric budgets (empty means installation default). `apps/web/src/features/product/types.ts` must declare `team` on the agent detail schema so a republish does not strip it. Keep the UI small.
5. Tool policy for Teams stays read-only with no approval tools. Routing approvals from a Team to the coordinator is out of scope; say so in the docs.
6. The model-call budget keeps counting lead and children together through the existing `reserveModelCall` hook, now installed on child conversations too.
7. Completion stays as it is: the lead's final answer is the report. A child that is still running when the lead answers is aborted by the completion path as today's abort does for workers.
8. Inspector: `InspectionRole` entries come from the lead plus `TeamState.children`; a child row shows its model, owner task, and status. Slots are no longer `0 | 1 | 2`.

## Delete

- `TeamState.workers` and its slot bookkeeping; the worker pre-creation loop in `team-runtime.ts` `receive`; the `1 + maxWorkers` configuration count and per-slot addresses in `team-content.ts`, `team-runtime.ts`, `apps/server/src/team-agent.ts`, and `apps/server/src/session/team-inspection.ts` (the lead keeps index 0; children derive addresses from their creation sequence).
- The product caps in `WorkLimitsSchema`.

## Tests

- Runtime: two `delegate_worker` calls in one round create two children that both answer and the lead combines them; a third call beyond `maxWorkers: 2` returns the wait error; a restart between child creation and the answer reuses the same child and submission; the model-call budget counts children; a Team with `team.limits` on the agent runs under those limits while an agent without them uses the installation defaults; the Inspector lists the children. Port `team-runtime.test.ts`, `team-completion.test.ts`, `team-events.test.ts`, `team-provenance.test.ts`, `team-terminal.test.ts`, `inspection-*.test.ts`, and the fixtures `fixture-team.ts`, `team-provenance-fixture.ts`, `team-terminal-fixture.ts`, `inspection-fixture.ts`, `inspection-occurrence-fixture.ts`.
- Contracts: `AgentTeamSectionSchema` accepts an empty section and rejects out-of-range values; `resolveWorkLimits` layering.
- Channels: `publishAgent` round-trips `team`; the editor fixture in `tests/channels` saves and reloads it.
- Native suites under `tests/channels/native/` type-check and keep their intent; the lead runs them.

## Docs

- `docs/architecture/slack-coordinator.md` roles table and limits section; `docs/operations/agent-teams.md` limits and the editor section; `docs/reference/runtime-configuration.md` Coordination section (defaults and safety bounds); note that Team tools stay read-only.

## Standards

- Read /Users/jhonsfran/repos/cerebro/.claude/CLAUDE.md and follow it. Run `pnpm check`; `pnpm fix` is allowed for formatting.
- No narrating comments. No compatibility branches. Contracts first, then let `pnpm check-types` walk you through runtime, server, web, tests, docs.

## Done when

1. `pnpm check-types`, `pnpm check`, `pnpm test:contracts` pass.
2. `rtk proxy grep -rn "workers\[\|maxWorkers + 1\|slot === 0\|Literals(\[0, 1, 2\])" packages apps --exclude-dir=node_modules --exclude-dir=dist` reports nothing.
3. The runtime tests above pass under `node --test` on the files you changed.

Do not run the Docker suites; the lead runs them after review. Report the exact commands you ran with results, every file deleted, every change outside this brief and why, and anything in the brief that was wrong.
