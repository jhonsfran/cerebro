# Grounding: coordinator events through Pi's inbox, batched, with a reply tool

Repository: /Users/jhonsfran/repos/cerebro, branch codex/persistent-super-agent at commit f94aeac. Read-only for runners. Do not edit repository files. Write your candidate only under your own output directory. Note: a parallel unit is deleting legacy paths (policy versions, legacy inputs, Slack-kind conversation rows, source admission). Design as if that deletion has landed: every conversation is the agent's primary conversation, `policyVersion` no longer exists, and there is no legacy input path.

## Product goal

The coordinator is one Pi conversation per person and agent. Today each incoming event becomes a four-phase durable delivery task that waits for its predecessor, claims a profile version, submits to Pi as a follow-up, and settles by binding the run's single answer entry to the event. Pi is opened with `followUpMode: "one-at-a-time"`, so N messages become N sequential turns, and the one-event-one-answer contract is what every Slack reply is built on.

After this unit:

1. Events are admitted into Pi's inbox directly. Pi is the queue. A burst of events that arrives during a turn is placed into the next turn together (`followUpMode: "all"`), the way the super-agent paper's Router batches triggers.
2. Replies to external channels are an explicit model decision: a `reply_event` tool (name open) posts text to the destination recorded for an event ID. Web events need no reply; the transcript is the reply. The existing reply outbox, with its authorization at post time, rate-limit retry, and never-repeat-an-uncertain-post rule, stays as the delivery layer.
3. The delivery task, the predecessor wait, the identity-wide pending queue, the settlement that binds answer entries to events, and the pending-web projection from that queue are deleted.

## Current shape

- `packages/runtime/src/coordinator-events.ts` (948 lines): `createCoordinatorEvents` with `enqueueIn` (receipt by event ID with digest conflict and duplicate count), `reserveDeliveryIn` (caps 96 pending, 64 external; creates the delivery task), the `cerebro.bot-event-delivery` task with phases deliver, admission-wait, settle, retry (predecessor wait via `eventHasPredecessorIn`, profile gating via `scope.prepareAdmission`/`scope.claimIn`, `native.submit({ whenBusy: "followUp", requestId: event.id, entry: { kind: "cerebro.bot-event-input", data } })`, settle via `submission.wait` and `scope.prepareSettlement`), `returnIn`/`receiveReturn` for Team handbacks, `admit`, `read`, `list`, `restore`/`wake`/`hold` (`trackNativeProgress` over task IDs), `abortPending`, `pendingWeb`.
- `packages/runtime/src/coordinator-event-state.ts`: `BotEventReceipt` with `route` (coordinator, teams, control, local-answer) and `delivery` (coordinator task with admission states held, claimed, submitted, settled done/unanswered/blocked), `BotEventReceipts` doc family, `BotEventSequence`, `BotEventQueue`.
- `packages/runtime/src/coordinator-event-input.ts`: `botEventInput(event)` text per source kind (web text verbatim; Slack as JSON with event ID; saved timer; internal report or terminal notice with the "cannot approve new team work" sentence), `webPendingInput`, `eventHasPredecessorIn`, `abortPendingEvents`, `pendingWebInputs`.
- `packages/runtime/src/coordinator-event-scope.ts` and `conversation-event-scope.ts`: `BotEventScope` with `prepareAdmission`, `claimIn` (reads `Bindings` refresh and release event), `prepareRoute` (subscriptions), `prepareLocalControl` (exact `status` and `stop` answered without a model call via `appendPassiveAnswer`), `prepareSettlement` (enqueues a reply with the native answer entry for Slack-origin events), `deliverReply`, `authorize`.
- `packages/runtime/src/coordinator-replies.ts`: the reply outbox task (`CoordinatorReply` records keyed by event, destination, dependencies, blocked flag; delivery through `scope.deliverReply` with `SlackDeliveryStore`; `origin(event)` resolves the Slack thread or saved-timer destination).
- `packages/runtime/src/coordinator-web.ts`: web `send` builds a web BotEvent and calls `events.admit`; exact `status`/`stop` route to local control; replay by operation ID through `SourceOperations`.
- `packages/runtime/src/saved-timer-submit.ts`: reminder occurrences become events with source `savedtimer`.
- `packages/runtime/src/coordinator-report.ts`: a Team report is applied and a `teamreport` event is enqueued inside the same admissions commit; `coordinator-event-content.ts` builds report and terminal-notice events (text capped at 2000).
- `packages/runtime/src/instruction-cause.ts`: `start_team` requires a human cause; it inspects the current run's input entry (`cerebro.bot-event-input` data) and the event receipt to decide human vs routine; internal events cannot authorize new work.
- `packages/runtime/src/session-agent.ts`: opens Pi with `followUpMode: "one-at-a-time"`; installs `events.definition` and `replies.definition` as tasks; the `cerebro-coordination` lifecycle job calls `events.wake` and `replies.hold`; the identity request handler admits owned events (`resolved.kind === "owned-event"`).
- `packages/runtime/src/conversation-scope.ts`: Stop calls `events.abortPending(native.id)` then native abort; the snapshot includes `events.pendingWeb(native.id)` as queued inputs; the publication `advance` applies a staged definition when native work has drained and uses `Bindings.refresh` and `releaseEvent` so one held event releases the new profile.
- `packages/runtime/src/coordinator-subscriptions.ts`: `prepare(input)` decides coordinator vs teams routing for Slack threads; event commands to Teams and `return_event` handback stay as they are (a later unit generalizes the thread key).
- Inspector reads events through `events.list` and `events.read` (`inspection-events.ts`); the web shows queued inputs from `ChatQueuedInput` (`mode`, `operationId`, `submissionId`, `text`).
- Web transport: `apps/server/src/session/agent.ts` resolves `/owned-event` requests from `packages/channels` (`slack-event-client.ts`, `coordinator-web`), Slack events arrive through the `SLACK_EVENTS` queue and the channel decision receipts in PostgreSQL.

## Pi facts (verified in node_modules/@earendil-works/pi-durable 1.3.0)

- `Conversation.submit({ type: "input", content, requestId, whenBusy: "steer" | "followUp" | "reject", entry })` durably admits input; a known `requestId` returns the existing submission without writing. A busy conversation queues; an idle one starts a run.
- Settings `followUpMode: "all"` places every queued follow-up at the final boundary into one run; `steeringMode: "all"` likewise after the current tool round. `dist/harness/inbox.js applyBoundary`.
- `endRun` settles every input placed in a run with the same settlement, so all batched inputs share one `answer` entry. `dist/harness/live.js:27`.
- `InboxDoc` is exported (`items: InboxItem[]` with `id`, `mode`, `content`, optional `entry {kind, data}`), so queued inputs can be read per conversation.
- `Conversation.abort()` withdraws queued inputs (`withdrawQueuedInputs`) and settles them `unanswered`.
- `admitSubmission(tx, ...)` exists in `dist/harness/submissions.js` but is not exported from the package entry, so input admission cannot happen inside a `pi.commit` transaction from application code. Atomicity between an application receipt and the Pi submission must come from idempotent re-drive, not from one transaction.
- Generation hooks (`hook(GenerationTask, {...})`): `beforeRequest(request, api, context)` before every request attempt; `afterResponse`; `onYield(answer, api, context)` may return `{ continue: UserInput }` to append a user message and continue the run; `afterTools`. Tool hooks: `beforeTool` can block a call. `HookApi` has `memo`, `taskId`, `conversationId`, committed reads.
- `Harness.configure(change)` applies an agent change in its own commit; the runtime already uses it for profile adoption.

## Constraints

1. Dedup by event ID and payload digest stays: the same ID with a different payload is a conflict; a duplicate with the same payload is counted and ignored.
2. No lost events across a process kill at any point, and no duplicate placement. `requestId` dedup in Pi is the tool for this.
3. Slack replies keep the existing authorization at post time (current link, content dependencies), the rate-limit retry, and the never-repeat-an-uncertain-post rule. A reply can only go to the destination recorded for the event the model names; web events have no external destination.
4. Internal events (Team reports, terminal notices) and saved timer occurrences keep their input phrasing and cannot authorize new Team work; `start_team` must still find a human cause in the current run when a batched run mixes human and internal inputs.
5. A published definition still applies at a safe turn boundary with inputs waiting durably, and the new definition must be in force before those inputs run.
6. Stop withdraws the conversation's queued inputs and aborts the run; the web UI still shows queued inputs with their operation IDs.
7. Replay by web operation ID keeps returning the same receipt.
8. Exact `status` and `stop` keep answering without a model call.
9. Team event routing through subscriptions (`prepareRoute`, event commands, `return_event`) is out of scope; keep its entry points.
10. Prefer deletion. The four-phase task, the predecessor wait, the identity-wide pending caps, and the answer-entry binding should disappear if the design makes them unnecessary.

## Design questions to answer

- How does an event get from an HTTP request or queue message into Pi's inbox durably and idempotently without a multi-phase task? What re-drives a receipt whose submission never happened?
- How is the publication gate implemented when inputs sit in Pi's inbox rather than in an application queue?
- What is the reply tool's contract, and what, if anything, makes sure a Slack-origin event gets a reply when the model forgets? (`onYield` is available.)
- What does the model see for a batched run: one user message per event with its ID, or one merged message?
- What replaces `BotEventReceipt.delivery` and `admission` states? Keep the receipt minimal.
- How does `instruction-cause` decide human cause in a batched run?
- What does the Inspector and the web queued-input view read from?

## Deliverable

Write under your output directory:

- `sketch.ts`: the changed contract types and the signatures of the runtime functions that change, with `not implemented` bodies and doc comments stating intent and invariants. Name what is deleted.
- `rationale.md`: shaped per the architect rationale template (Problem, Usage from the caller's view, Shape, Tradeoffs accepted, Alternatives considered, Open questions and risks, Next implementation step). One page.
