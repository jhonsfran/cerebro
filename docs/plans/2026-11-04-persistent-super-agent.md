# Persistent coordinator implementation

Each agent owns one coordinator conversation per organization and person. Web chat and filtered Slack events enter that conversation. Independent work runs in private Team cells. Development shows the saved execution state through an authorized Inspector.

## Workflow

- [x] Read Poteto Mode and its Principles section.
- [x] Phase A: Frame.
- [x] Create `codex/persistent-super-agent` from `4f73e008`.
- [x] Phase B: Design the workflow.
- [ ] Phase C: Run the loop.
- [x] Unit 1: Bind each agent to one persistent conversation and open it from the web.
- [x] Unit 2: Admit independent work with two active teams and sixteen queued items per person.
- [x] Unit 3a: Admit durable coordinator events and reports with atomic delivery intent.
- [x] Unit 3c: Make private-team provenance imports atomic and recoverable.
- [x] Unit 3b: Route explicit task subscriptions and one-time team handback.
- [x] Unit 4a: Connect ordered web events, work causes, controls, and recall.
- [x] Unit 4b: Apply published coordinator definitions safely within the same conversation.
- [x] Unit 4 context: Preserve native compaction when the model request reaches its byte limit.
- [x] Unit 4c: Connect Slack primary events and exact event replies.
- [x] Unit 4d: Preserve legacy admission and forward saved timers through controlled cutover.
- [x] Unit 5a: Add protected saved-state inspection and safe terminal Team reads.
- [x] Unit 5b: Add the development Inspector UI with lazy detail loading.
- [x] Unit 6a: Repair model-visible event references and saved history/Inspector projections.
- [x] Unit 6b1: Repair native runtime verification at actual event and storage boundaries.
- [x] Unit 6d1: Preserve later subscription mutations when native tools replay.
- [x] Unit 6d2: Give Inspector tools distinct occurrence identity across native rounds.
- [x] Unit 6b2a: Add realistic provider and Slack fixtures with exact test cleanup.
- [ ] Unit 6b2b: Prove persistent-agent routing, subscriptions, queue limits, and Inspector through the native application.
- [x] Unit 6 docs: Document primary continuity, event routing, private Teams, and development inspection.
- [x] Unit 6 Stop verification: Observe a streamed partial before checking interrupted output.
- [ ] Unit 6: Complete the cutover, remove obsolete routing, and prove the full product flow.
- [ ] Phase D: Keep the audit trail throughout the run.
- [ ] Phase E: Verify and hand back.

Each implementation unit ends with focused checks, a fresh specification review, a fresh thermo-nuclear review, accepted fixes, and a separate commit. Reviews cover comments and unnecessary abstractions. The parent checks the actual diff and evidence before each commit.

Event admission and team handback have different crash and authorization boundaries. Each receives its own checks and fresh review. The confirmed private-team provenance repair has a separate commit between them.

Unit 3c repairs a confirmed existing transaction error before team event integration. Real Pi and SQLite probes showed that rejected team admissions and worker handoffs could retain raw dependency rows. Canonical role imports must commit with the handoff. The raw dependency store becomes an authorized, retryable mirror of accepted imports.

Unit 4b fixes the permanent definition pin exposed by a persistent conversation. Its design keeps one scope and uses a complete immutable execution profile. A native applied-version change and Pi configuration commit together. New event delivery uses a durable version claim before native input admission. Design alternatives and the independent comparison are retained in the run's evidence.

Unit 4 uses separate runtime, profile, Slack, and cutover commits. The runtime commit keeps current tool selections. The profile commit then adopts coordinator-only tools after old native calls drain, including when the published definition is unchanged. Slack and timer adapters build on that coherent profile gate.

Unit 4a sends web input through owned events and preserves the original operation ID in receipts, pending input, and history. Foreground Stop marks pending event tasks before acknowledgement. Native causes prevent reports from authorizing new work. Independent reviews also fixed permanent settlement rejection and two legacy replay cases. The actual HTTP and celld probe passed on the final source, and its disposable stack was removed.

Unit 4b adopts the complete definition and capability policy after native work drains. Owned event admission checks source and content access while model access is checked for execution. Review and native tests fixed failed staging, stale authorization denials, and publication races. The HTTP probe preserves chat identity, replay, saved fork pins, and the adopted model over a process kill. All three final reviews pass.

Long-chat verification found an existing model-boundary error. A ninth full-length input reaches the serialized request byte cap before Pi's token threshold. The adapter treated the thrown local error as a connection failure. The separate repair returns the supported local overflow response so Pi uses its existing compaction task. It keeps the byte limit and adds no scheduler or guessed token conversion. Actual Pi tests cover repeated compaction, retained entries, replay, reopen, and current authorization. The final HTTP build completed fourteen long inputs and their exact replays without added replay calls. Native recovery still requires a selectable cut and a summary that fits.

Unit 4c maps filtered Slack events to canonical primary conversations. Its external receipt freezes exact owner and bot targets. Exact native settlement saves the reply intent in the same transaction, so concurrent web answers cannot reach Slack. Independent reviews found and fixed lost rate-limit deadlines and local reply progress. The final source passed the PostgreSQL suite and native signed Slack checks. A forced process stop during a delayed reply recovered through the existing alarm without a model or chat-reader wake. The reply checks current link and content access before each post and never repeats an uncertain post. Literal legacy decisions and their digests remain readable.

Unit 4d closes fresh input on historical roots and forks while accepted inputs, controls, reports, history, and saved timers continue. Canonical schedules and fixed origins commit before raw timer arming. A generic existing wake recovers the arm. Legacy occurrence checks prevent a second execution after the old native-acceptance boundary. Fresh reviews also found and fixed a historical Slack reply authorization mismatch. The final native check retained archived fork history and pins and delivered one full 32,000-character routine after a same-volume process kill before any chat read. The actual old-binary upgrade also passed on all seven original volumes. A retained Slack request finished once on its archived source, and its saved timer sent one reply to the original thread through the primary. Stopped read-only copies proved the original native IDs and exact receipts before application reads. Ancient aborted inputs with no retained payload or accepted digest fail closed because exact replay cannot be proved.

Unit 5a adds current-read inspection of owned work, events, and selected private roles through one existing Harness. Explicit bounded DTOs show saved models, safe tools, tasks, reservations, tokens, and results. Fresh reviews removed an overbroad private query type and a duplicate provenance rule. Actual app checks cover active inspection, missing-model unavailability, report delivery, and cold sealed reads after role and model removal. Repeated sealed reads preserve results and usage without added provider calls. The separate crash between report commit and unfinished role cleanup remains a final verification gate.

Unit 5b adds the local Inspector below the chat toolbar. It loads one selected Team and bounded role pages, with one timer after completed reads. Independent mounted probes found and fixed a sealing transition that left partial output visible. The shared transport also rejects cancelled responses before they can clear current access. Browser layout and live-model verification remain final product gates.

The approved architecture is the design baseline. Read-only grounding checks its integration points. A second architecture competition is unnecessary unless the implementation disproves the design.

Grounding confirmed that Pi Durable 1.3.0, agents 0.26.0, and celld 0.6.1 already provide durable tasks, queues, and lifecycle alarms. The implementation reuses those mechanisms. A report transaction creates a saved delivery task because the public Pi transaction API does not admit a conversation input directly.

## Data and ownership

- `PrimaryBinding` identifies one conversation by organization, person, and agent ID. Channel, published version, and creation operation do not define continuity.
- A `BotEvent` has a stable identity, a checked digest, its source, and a reply destination.
- A `WorkItem` contains one independent goal, pinned role definitions, a deadline, status, and terminal receipt.
- A `Subscription` connects an external thread to explicit work. The primary chat is not automatically subscribed to an active task.
- The existing identity cell holds coordinator state. Each admitted team uses its own existing Team cell. Workers remain private Pi conversations within that cell.
- Existing Pi tasks, outboxes, queues, and lifecycle wakes provide durable execution. Add no parallel scheduler or in-memory job runner.

## Required behavior

The coordinator handles conversation, new tasks, ambiguity, cross-task decisions, status, cancellation, and recall. It does not execute task tools. Deterministic filters run before model judgement. Explicit task follow-ups can reach subscribed work directly. Unrelated events return to the coordinator once.

A published coordinator definition applies at a safe turn boundary in the same conversation. An active turn retains its original definition. Existing team role pins remain unchanged. Refresh must replace the provider, tools, and authorization configuration together and recover consistently after interruption. Merely changing Pi instructions would leave old policy closures active.

Multiple goals in the primary chat create separate work items. Capacity waiting does not block the coordinator. Queue time counts toward the absolute deadline. Overflow is explicit. Cancelling queued work creates no Team cell. Cancellation of dispatched work retains its slot until a terminal acknowledgement or its deadline.

The queue is FIFO across a person's agents. Each coordinator promotes only its own item when that item is at the queue head. Every waiting coordinator retains a lifecycle wake. A head owned by another coordinator can add one five-second wake interval before dispatch. New work never bypasses that head. This keeps each dispatch under its correct source permissions without a second shared dispatch registry.

Reports become internal coordinator events. The report receipt and event intent commit atomically. The coordinator controls public replies. Logical deduplication does not promise exactly-once physical model billing.

The coordinator stores compact summaries, IDs, and references. Recall loads bounded pages. Worker transcripts do not enter the primary context automatically.

## Inspector

The Inspector shows active and completed work, lead and worker models, saved status, tool activity, retries, request reservations, provider usage, and results. It loads private details on demand. Current owner, source, and content access apply to every read. Inspection can load a cell but must not create new model work. It excludes credentials and provider-private reasoning. Development visibility is not authorization.

Unit 6a closes integration gaps found by the full runtime baseline and actual browser. The coordinator receives the admitted Slack event reference. History search recognizes real web-event inputs while preserving hidden-event boundaries. Paged tools report unknown when their result is outside the page. Selected Inspector source status follows report settlement after private cleanup seals, with no further private polling. Real Pi and mounted regressions pass, including the original independent stale-status probe. Final native, browser, realistic-conversation, and live-provider checks remain required.

Unit 6b1 repairs native verification at the actual saved event and storage boundaries. Public operation IDs remain distinct from native event, input, and entry IDs. The real lost-response injector joins the exact committed submission and entry. Safe physical correlation proves replacement-host completion before source readers. Both native fault cases pass through replay and later progress. The initial run exposed assertions for deliberately omitted raw log text. The revised checks use the existing sanitized failure event with the exact identity and committed witness time. The full runtime and application-native gates remain pending, as do the two separate production audit repairs.

Unit 6d1 saves each subscription mutation result with both relation directions in the existing native transaction. Exact native task replay returns its original result after current authority checks, without undoing a later subscription change. Real Pi and SQLite regressions cover both orders, no-ops, terminal Work, changed requests, revoked access, and rollback. All three fresh reviews pass. The 125 focused tests, normal workspace type checks, and 165 PostgreSQL channel tests pass. The receipt cannot reconstruct mutations made by intermediate unshipped development builds that never saved it. The pre-task release had no subscription tools; that development-state limit is retained explicitly. Inspector occurrence identity and the final product gates remain pending.

Unit 6d2 gives each Inspector tool occurrence a stable native-entry key and a separate displayed provider call ID. Live status requires the exact current generation and full private call ID. One existing task read proves the round on a latest live page; historical and settled pages add none. Real Pi tests cover repeated IDs, pending calls, orphan results, full caps, and matching display prefixes. Mounted tests preserve distinct rows and prior output. Fresh reviews removed an unnecessary null state from the bounded result join. The final revision passes 16 runtime tests, 13 workspace type tasks, scoped lint, and all 166 PostgreSQL channel tests. All three final reviews pass. Final native and browser gates remain pending.

Unit 6b2a adds distinct storage and Slack task fixtures with actual incoming tool-result joins and trusted event references. The Slack boundary can accept one exact post, persist it, then return an uncertain response. Reopening retains consumption without fake physical deduplication. Fresh reviews fixed failed-worker text that OpenAI transports without an error flag and replaced static-answer test echoes with independent contributions. All 16 focused cases pass. The public channel runner and its external-database path each pass all 166 tests. Controlled test-process failure also cleans up its exact owned database. The external path makes zero Docker calls. Test PostgreSQL uses labelled tmpfs and creates no volume. All final reviews pass. Actual test-image module bytes and full native, runtime, and browser gates remain pending.

Unit 6 documentation describes one persistent primary, filtered Slack events, bounded private Teams, and current-read development inspection. It gives a separate multi-model local configuration and same-chat publication steps. Three Skills UI strings now require publication after the current turn finishes. Review corrected a mistaken inference from an internal report's null reply destination. Saved Work origin lookup can authorize the coordinator's answer in the original Slack thread; a report grants no new destination. Final specification and thermo reviews pass on all twelve files. Workspace types, scoped lint, and the React error gate pass. Native acceptance, the repaired Stop verification, pilot migration, and final browser checks remain separate pending work.

The first complete runtime run on the current source executes 374 Node cases with 372 passes, two Stop-precondition failures, and no skips. Bun does not run after that failure. The two new interrupted-output assertions required a native partial but waited only for a provider request. The separate Stop verification change waits for actual nonempty streaming text and preserves every interruption, input, sibling wake, notification, and resume assertion. A fresh specification, thermo, and comment review passes. Both exact native cases now pass with zero skips; both actual images match all 288 frozen runtime source paths. Their two owned stacks and every captured mount are removed. The full Node and Bun runtime command remains a final gate after fixture context repairs.

## Cutover

Inventory pending inputs, teams, outboxes, and future reminders. Pause old admission and timer delivery during transition. Settle old work and transfer future schedules idempotently. Preserve historical transcripts, signed source addresses, original digests, and legacy receipt codecs. Do not reset the database or merge histories.

After cutover, the primary alone admits new ordinary input. Historical roots and saved forks remain readable under their original pins and finish accepted work. Their saved operation receipts still replay. A dedicated admission record enforces this rule because retirement would also deny history, timer, and report access.

## Completion predicate

The running app must demonstrate all of these behaviors.

1. Concurrent opens, reloads, and published agent changes retain one primary conversation. The next safe coordinator turn uses the new definition.
2. Two unrelated realistic requests create distinct private teams while the coordinator remains responsive.
3. A third task queues, resumes after capacity returns, and can be cancelled before dispatch.
4. Duplicate Slack events produce one logical admission. Filters reject unsupported events before model use. Explicit subscriptions route follow-ups correctly.
5. Results return through the coordinator once and remain after reload.
6. The development Inspector shows lead and worker execution, including completed work, with no extra model dispatch from reading it.
7. A process kill recovers accepted work before any chat or Inspector reader opens.
8. Current access revocation blocks private reads and cross-identity access.
9. An isolated browser run exercises the actual UI. A bounded live-provider run uses the configured provider when available and records the model IDs without exposing keys.

Synthetic endpoints prove deterministic routing and recovery. Live models prove provider compatibility and realistic model behavior. They are separate evidence.

## Throughput checkpoint

The implementation spans contracts, channels, runtime, server, web, and native verification. Smaller commits separate event admission, provenance, subscriptions, source adapters, profile adoption, inspection reads, and UI. The highest risks are atomic result delivery, queue recovery, source authority, and future reminders. One source owner writes at a time. Read-only investigation and reviews can run in parallel. Evidence and review findings are retained with each unit.

The decision trail is [persistent-super-agent-decisions.tsv](persistent-super-agent-decisions.tsv).
