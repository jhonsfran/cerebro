# Super-agent simplification

Five architectural changes move `codex/persistent-super-agent` closer to the two-level super-agent design and make it easier to configure and extend. Each change lands as its own verified unit on this branch.

## Workflow

- [x] Read Poteto Mode and its Principles section.
- [x] Phase A: Frame.
- [x] Phase B: Design the workflow.
- [ ] Phase C: Run the loop.
- [x] Unit 1: Delete the fork feature.
- [x] Unit 2: Delete legacy input, legacy Slack, legacy timer, and the source cutover state machine. Landed as fe6d4db; channel suite green; the runtime and integration suites had not finished when the run paused.
- [ ] Unit 3: Derive Team lead and worker roles from the coordinator agent's own published definition. In progress in worktree branch `worktree-agent-a707f34a5d111aa22` off fe6d4db.
- [x] Unit 4: Prototype Pi `followUpMode: "all"` answer attribution before the inbox rewrite. Answered by reading Pi: every input placed in one run settles with one answer entry.
- [ ] Unit 5: Admit coordinator events straight into Pi's inbox, batch bursts, and reply through a tool. Merged with Unit 6; in progress in worktree branch `worktree-agent-ae1c3bb6c5b5b94da` off fe6d4db.
- [ ] Unit 6: Generic trigger contract with a per-source policy and a generic thread key. Merged into Unit 5.
- [ ] Unit 7: Run Team workers as Pi child tasks and replace schema caps with per-agent budgets. Brief written; not started.

## Resume

1. Check the delegate worktrees under `.claude/worktrees/` for uncommitted changes on the two branches above. Review each diff, commit on its branch, rebase the trigger branch onto the Unit 3 commit, and fast-forward `codex/persistent-super-agent`.
2. Run `pnpm check-types`, `pnpm test:contracts`, `pnpm test:channels`, `pnpm test:runtime`, and `pnpm test:integration` after each landing. Baselines before this run: runtime 374 pass, channels 196 pass, integration 83 pass.
3. The briefs and the two design arenas live in `super-agent-simplification-briefs/`. Unit 7 starts from `unit7-workers.md` once Units 3 and 5 have landed.

- [ ] Phase D: Keep the audit trail throughout the run.
- [ ] Phase E: Verify and hand back.

## Done

The run is done when every statement below is true on this branch.

1. No fork route, button, contract, or runtime path exists. `pnpm check-types`, `pnpm test:contracts`, `pnpm test:channels`, and `pnpm test:runtime` pass.
2. No legacy input, legacy Slack decision, legacy timer origin, retired-event, or source cutover code exists. Every conversation is the agent's primary conversation.
3. A newly published agent can start a Team with no `coordination` block in `runtime.json` and no second or third published agent. The lead and workers run under that agent's pinned definition and grants.
4. A burst of web messages sent while the coordinator is busy is answered in one coordinator turn, and Slack replies are posted by an explicit reply tool call.
5. Slack is one trigger adapter behind a generic trigger contract. A Team subscribes to its origin thread automatically.
6. Team workers are Pi child tasks of the lead. Team limits are budgets on the agent, not bounds in the schema.

## Assumptions

- No installation holds data created before the persistent primary cutover. Legacy codecs are deleted, not migrated.
- Work happens directly on `codex/persistent-super-agent`, as the user asked.

## Rigor

High. Contract changes alter durable state formats, so each unit ends with the full type check, the contract tests, and the Docker-backed suite that covers the touched package. The decision trail is [super-agent-simplification-decisions.tsv](super-agent-simplification-decisions.tsv).
