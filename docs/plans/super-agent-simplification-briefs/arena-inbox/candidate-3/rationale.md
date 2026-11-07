# Candidate 3: triggers and replies as the domain, channels as adapters

## Problem

Every incoming event today becomes a four-phase durable task that waits on its predecessor, claims a profile version, submits one Pi follow-up, and settles by binding the run's answer entry to the event; Slack replies are built on that one-event-one-answer binding. We want Pi's inbox to be the queue (`followUpMode: "all"` batches a burst into one run), replies to be an explicit `reply_event` call, and the task, predecessor wait, identity-wide queue, admission states, and answer binding to disappear. Constraints that shape the answer: `admitSubmission` is not exported, so a receipt and a Pi submission are two commits and atomicity must come from idempotent re-drive on `requestId`; the publication gate must put a new definition in force before waiting inputs run, and Pi gives no commit hook at a run boundary; `start_team` must find a human cause when a batched run mixes human and internal inputs; Slack post-time authorization, rate-limit retry, and the never-repeat-an-uncertain-post rule stay; `status`/`stop` keep answering without a model call; Team routing through subscriptions stays as is. The legacy input path, policy versions, and Slack-kind conversations are being deleted in parallel and are treated as gone.

## Usage (caller's view)

A channel does two things: it produces a `Trigger` and, if it can receive replies, it registers a `ReplyPort` for its `ReplyDestination` kind. It never touches tasks, queues, settlement, or Pi.

```ts
// Slack adapter (apps/server/src/session/agent.ts), after reading the decision receipt
const trigger: Trigger = {
  version: 2, id: await triggerId(address, origin), address, ownerPrincipalId: decision.ownerPrincipalId,
  origin: { kind: "slack", eventId: decision.authority.eventId, thread: decision.authority.thread },
  actor: "human", text: decision.text, reference: null, dependencies: { sourceIds: [], toolIds: [] },
  reply: { kind: "slack", authority: decision.authority, ownerPrincipalId: decision.ownerPrincipalId, source: address },
};
return { kind: "owned-event", address, context, admission: { version: 3, kind: "trigger-admission", trigger, routing } };
// … and in the DO: const receipt = await host.triggers.admit(resolved.admission, context);

// Team adapter (coordinator-report.ts), inside the report's admissions commit
const trigger = await teamTriggerIn(tx, record, { kind: "teamreport", key, reportId, outcome }, report.text, report.contentDependencies);
await triggers.acceptIn(tx, trigger);           // receipt + backlog, same commit as the ledger change
// after the commit: void triggers.drain(native.id)

// The model, in a batched run that placed two Slack messages and one team report
reply_event({ event_id: "bot-event:9f…", text: "Done. The export is in #ops." })

// Stop (conversation-scope.ts)
await Promise.all([triggers.withdraw(native.id), harness.abort({ session })]);
```

The deployment's reply registry is one object: `replyPorts: { slack: createSlackReplyPort(env, slack, primary, access) }`. A GitHub channel later adds a `github` member to `ReplyDestination`, a `ReplyPort<"github">`, and an adapter that builds triggers with `actor` set; nothing in `triggers.ts`, `replies.ts`, or `instruction-cause.ts` changes.

## Shape

Data first. `Trigger` is the one domain object: address, owner, `origin` (channel identity), `actor` (human | routine | internal, set by the adapter), text, reference, `reply: ReplyDestination | null`, dependencies. Its id is `triggerId(address, origin)` with today's digest scheme and prefix, so existing receipt keys survive. The schema filter encodes the channel table (web has no destination; team origins are internal; human is web or slack) at the boundary, per boundary-discipline; the runtime reads `actor`, never `origin.kind`.

`TriggerReceipt` is what dedup is decided on and what adapters get back: trigger, digest, nativeId, duplicates, route. It holds no Pi state. Where a trigger is (`backlog | queued | placed | done | unanswered | withdrawn`) is derived at read time from `pi.submissionByRequest(nativeId, trigger.id)` and the `Backlog`, per single-source-of-truth: Pi already records every transition we used to mirror in `BotEventAdmission`. `Backlog` is a per-conversation ordered set of ids accepted but not yet handed to Pi. It is the entire re-drive state and is non-empty only between the two commits or while the publication gate holds.

Flow. `admit` validates the wire, authorizes with the caller's context, writes the receipt and backlog entry in one lease-serialized commit keyed by trigger id, then calls `drain`. `drain` asks the scope's `gate()`, and if open submits each backlogged id with `native.submit({ requestId: id, whenBusy: "followUp", entry: cerebro.trigger })` and removes it. A kill at any point re-runs `drain` on restore or the next coordination wake; a known `requestId` returns the existing submission without writing, so no trigger is placed twice and none is lost, per make-operations-idempotent. N triggers that arrive during a run sit in `pi.inbox` and are placed together at the final boundary (`followUpMode: "all"`); the run's single `endRun` settles all of them. A test proves batching by submitting three triggers while a fixture run is busy, then asserting one generation task, three consecutive `cerebro.trigger` entries ahead of one assistant entry, and three submissions `done` with the same `answer`.

Publication gate. Inputs are handed to Pi only by `drain`, and only after `gate()` is open. When a refresh is pending, `advance` activates it in one commit iff `nativeDrainIn` (no run, empty `pi.inbox`, no live non-outbox task) and no pending approvals or leases; otherwise `drain` returns `waiting` and the coordination job retries after a second. Inputs already in Pi's inbox predate the refresh request and run under the definition they were admitted under; inputs that arrive after it wait durably in the backlog and run under the new one. `releaseEvent`, the per-event claim, and the agent/policy version stamped into entry data disappear, because the profile is now a property of placement, per derive-instead-of-sync. This is the only place where the application holds an input outside Pi, and it is why the backlog exists at all.

Replies. `Reply` is keyed by trigger id and copies `destination` from the receipt; a post can only go where the trigger recorded it. The `reply_event` tool (per profile, `replay: "safe"`) checks the trigger belongs to the calling conversation and has a destination, pre-authorizes through `ports[kind].authorize` and the dependency check, and enqueues in a commit (same text → same record; other text → Conflict, one reply per trigger). The outbox task is today's, with `scope.deliverReply` replaced by a `kind` lookup in the registry; post-time authorization, backoff, `retryAt`, blocked-on-Denied, and the channel store's uncertain-post rule are unchanged. `localAnswer` (`status`/`stop`) calls the same `enqueueIn`. When the model forgets, an `onYield` hook finds the run's inputs whose receipts have a destination and no reply and returns one `continue` nudge per run (memo-guarded), per the "explicit model decision" requirement without silently reviving auto-reply.

Instruction cause. For each submission in `pi.live.run.inputs`, read the entry (`data.id`, `data.actor`), verify both against the receipt, and take the last human cause, else the last routine; internal never qualifies. `humanOperationId` on the work record is the cause trigger id, which is how the Team adapter later finds the reply destination for its report.

Interface depth. The runtime core exposes `admit`, `acceptIn`, `drain`, `withdraw`, `queuedWeb`, `placement`, `read`, `list` plus the kept Team entry points; behind it sit dedup, authorization, routing, backlog, the gate, idempotent placement, and keep-alive. `TriggerScope` shrinks from thirteen callbacks to `authorize`, `commit`, `gate`, `route`, `localAnswer`, access checks. Callers never see Pi submissions, tasks, or claim state. What stays exposed on purpose: the Team routing receipt variants and `returnEventIn`/`receiveReturn`, because that unit is out of scope.

## Synthesis decision

*Filled in by arena.*

## Tradeoffs accepted

- We accept a tiny per-conversation `Backlog` document in exchange for a publication gate that holds under continuous traffic; without it, a refresh could starve or land mid-run. It is not a delivery queue: no caps across the identity, no predecessor order, no states.
- We accept one authorization at admission (caller context, trigger dependencies) instead of a second one at delivery, in exchange for no delivery phase; placement follows admission within milliseconds except during a refresh window, and the model request itself re-authorizes execution.
- We accept that the forgot-to-reply nudge appears as a user entry in the web transcript, in exchange for keeping replies an explicit model decision; auto-replying with the answer text would reinstate the answer binding we are deleting.
- We accept one reply per trigger (a second `reply_event` with other text is a Conflict) to keep the uncertain-post rule simple; a thread conversation gets its next message from its next trigger.
- We accept a per-conversation `MAX_WAITING` (inbox + backlog) instead of the 96/64 identity caps, so a flood on one thread cannot grow Pi's inbox unboundedly.
- We accept that inputs already queued in Pi when a refresh is requested run under the old definition; they were admitted under it, and Pi gives no boundary commit to swap earlier.

## Alternatives considered

- Keep a thin delivery task per event (one phase: submit, then done). Loses little code and keeps the identity queue; it hides nothing new behind its surface and still needs the predecessor wait to order claims against the gate. Rejected: the gate is what needs ordering, and one `drain` per conversation orders it with no task.
- No backlog: submit into Pi immediately and let `advance` wait for an empty inbox. Smaller surface, but under steady traffic the inbox never empties, so a published definition never lands, and a mid-run `configure` would change tools under an active run. Rejected on publication safety.
- Auto-reply on settle (today's behavior, generalized): the hook replies with the final answer to every Slack trigger of the run. Hides the reply decision from the model but reinstates the answer-entry binding and cannot address two Slack threads batched into one run with different answers. Rejected; the `onYield` nudge keeps the fidelity.
- Derive `actor` from `origin.kind` inside the runtime instead of storing it. One field fewer, but every new channel edits the runtime's policy switch. Rejected on extensibility; the contract filter still pins the current table.

## Open questions and risks

- Is one reply per trigger acceptable, or should the model be able to post several messages to a thread for one event (then `Reply` becomes a family keyed by trigger id plus a model-chosen ordinal, and the uncertain-post rule applies per message)?
- Should the nudge be kept, or is an Inspector-visible `unreplied` placement enough? The nudge costs one extra model request on a forgotten reply and shows in the web transcript.
- Is `MAX_WAITING = 64` per conversation the right bound, and should it fail the Slack queue delivery (retry later) or drop with a notice?
- Migration: receipts at version 2 carry `delivery`; the migrate step drops it. Should in-flight `cerebro.bot-event-delivery` tasks at deploy time be aborted (their submissions settle `unanswered`) or drained first by a one-off restore step?
- `teamTriggerIn` reads the originating trigger's receipt inside the report commit; a cause trigger whose receipt was never written (legacy work records with `humanOperationId` from the native path) yields `reply: null`. Acceptable, or should those reports still try the old `SourceOperations` lookup until legacy rows age out?

## Next implementation step

Write `packages/contracts/src/triggers.ts` (Trigger, ReplyDestination, TriggerAdmission, `triggerId` bit-compatible with `botEventId`) and the `Receipts` v3 migrate, then port the batching test from `tests/runtime/coordinator-events.test.ts` to assert three queued triggers settle with one answer entry under `followUpMode: "all"`.
