# Super-agent simplification

Five architectural changes move `codex/persistent-super-agent` closer to the two-level super-agent design and make it easier to configure and extend. Each change lands as its own verified unit on this branch.

## Workflow

- [x] Read Poteto Mode and its Principles section.
- [x] Phase A: Frame.
- [x] Phase B: Design the workflow.
- [x] Phase C: Run the loop.
- [x] Unit 1: Delete the fork feature. Commits `f94aeac`, `5e37d06`.
- [x] Unit 2: Delete legacy input, legacy Slack, legacy timer, and the source cutover state machine. Commit `fe6d4db`, followed by `7c26c82`, which drops the conversation tool journeys the deleted profile used to run.
- [x] Unit 3: Derive Team lead and worker roles from the coordinator agent's own published definition. Commit `b5e7e0c`, with the journey assertion fix `fcdf2ec`.
- [x] Unit 4: Prototype Pi `followUpMode: "all"` answer attribution before the inbox rewrite. Answered by reading Pi: every input placed in one run settles with one answer entry.
- [x] Unit 5: Admit coordinator events straight into Pi's inbox, batch bursts, and reply through a tool. Merged with Unit 6 as `12ea4de`, with the liveness fix `7d5a3b5`.
- [x] Unit 6: Generic trigger contract with a per-source policy and a generic thread key. Merged into Unit 5.
- [x] Unit 7: Run Team workers as Pi child tasks and replace schema caps with per-agent budgets. Commit `cf7bfd2`.
- [x] Phase D: Keep the audit trail throughout the run.
- [x] Phase E: Verify and hand back. On `7d5a3b5`: types 13 of 13, lint clean, contracts 53 pass, channels 167 pass, runtime 311 node and 2 bun pass, integration 74 pass.

- [x] Unit 8: Teams run the agent's full tool set; a Team tool that needs approval asks the coordinator conversation, the person decides in web chat, and the decision returns to the Team. The coordinator keeps coordination tools only. Commit `6b935c5`.

## Found during the run

- After the persistent primary cutover, nothing in the product ran a connector tool that writes: the coordinator advertised no connector tools and Teams filtered to read-only tools. Unit 8 gives Teams the agent's full tool set with approvals in the coordinator chat; the coordinator stays coordination-only by the user's decision.
- The run bumped stored document versions and rejects older ones. That also rejects data created by this branch's own earlier commits, so a local stack that ran the branch before this run fails to open conversations with `Unsupported conversation bindings version`.
- The trigger drain places input with `Conversation.submit`, which skips the harness's own wake job. `7d5a3b5` keeps the coordination alarm armed while Pi holds unsettled input.
- Batching depends on model latency: triggers merge only when they arrive while a turn runs.
- A run that ends on a provider error leaves queued follow-ups in Pi's inbox until the next input arrives. The deleted delivery task had the same exposure.
- One inconsistent backlog entry stops the drain for its conversation until Stop clears the backlog.
- A celld restart can be followed by a Pi storage-error reset of an identity. The cause is unknown and predates this run.

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
