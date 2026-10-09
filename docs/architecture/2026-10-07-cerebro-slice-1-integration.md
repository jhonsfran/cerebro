# Cerebro first-slice integration record

The coordinator integrates the first slice on `codex/cerebro-slice-1`. The recorded trunk is `1855fed13aafee0e7a3369f3e684564f35715086`. Application acceptance remains incomplete. No application merge to main, deployment or customer-data cutover is part of this operation.

## Imported packets

The coordinator verified the pushed packet heads and imported them locally in the plan's B, A, C, D order.

| Packet | Reviewed head | Integration merge |
| --- | --- | --- |
| S1-B, authority and tools | `d4251caf25bc5254738f947953293942dfd58ec0` | `2e5c4d968682a327d7c2663d1e6d8d7bb1bd9a37` |
| S1-A, native Pi runtime | `1e6ed8cb7af453707b643b20d47fb0b29713b8bd` | `42f0b735325b54403bab28e6155119528123ad4d` |
| S1-C, authorized observation | `2e4213a325c022c2b571280f6bd5fbf93f7533b6` | `d7d991ba5c6e9f5794d20e5175bbdb10caf50df5` |
| S1-D, isolated fixtures | `a167245c2088766656939fb7d6ea2cd0b0006656` | `7e043e324592fdf6cf819fed8e82c1afac95cb0a` |

GitHub PR #2 is merged into the integration branch. PRs #4, #3 and #1 remain draft packet PRs against that branch. Packet results do not establish application acceptance. Corrected S1-0 remains `46a44e199b3bf43173602ea609f40a0b6958f201`.

## Shared composition and caller migration

The coordinator owns shared contracts, package pins, Effect Layers, server composition, API callers, channel callers and final local acceptance. Official PiHarness and Lifecycle own the native inbox, steering, Stop and engine wake-up. Cerebro owns authorized command intents, replacement phase, approvals, durable tool receipts, canonical product history and projection repair.

Native joined execution produces one canonical answer with exact execution and answer identities. Cerebro commits its answer, execution membership and completed runs in one projection batch. Partial text remains ephemeral. The [contract revision](2026-10-05-cerebro-slice-1-contracts.md#joined-execution-and-answer-identity-coordinator-revision-2026-10-07) defines these invariants.

Commands, history and observations use current company access. Private DO calls require a signature bound to the address and body. Delivery checks authentication and content grants on attach and every 2 seconds. A denied access generation clears protected browser state and stops reconnect. The Durable Object emits observation frames. The API forwards them as bytes. The web app keeps one projection for the transcript, controls and citations. The [chat simplification design](../superpowers/specs/2026-10-09-chat-simplification-design.md) records the change from the AG-UI and TanStack wire that this record first described. Reconnect restores a fresh snapshot and live updates without a model submission or persisted cursor replay.

Memory input includes authorized excerpts and provenance before physical model dispatch. The server checks the actual serialized request size. Audit projection uses stable event identities and a retained outbox. Approvals and confirmed or uncertain remote effects retain their original bindings.

Active OpenCode, AI SDK, local-budget, paid-work and Unprice execution paths are removed. External metering remains unbound. Historical migrations, usage, audit, auth records and authorized exports remain. Final dependency acceptance requires fresh resolved graphs and active bundle scans.

## Selected integration

Exact requests and source evidence remain in `tests/pi-durable-qualification/dependency-requests.json`. The selected pins are celld 0.6.1 at `sha256:acb0bc2dca628f0dac7c6b43eea42615a79f4943f316f6df7c1da0b86d52150b`, Agents 0.26.0, Pi Durable and Pi AI 1.0.4 and Effect 4.0.1. The TanStack AI and AG-UI pins were removed on 2026-10-09.

The host uses `nodejs_compat`. The deterministic application fixture sets `CELLD_WAKER_TICK_MS=1000`. Each clean boot records immutable derived application images. Functional recovery evidence does not replace the sixty-second performance gate.

## Executed candidate checks

Candidate `db0693c6b745f4ff0de92d265b97044a550e41e0` passed the following checks. These results apply to that commit only. A later source correction requires new evidence.

- `rtk proxy pnpm test:runtime` passed 86 tests with no failures or skips, including actual host crash and uncertain-write cases. Log: `/tmp/cerebro-s1f-db0693-runtime.log`.
- `rtk proxy pnpm check-types` passed 14 tasks. `rtk proxy pnpm build` passed 12 tasks. Logs: `/tmp/cerebro-s1f-db0693-types.log` and `/tmp/cerebro-s1f-db0693-build.log`.
- `rtk proxy pnpm test:contracts` and `rtk proxy pnpm test:identity` passed. Logs: `/tmp/cerebro-s1f-db0693-contracts.log` and `/tmp/cerebro-s1f-db0693-identity.log`.
- Complete pilot attempt 6 passed ten enabled gates with no failures or skips on clean fixture `cerebro-s1-pilot-1a19fcda`. Evidence is under `artifacts/slice-1/db0693c6b745f4ff0de92d265b97044a550e41e0/cerebro-s1-pilot-1a19fcda/`. It includes actual approval expiry, denied admissions, physical crash recovery and a fresh seven-store restore. Raw private log: `/tmp/cerebro-s1f-pilot-attempt-6.log`.

Earlier failed pilot attempts remain retained. One clean candidate reached native DONE while its product run remained running. Its first observer error was not recorded. A later pass does not resolve that failure. The coordinator adds durable, pure projection repair and failure-injection proof before acceptance. Repair must not submit again, call Stop, change canonical identities or weaken membership checks.

The thirty-second repair bound applies to the coordinator's observation pass. Host initialization and storage flushes are outside that bound. A pending host write retains the singleflight owner until it settles. The separate sixty-second alarm performance gate remains required.

The corrected memory cleanup regression passed 24 tests during development. It accounts for the PostgreSQL clock before testing actual failed external deletion and retry. Backup checks passed four tests, including one actual seven-store backup and restore. These development checks require final-candidate verification. Baseline lint exceptions apply only by exact file and rule. No new changed-source failure is permitted. Historical failed and deferred S1-0 checks retain their statuses.

## Retirement acceptance

The cutover CLI stops old admission, workers, scheduling, dispatch and reply delivery. It retains all seven stores, then commits conversation retirement and queue quarantine. Restore reapplies the completed fence before an execution client starts. Old checkpoints remain available for offline inspection. New conversations use new Pi identities.

The first old-engine experiment preserved stores and exports, but its approved owner had failed before the physical fence. It did not prove retirement of a dispatch-eligible approved write. That limitation remains recorded.

The second disposable fixture, `cerebro-s1-oldcutover2-1007`, uses the baseline runtime with a disclosed fixture-only pre-dispatch barrier. Original public approval creates a requested invocation and queued owner with a live bound grant. Immediate SIGKILL leaves no dispatch attempt. Read-only native SQLite inspection confirms all seven ledger-row hashes match the fence observation. The fixture also contains an active turn, a due alarm, a fresh pending inbox event and a rearmed real local Slack reply. Full cutover and restore acceptance remains pending at the final candidate.

No real Slack message or customer record is part of these isolated fixtures. Private identities and retained stores stay outside the source commit.

## Merge on 2026-10-09

The operator merged the integration branch, with the [chat simplification](../superpowers/specs/2026-10-09-chat-simplification-design.md) on top, to `main` as the experimental baseline. The S1-F gates below remain open. Two Docker recovery fixtures in `tests/runtime/recovery.test.ts` fail on bucket durability expectations, `test:pi:live` has no private configuration, and the browser video and performance gates were not run. The pilot gate for the unknown-outcome receipt failed from `3176c2b` on because a follow-up rejected with 409 left its inbox row pending and the dispatcher resubmitted it after reconciliation; the synchronous submit path now drops such rows. The same gate then exposed that a transient projection failure after reconciliation was swallowed and never retried; reconcile now projects directly and the repair job projects on each pass. The merge records the current state; it is not the acceptance verdict this document describes.

## Remaining acceptance

Run the integrated unit, policy, memory, channel, host, qualification, boot, chat and integration checks at the final clean SHA. Complete independent permission and recovery review. Run a frozen install, inspect every active resolved graph, and verify legacy entry-point removal.

The separate `test:pi:live` gate requires a private `CEREBRO_PI_LIVE_CONFIG` with one configured live model and one real controlled MCP read. Missing configuration leaves this gate NOT_RUN.

Complete browser evidence for early text, approval, Stop, reconnect and revoked history. Save a 30 to 60 second actual interaction video. Measure five alternating trunk/head pairs, 100 native attach/detach cycles, ten concurrent turns, actual alarm recovery, adapter timings and idle memory. Preserve missing baseline metrics and failed attempts explicitly.

The final SHA, diff and acceptance report belong under `artifacts/slice-1/<tested-sha>/`. The ADR remains proposed. Deliver the application PR and a merge-ready verdict only after the required S1-F gates pass. The operator reviews the interaction before merge. Deployment and customer-data cutover require a separate operation.

## Earlier shared-contract evidence

Earlier S1-A follow-up `c11e65f6e1f35c6b6def715c575febded114c409` passed 26 runtime tests. Earlier S1-C follow-up `ea1897e94f20dd2c9d88c7c84844366558f3b79d` passed 82 packet tests and the coordinator's stale-denial regression. They ran in `/tmp/cerebro-packet-review.kicjiqwc/checkout` with packet diffs applied to baseline `f583d09a78885c43758eae0e022f707f0e2e7065`. The later packet heads above supersede them.

The shared identity revision passed 52 contract tests, 13 forced type tasks, focused contract types and changed-source formatting. Logs remain `shared-identity-contracts.txt` and `shared-identity-types.txt` under `/tmp/cerebro-packet-review.kicjiqwc/`. The S1-B import passed 56 authority/tool tests, nine identity tests, five forced type tasks and a frozen offline install. These preparation results are not final application acceptance.
