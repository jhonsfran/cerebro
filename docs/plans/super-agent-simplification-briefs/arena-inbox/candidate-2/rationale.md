# Candidate 2: Pi is the queue, the app keeps a receipt and a placer

## Problem

Every coordinator event today becomes a four-phase durable task that orders itself behind its predecessor, claims a profile version, submits one Pi turn, and settles by binding the turn's single answer to the event. That contract cannot survive `followUpMode: "all"`: Pi settles every input of a batched run with the same answer entry (`live.js:27`). We need events admitted straight into Pi's inbox, idempotently and without loss across a process kill, while `admitSubmission` is not exported (so receipt and submission cannot share a transaction), a published definition must still take effect before waiting inputs run, Slack replies become an explicit tool call with the existing outbox as delivery, and `start_team` must still find a human cause when a run mixes human and internal inputs.

## Usage (caller's view)

```ts
// Slack queue / web / timer: one call, returns once the receipt and its placer are durable.
const receipt = await events.admit(admission, context);           // { ...receipt, duplicates }
return { eventId: eventOf(receipt).id };                           // replay: same receipt, duplicates > 0

// Team report, inside the report's own transaction:
await events.enqueueIn(tx, await coordinatorReportEvent(record, report));

// The model, in a batched run that saw "Slack event. {eventId: ..., content: ...}":
reply_event({ eventId: "bot-event:9f3…", text: "Done: the report is in #ops." })
// → {"eventId":"bot-event:9f3…","state":"queued"}  (web events: isError "the transcript is the reply")
```

Nothing a caller touches waits on Pi, orders itself, or names an answer entry. Stop is `native.abort()` plus `events.withdraw(nativeId)`; the web snapshot is Pi's inbox plus `events.pendingWeb(nativeId)`.

## Shape

**Data.** `BotEventReceipt` shrinks to `{ input, digest, nativeId, duplicates, route, delivery }` where `delivery` is `{ taskId }` for anything the coordinator owes a placement, else `null`. Every progress fact is derived from Pi, never written: placed/queued/done/unanswered from `tx.submissionByRequest(nativeId, event.id)`, held/withdrawn/failed from the task record, replied from the outbox record, nudged from `submissionByRequest(nudgeRequestId)`. `BotEventQueue`, `BotEventSequence`, `BotEventAdmission` and `releaseEvent` are deleted; per single-source-of-truth and derive-instead-of-sync, the only app-owned delivery state is the one task ID.

**Flow.** `admit` authorizes, routes, and commits receipt + admission task under the existing admissions lease. The task (`cerebro.bot-event-admission`, phases `place | held`) reads the receipt, asks `scope.placementOpen()`, re-authorizes, and calls `native.submit({ requestId: event.id, whenBusy: "followUp", entry: cerebro.bot-event-input })`, then ends. Crash anywhere: Pi re-runs the phase and `requestId` dedup returns the existing submission (`submissions.js:129`). That is the idempotent re-drive the grounding asks for; the task earns its place because Pi's task scheduler is already the durable retry loop, it is created atomically with the receipt, and it needs no index doc, no restore scan and no job wiring. A wake-driven re-drive would need all three. The task waits only in one case: a pending publication.

**Gate.** `placementOpen()` = advance a pending publication if Pi is idle, then `binding.refresh === null`. Activation happens in one transaction that checks `nativeDrainIn` (no live run, no user items in `InboxDoc`, no foreign live tasks) and `configure`s. Because Pi resolves the agent per generation at `prepare` (`generation.js:34`), any submission landing after that transaction runs under the new definition, and any landing before it either started a run or is sitting in the inbox, both of which fail the drain. So constraint 5 holds without a claim, a release event or a predecessor wait. The hold is the only reason `pendingWeb` survives, now read from Pi's live task table (`scanTasks` by kind and status) instead of an app queue.

**Replies.** `reply_event` resolves the destination through the existing `origin()` (Slack thread, timer destination, or a Team report's human origin), authorizes now via `scope.prepareReply`, and writes the outbox record keyed by event with `answer: { kind: "tool", callId }` and explicit text. One reply per event; a replay of the same call is idempotent. The outbox keeps post-time authorization, rate-limit retry and the never-repeat rule untouched. The nudge is an `onYield` hook on the coordinator's extension: for each of this run's placed inputs whose event has `replyTo.kind === "slack"` and no reply record and no prior nudge, it submits a durable follow-up input `cerebro.reply-nudge` carrying the event ID. It deliberately does not return `{ continue }`: Pi drops a continuation whenever the final boundary selects a queued user item (`generation.js:433`), which is exactly the burst case. A follow-up submitted before the ending commit is placed by that commit's boundary, so alone it continues at once and with a burst it joins the batch. `instruction-cause` resolves a nudge entry through the nudged event's receipt, so a nudge run keeps its human cause.

**What the model sees.** One user message per event, in inbox order, texts unchanged; a prompt section says Slack events carry an `eventId` to answer with `reply_event` and web messages need none. Exact `status`/`stop` keep the passive answer and a local reply record.

**Interface depth.** Callers see `admit`, `enqueueIn`, `withdraw`, `pendingWeb`, `wake` and one tool; behind them sit dedup, routing, the lease, the placer, the publication gate, the nudge and the outbox. No Pi submission or inbox type crosses the boundary (per boundary-discipline); `ReplyAnswer` and `BotEventReceipt` are domain types.

## Synthesis decision

Filled in by arena.

## Tradeoffs accepted

- We accept Pi-scheduling order inside a burst (creation order in practice, not enforced) in exchange for deleting the predecessor wait and the sequence counter.
- We accept a 1 s poll in the `held` phase, active only while a publication waits for idle, in exchange for a gate with no claim, release or settle state.
- We accept that events held by a pending publication re-enter Pi one by one after activation (first starts a run, rest batch) in exchange for not atomically bulk-submitting.
- We accept one reply per event, keyed by event ID, so the outbox record, the never-repeat key and the Inspector stay as they are.
- We accept a nudge that lands as a visible follow-up input (hidden from the web transcript by kind) in exchange for never losing it to a dropped continuation.
- We accept a per-conversation inbox cap read from `InboxDoc` at admission in place of the identity-wide 96/64 caps.
- We accept that an unreplied Slack event stays unreplied after one nudge; the model's decision is final and the Inspector shows it.

## Alternatives considered

- **Wake-driven re-drive, no task.** `admit` submits inline after the receipt commit; a restore scan and the coordination job resubmit receipts with no submission. Needs an "unplaced" index doc, a trigger per crash path, and the same hold logic for publications; exposes three moving parts to the reader where the task exposes one. Lost on depth, not on size.
- **Receipt and submission in one transaction by reimplementing `admitSubmission` over `tx.createSubmission` / `InboxDoc` / `startRun`.** Atomic, but copies Pi's inbox protocol into app code; a Pi change silently diverges it. Information leakage; rejected.
- **No hold; apply the publication in `onYield` before Pi's ending commit.** Zero wait and no `pendingWeb`, and correct for every run that yields, but a run ending on a provider error places waiting inputs under the old definition, and `beforeRequest` cannot fix it because the agent is resolved in `prepare` before it runs. Violates constraint 5 on one path; kept as the shape to revisit if the hold proves costly.
- **`onYield` returning `{ continue }` for the nudge.** Simplest reading of the hook, dropped by Pi whenever a burst waits; rejected for the follow-up submission.

## Open questions and risks

- Should a Slack event allow more than one reply (progress then answer)? The record would need a per-call key and the Inspector a list.
- Is one nudge per event the right bound, or should an unreplied Slack event after the nudge fall back to posting the run's final text as today?
- Is the per-conversation inbox cap wanted at all, or is deleting backpressure acceptable now that sources are authenticated?
- Should Stop abort held admission tasks (events disappear) or let them place after the publication (events survive Stop)? The sketch withdraws them, matching "Stop withdraws queued inputs".
- Risk: `scanTasks` by kind and status is assumed indexed in Pi storage; if it degrades with terminal task count, `pendingWeb`/`withdraw` need a small held-set doc.

## Next implementation step

Replace `coordinator-event-state.ts` with the shrunk receipt (version 3) and write the `cerebro.bot-event-admission` task in `coordinator-events.ts` with `placementOpen` on the scope, then flip `followUpMode` to `"all"` and run the runtime suite before touching replies.
