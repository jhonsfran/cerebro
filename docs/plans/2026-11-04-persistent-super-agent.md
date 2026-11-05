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
- [ ] Unit 4a: Connect ordered web events, work causes, controls, and recall.
- [ ] Unit 4b: Apply published coordinator definitions safely within the same conversation.
- [ ] Unit 4c: Connect Slack primary events and exact event replies.
- [ ] Unit 4d: Preserve legacy admission and forward saved timers through controlled cutover.
- [ ] Unit 5a: Add protected saved-state inspection and safe terminal Team reads.
- [ ] Unit 5b: Add the development Inspector UI with lazy detail loading.
- [ ] Unit 6: Complete the cutover, remove obsolete routing, and prove the full product flow.
- [ ] Phase D: Keep the audit trail throughout the run.
- [ ] Phase E: Verify and hand back.

Each implementation unit ends with focused checks, a fresh specification review, a fresh thermo-nuclear review, accepted fixes, and a separate commit. Reviews cover comments and unnecessary abstractions. The parent checks the actual diff and evidence before each commit.

Event admission and team handback have different crash and authorization boundaries. Each receives its own checks and fresh review. The confirmed private-team provenance repair has a separate commit between them.

Unit 3c repairs a confirmed existing transaction error before team event integration. Real Pi and SQLite probes showed that rejected team admissions and worker handoffs could retain raw dependency rows. Canonical role imports must commit with the handoff. The raw dependency store becomes an authorized, retryable mirror of accepted imports.

Unit 4b fixes the permanent definition pin exposed by a persistent conversation. Its design keeps one scope and uses a complete immutable execution profile. A native applied-version change and Pi configuration commit together. New event delivery uses a durable version claim before native input admission. Design alternatives and the independent comparison are retained in the run's evidence.

Unit 4 uses separate runtime, profile, Slack, and cutover commits. The runtime commit keeps current tool selections. The profile commit then adopts coordinator-only tools after old native calls drain, including when the published definition is unchanged. Slack and timer adapters build on that coherent profile gate.

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
