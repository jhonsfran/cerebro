# Candidate 1: Pi is the queue

## Problem

Every coordinator event today becomes a four-phase durable task that waits for its predecessor, claims a profile version, submits to Pi one at a time, and binds the run's single answer entry to the event so the outbox can forward it to Slack. We want events admitted into Pi's inbox directly, bursts batched into one turn (`followUpMode: "all"`), replies made an explicit model decision, and the task, predecessor wait, identity-wide queue and answer binding deleted. Constraints that shape the answer: a receipt and a Pi submission cannot share a transaction (`admitSubmission` is not exported; `submissions.d.ts:20-30`), so atomicity must come from idempotent re-drive on `requestId`; the publication must land before held inputs run; Slack posting keeps the outbox's post-time authorization; `start_team` must find a human cause in a run that mixes human and internal inputs; Stop, replay by operation ID, exact `status`/`stop`, and Team routing entry points stay.

Two Pi facts, checked in `node_modules/@earendil-works/pi-durable@1.3.0`, rule out the starting direction's gate. `beforeRequest` can only rewrite the messages of one attempt (`harness/types.d.ts:688-694`, `generation.js:117-121`); the hook runner catches a throw, reports it and continues (`scheduler.js:1502-1517`). The only lever a hook has on a run is to abort it, which `run-limits.ts:87-95` already does, and that settles the inputs `unanswered` with their `requestId` burned. The final boundary places all queued follow-ups and starts the next run in the same commit as the previous answer (`generation.js:426-444`, `inbox.js:35-71`), so nothing application-side can slip between "inputs waiting in Pi" and "inputs running". The gate therefore has to sit before `Conversation.submit`.

## Usage (caller's view)

_Admission._ Any source builds a `BotEvent` and calls `events.admit(admission, context)`. It returns the durable receipt after the submit landed or the gate held the event; `receipt.duplicates === 0` is the "accepted" bit the web and Slack acknowledgements already use.

```ts
// coordinator-web.ts (unchanged call)
const admitted = await options.events.admit({ version: 2, kind: "event-admission", event, routing }, context);
return { accepted: local || admitted.duplicates === 0, operationId, session };

// coordinator-report.ts: inside the admissions commit, then re-drive outside it
await options.events.enqueueIn(transaction, await coordinatorReportEvent(record, value));
…
options.waitUntil(options.events.drive(options.native.id));
```

_Lifecycle._ The `cerebro-coordination` job is the only re-driver:

```ts
const open = await scope.advancePublication(); // applies a pending refresh when drained
const pending = await events.wake(binding.nativeId); // submits staged IDs while the gate is open
const replies = await host.replies.hold(binding.nativeId);
return pending || replies || !open
  ? { rescheduleAt: Date.now() + 5000 }
  : outcome;
```

_Stop._ `await events.withdraw(native.id); await harness.abort({ session })` — staged events never reach Pi; Pi withdraws its own queued inputs (`inbox.js:110-119`).

_The model._ A batched turn is N consecutive user messages, each the existing per-kind phrasing with its `eventId`. The model replies to the outside world only through one tool:

```
reply_event({ eventId: "bot-event:…", text: "Done: the report is in #ops." })
→ "queued"                      // outbox posts with authorization at post time
→ error "no external destination; the transcript is the reply"   // web event
→ error "already replied"       // one reply per event
```

If a final answer leaves an external event unreplied, an `onYield` hook appends one nudge listing the IDs and continues the run; after that the event stays unreplied and the Inspector shows it.

## Shape

**Data.** `BotEventReceipt` shrinks to `input, digest, nativeId, duplicates, route`. There is no `delivery`, no admission state machine, no sequence number: whether an event reached Pi and how it ended are derived from `tx.submissionByRequest(nativeId, event.id)` (`admissionStateIn`), per single-source-of-truth. The one new document is `BotEventStaging { pending: string[] }` per conversation: the IDs whose submit has not been observed to land, in arrival order. It is appended in the receipt commit and removed in the commit after a successful submit; a crash anywhere leaves the ID staged and `drive` resubmits with the same `requestId`, which Pi dedups (`submissions.d.ts:22`). That list is also the publication gate: when `Bindings.refresh` is set, `gateIn` is false, IDs stay staged, Pi drains, `advancePublication` applies `configure` in one commit guarded by `nativeDrainIn`, and the next `drive` submits the backlog under the new definition. Holding and crash-recovery are the same mechanism, which is why no `held/claimed/submitted/settled` states, no `releaseEvent`, and no per-event version claim survive, per subtract-before-you-add.

**Flow.** `admit` authorizes with the caller's context, prepares the route, writes receipt + staging under `scope.admissions.commit(event.id, …)` (which already schedules the wake and resumes Pi), then calls `drive(nativeId)`. `drive` is a single-flight loop: `openGate` → owner `authorize(event, "deliver")` → `native.submit(eventSubmission(event))` → remove from staging; it ends with `trackNativeProgress({ conversations })` so the DO stays alive while the run executes. Ordering within a conversation is the staging order; Pi's inbox is ID-ordered and places all follow-ups at the final boundary, so a burst lands as one turn. `followUpMode: "all"` is the only setting change.

**Replies.** The outbox keeps its task, record-per-event, `key` digest, authorization in `beforePost`, retry and blocked semantics. What changes is the producer: `ReplyAnswer` is a passive local answer or a `{ taskId, callId, text }` tool call, and the record stores `answerRef` instead of an answer entry ID. The tool resolves the destination from the receipt via `replies.origin` (Slack thread, saved-timer destination, or the originating human event of a Team report), never from the model, and `enqueueIn` is idempotent on the call identity so a Pi replay cannot double-post. The nudge hook reads `pi.live.run.inputs` and maps submissions to event IDs through `pi.submission(id).status().requestId`, the same Harness-from-closure pattern `run-limits.ts` uses, and bounds itself to one nudge per run by scanning for its own marker. No answer is ever auto-posted, which is the point of making replies explicit.

**Human cause.** `instruction-cause` keeps its candidate set (every input of the current run) and drops the claim checks; verification is receipt digest + `nativeId` + entry data + source kind, and `findLast` over candidates means a human input anywhere in a batched run authorizes `start_team` while an internal-only run is denied.

**Interface depth.** Callers see `admit`, `enqueueIn` + `drive`, `wake`, `withdraw`, `pendingWeb`, plus the unchanged read/list/handback entry points. Behind that: dedup and conflict, routing, staging, the publication gate, crash re-drive, owner re-authorization at delivery, and DO liveness. The model sees one tool with two parameters. What stays exposed is the two-call pattern (`enqueueIn` in your commit, `drive` after it) for callers that already own a transaction; a one-call `admit` covers the request path.

## Synthesis decision

_Filled in by arena._

## Tradeoffs accepted

- We accept one small application-side list (`BotEventStaging`) in exchange for crash-safe admission without a task; it is not a queue the model waits on, and it is empty whenever no refresh is pending.
- We accept that events already inside Pi's inbox when a refresh is requested run under the definition they were admitted under; the refresh waits for the drain. This matches today's `nativeDrainIn` gate and gives the publication liveness because new arrivals are staged.
- We accept losing the 96/64 identity-wide caps in exchange for Pi's inbox as the only backlog; `MAX_STAGED` guards the staging list, and inbox growth is bounded by the run that consumes it.
- We accept that a forgotten reply gets one nudge and then stays unreplied, in exchange for never posting text the model did not choose to post.
- We accept a second commit per event (staging removal) instead of a single transaction, because Pi offers no transactional admission to application code.
- We accept `followUpMode: "all"` as a Harness-wide setting; child conversations in the same Harness receive one input per tool call, so they are unaffected, but this must be checked for any other follow-up submitter.

## Alternatives considered

- **Gate in `beforeRequest`.** Rejected on the Pi facts above: it can neither defer nor block, only abort, and aborting burns the inputs' `requestId`. It also exposes the gate to the run that should not see it.
- **Keep a held-receipt state (`admission: "held"`) and a release event instead of a staging list.** Same durability, but the invariant "held ⇔ no submission" would be stored twice and need the old `releaseEvent` dance to open the gate one event at a time; the staging list derives it and opens for the whole backlog in order.
- **Automatic fallback post of the final answer when the model forgets to reply.** Keeps the one-event-one-answer binding alive through a settlement phase, which is the task we are deleting, and re-introduces uncertain posts. The nudge is bounded and leaves the decision with the model.
- **Merge a batch into one user message.** Loses per-event IDs the reply tool and human-cause check need; Pi already places one entry per item with its own `entry.data`.

## Open questions and risks

- Is one reply per event the wanted contract, or should the model be allowed a progress note and a final answer on the same Slack event (record keyed by call instead of event)?
- Should the nudge exist at all, and should Team-report events with a resolvable origin count as "needs a reply"?
- `run-limits.ts` detects a run's start by `pi.user` / `pi.reset` entries; with every input placed as `cerebro.bot-event-input`, does its tool-call count keep working, or must `startsRun` learn the new kind?
- `prepareLocalControl` appends model-visible entries to a possibly busy conversation outside Pi's inbox (existing behavior); is that acceptable with batched turns?
- Does any other submitter in the SessionAgent Harness rely on `one-at-a-time`?
- Owner re-authorization in `drive` drops a staged event on `Denied`; should the receipt record the reason, or is the derived "none" state enough for the Inspector?

## Next implementation step

Replace `BotEventReceipt`, add `BotEventStaging`, and rewrite `createCoordinatorEvents` with `enqueueIn`/`admit`/`drive`/`wake`/`withdraw` against `Conversation.submit`, with the existing coordinator-events tests ported to assert "no lost, no duplicate placement" across a crash between the receipt commit and the submit.
