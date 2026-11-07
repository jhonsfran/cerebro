/**
 * Candidate 1: "Pi is the queue."
 *
 * One idea: an event's receipt is the only application record; whether the
 * event has reached Pi is derived from `tx.submissionByRequest(nativeId,
 * event.id)`, and whether it was answered is derived from that submission's
 * status. The request path writes the receipt and calls `Conversation.submit`
 * with `requestId = event.id` right away. A per-conversation staging list
 * (`BotEventStaging.pending`) holds only the IDs whose submit has not been
 * observed to land; the lifecycle wake re-drives it. The publication gate is
 * that same staging list: while `Bindings.refresh` is set, receipts stay
 * staged, so the conversation drains and the new definition can be configured
 * before they run.
 *
 * Verified against pi-durable 1.3.0 (see rationale.md for the file:line of
 * each): `beforeRequest` cannot defer or block a request (the hook runner
 * reports a throw and continues; `run-limits.ts` shows the only lever is to
 * abort the run, which settles the inputs `unanswered` and burns their
 * `requestId`). The gate therefore lives before `submit`, not in a hook.
 *
 * ──────────────────────────────── Deleted ────────────────────────────────
 *
 * coordinator-events.ts
 *   - task `cerebro.bot-event-delivery`, `EventCheckpoint`, phases deliver /
 *     admission-wait / settle / retry, `withdraw`, `settledAdmission`,
 *     `deliveryOf`, `reserveDeliveryIn` (96 / 64 caps), `hold` over task IDs,
 *     `abortPending`, `holdReplies` option.
 * coordinator-event-state.ts
 *   - `BotEventAdmission`, `CoordinatorEventDelivery`, `receipt.delivery`,
 *     `receipt.sequence`, `BotEventQueue`, `BotEventSequence`, legacy v1
 *     migration (`legacyReceipt`, `legacyAdmission`).
 * coordinator-event-input.ts
 *   - `eventHasPredecessorIn`, `abortPendingEvents`, `webPendingInput` over
 *     `delivery`, `pendingWebInputs` over the queue.
 * coordinator-event-scope.ts / conversation-event-scope.ts
 *   - `prepareAdmission`, `claimIn`, `prepareSettlement`, `prepareReply`
 *     (moved into the reply tool), `agentVersion` / `policyVersion` fields,
 *     `EventTargetIn.agentVersion`.
 * coordinator-event-access.ts (`authorizeEventDelivery`) — folded into `drive`.
 * conversation-drain.ts: `oldestHeldEventIn`; `nativeDrainIn` no longer reads
 *   the event queue or receipts.
 * conversation-bindings.ts: `policyVersion`, `legacyVersion`, `releaseEvent`,
 *   `ProfileIdentity.policyVersion`, `profileKey` policy suffix.
 * conversation-scope.ts: `advancePublication(eventId)`, `advance(eventId)`
 *   release-event logic; Stop no longer aborts delivery tasks.
 * coordinator-replies.ts: `answerEntryId`, `ReplyAnswer.native` (the outbox no
 *   longer reads the model's answer entry; text arrives from the tool).
 * instruction-cause.ts: claim checks (`requestId`, `agentVersion`,
 *   `policyVersion`, `submissionId`), `allowLegacyUser`, `pi.user` cause.
 * session-agent.ts: `followUpMode: "one-at-a-time"`, `events.definition` task
 *   registration, `restoring` dance for delivery tasks.
 */

import type { BotEvent } from "@cerebro/contracts/bot-events";
import type { EventAdmission } from "@cerebro/contracts/bot-routing";
import type { EventAddress } from "@cerebro/contracts/events";
import type {
  ExecutionContext,
  PrincipalId,
} from "@cerebro/contracts/identity";
import type { ContentDependencies } from "@cerebro/contracts/session";
import type { ChatQueuedInput } from "@cerebro/contracts/session-service";
import type {
  SlackDelivery,
  SlackDeliveryStore,
  SlackReplyDestination,
} from "@cerebro/contracts/slack-events";
import type {
  TeamEventCommand,
  TeamEventReturn,
} from "@cerebro/contracts/team-events";
import type {
  Conversation,
  ConversationId,
  Cursor,
  EntryId,
  Harness,
  HookRegistration,
  InputSubmissionDraft,
  JsonObject,
  TaskId,
  ToolRegistration,
  Tx,
} from "@earendil-works/pi-durable";

// Read this file as if it sat in packages/runtime/src; sibling imports are unchanged modules.
import type { createCoordinatorAdmissions } from "./coordinator-admission.ts";
import type {
  EventRecipient,
  EventSkip,
} from "./coordinator-event-state.ts";
import type { PiContext } from "./pi-harness.ts";

const notImplemented = (name: string): never => {
  throw new Error(`not implemented: ${name}`);
};

/* ═══════════════════════ coordinator-event-state.ts ═══════════════════════ */

/**
 * The only application record of an event. Nothing here says whether the
 * event reached Pi or was answered: that is derived (`admissionStateIn`).
 * Invariant: `digest === digestToolArguments(input)`; a different payload
 * under the same ID is a `Conflict`, the same payload bumps `duplicates`.
 */
export type BotEventReceipt = JsonObject & {
  input: EventAdmission;
  digest: string;
  nativeId: ConversationId;
  duplicates: number;
  route:
    | { kind: "coordinator"; skipped: EventSkip[] }
    | { kind: "teams"; recipients: EventRecipient[]; skipped: EventSkip[] }
    | { kind: "control"; workId: string; status: unknown }
    | { kind: "local-answer"; action: "status" | "stop"; answerEntryId: EntryId };
};

/** Doc family `cerebro.bot-event`, version 3. Migration from 2 drops `delivery` and `sequence`. */
export declare const BotEventReceipts: unknown;

/**
 * Per-conversation list of event IDs whose `Conversation.submit` has not been
 * observed to land, in arrival order. An ID is appended in the receipt commit
 * and removed in the commit that follows a successful submit. A crash in
 * between leaves the ID here; `drive` resubmits with the same `requestId`,
 * which Pi dedups. While `Bindings.refresh` is set, IDs accumulate here
 * instead of entering Pi: that is the publication gate.
 *
 * Doc `cerebro.bot-event-staging`, scope "conversation", history "latest".
 * Bounded by `MAX_STAGED`; `enqueueIn` throws `Unavailable` beyond it.
 */
export interface BotEventStaging extends JsonObject {
  pending: string[];
}
export declare const BotEventStagings: unknown;
export const MAX_STAGED = 128;

/**
 * Where an event stands, derived in one transaction. No receipt field mirrors
 * this. `none` means a Teams-routed event that was never handed back, or a
 * staged event that Stop withdrew before it reached Pi.
 */
export type EventAdmissionState =
  | "staged"
  | "queued"
  | "placed"
  | "done"
  | "unanswered"
  | "none";

export const admissionStateIn = (
  _tx: Tx,
  _receipt: BotEventReceipt
): Promise<EventAdmissionState> => notImplemented("admissionStateIn");
// TODO: staging.pending.includes(id) → "staged";
//       tx.submissionByRequest(nativeId, id)?.status ?? "none".

/* ═══════════════════════ coordinator-event-input.ts ═══════════════════════ */

export const BOT_EVENT_INPUT = "cerebro.bot-event-input";

/**
 * Data on the entry Pi places for an event. `eventId` is the join key back to
 * the receipt; `operationId` lets the web view match its own send. No agent
 * or policy version: the receipt is the source of truth for everything else.
 */
export interface BotEventInputData extends JsonObject {
  eventId: string;
  source: BotEvent["source"]["kind"];
  operationId?: string;
}

/**
 * The model sees one user message per event, each carrying its ID. Phrasing
 * per source kind is unchanged (web verbatim; Slack as JSON with `eventId`;
 * saved timer; internal report / terminal notice with the "cannot approve new
 * team work" sentence). External kinds gain one sentence: "Reply with
 * `reply_event` using this eventId if a reply is wanted; web events need none."
 */
export const botEventInput = (_event: BotEvent): string =>
  notImplemented("botEventInput");

/**
 * The exact draft handed to `Conversation.submit`. `requestId = event.id` is
 * the whole durability story: a repeat submit returns the existing submission.
 * `whenBusy: "followUp"` plus `followUpMode: "all"` batches a burst into the
 * next turn.
 */
export const eventSubmission = (_event: BotEvent): InputSubmissionDraft =>
  notImplemented("eventSubmission");
// → { type: "input", requestId: event.id, whenBusy: "followUp",
//     content: botEventInput(event), entry: { kind: BOT_EVENT_INPUT, data } }

/**
 * Web events that are staged but not yet in Pi's inbox, for the snapshot.
 * Events already in Pi are surfaced by `chatPresentation` from `pi.inbox`.
 */
export const stagedWebInputs = (
  _pi: Harness,
  _nativeId: ConversationId,
  _context: PiContext
): Promise<ChatQueuedInput[]> => notImplemented("stagedWebInputs");

/* ═══════════════════════ coordinator-event-scope.ts ═══════════════════════ */

export type EventRouteIn = (
  tx: Tx
) => Promise<
  | { kind: "coordinator"; skipped?: EventSkip[] }
  | Extract<BotEventReceipt["route"], { kind: "teams" | "control" | "local-answer" }>
>;

/** Resolves the bound native conversation; no version claim. */
export type EventTargetIn = (
  tx: Tx,
  address: EventAddress
) => Promise<{ readonly nativeId: ConversationId }>;

export interface BotEventScope {
  readonly native: Conversation;
  readonly ownerPrincipalId: PrincipalId;
  readonly admissions: ReturnType<typeof createCoordinatorAdmissions>;
  readonly requireCurrent?: () => void;
  readonly readAccess: (context: ExecutionContext) => Promise<void>;
  readonly authorize: (
    event: BotEvent,
    context?: ExecutionContext,
    signal?: AbortSignal,
    action?: "admit" | "deliver" | "read" | "control"
  ) => Promise<void>;
  readonly prepareRoute?: (
    input: EventAdmission,
    context: ExecutionContext
  ) => Promise<EventRouteIn>;
  readonly prepareLocalControl?: (
    event: BotEvent,
    action: "status" | "stop",
    context: ExecutionContext
  ) => Promise<EventRouteIn>;
  /**
   * The publication gate, read inside a transaction: `true` when no refresh
   * is pending for this binding. Replaces `prepareAdmission` + `claimIn`.
   */
  readonly gateIn: (tx: Tx) => Promise<boolean>;
  /**
   * Try to apply a pending refresh (needs the native drained) and report
   * whether the gate is open afterwards. Replaces `advancePublication(eventId)`.
   */
  readonly openGate: () => Promise<boolean>;
  readonly deliverReply?: (
    record: CoordinatorReply,
    store: SlackDeliveryStore,
    signal?: AbortSignal
  ) => Promise<void>;
}

/* ═══════════════════════════ coordinator-events.ts ═══════════════════════════ */

export interface CoordinatorEventsOptions {
  readonly pi: Harness;
  readonly targetIn: EventTargetIn;
  readonly resolve: (address: EventAddress) => Promise<BotEventScope>;
  readonly scan: (
    cursor?: Cursor
  ) => Promise<{ readonly keys: readonly string[]; readonly next?: Cursor }>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

export interface CoordinatorEvents {
  /**
   * Transactional half of admission: dedup / conflict on the receipt, route,
   * then append the ID to `BotEventStaging.pending` of the target native.
   * Callers that run inside their own admissions commit (Team report,
   * terminal notice, handback) use this and then `drive` outside the commit.
   */
  readonly enqueueIn: (
    tx: Tx,
    input: EventAdmission,
    routeIn?: EventRouteIn
  ) => Promise<BotEventReceipt>;
  /**
   * Request-path admission: authorize with the caller's context, prepare the
   * route, `enqueueIn` under `scope.admissions.commit(event.id, ...)` (which
   * also schedules the coordination wake), then `drive`. Returns after the
   * submit landed or the gate held the event; either way the receipt is
   * durable and the response can acknowledge the source.
   */
  readonly admit: (
    input: EventAdmission,
    context: ExecutionContext
  ) => Promise<BotEventReceipt>;
  /**
   * Idempotent re-drive of one conversation's staging list, in order:
   *   for each id in pending:
   *     if !(await scope.openGate()) break           // gate closed: leave staged
   *     scope.authorize(event, owner, "deliver")     // Denied → withdraw id, keep receipt
   *     native.submit(eventSubmission(event))        // requestId dedup
   *     commit: remove id from pending if present
   *   trackNativeProgress(pi, { conversations: [nativeId] }, waitUntil)
   * Single-flight per native in memory; safe to call from the request path,
   * the wake job, and restore concurrently. Returns whether anything is still
   * pending (gate closed), so the caller can reschedule.
   */
  readonly drive: (nativeId: ConversationId) => Promise<boolean>;
  /** `openGate` + `drive` for one or every bound conversation. */
  readonly wake: (nativeId?: ConversationId) => Promise<boolean>;
  readonly restore: () => Promise<void>;
  /**
   * Stop: clear the staging list so held events never enter Pi. The caller
   * then runs `Conversation.abort()`, which withdraws Pi's queued inputs and
   * aborts the run. Receipts stay; their state derives to "none".
   */
  readonly withdraw: (nativeId: ConversationId) => Promise<void>;
  readonly pendingWeb: (nativeId: ConversationId) => Promise<ChatQueuedInput[]>;
  readonly read: (id: string, context: ExecutionContext) => Promise<BotEventReceipt>;
  readonly list: (
    address: EventAddress,
    context: ExecutionContext,
    cursor?: Cursor
  ) => Promise<{ items: BotEventReceipt[]; next?: Cursor }>;
  /** Team handback: unchanged checks; stages the event instead of creating a delivery. */
  readonly returnEventIn: (tx: Tx, command: TeamEventCommand) => Promise<void>;
  readonly receiveReturn: (
    input: unknown,
    context: ExecutionContext
  ) => Promise<{ eventId: string; key: TeamEventReturn["work"]["key"]; accepted: boolean }>;
  readonly listSubscribedBotSources: unknown; // unchanged
}

export const createCoordinatorEvents = (
  _options: CoordinatorEventsOptions
): CoordinatorEvents => notImplemented("createCoordinatorEvents");

/* ═══════════════════════════ coordinator-replies.ts ═══════════════════════════ */

/**
 * Who produced the text: a passive local answer (`status` / `stop`) or one
 * `reply_event` call. The tool identity is the idempotency key across Pi
 * replays of the same call.
 */
export type ReplyAnswer =
  | { readonly kind: "local"; readonly entryId: EntryId; readonly text: string }
  | {
      readonly kind: "tool";
      readonly taskId: TaskId;
      readonly callId: string;
      readonly text: string;
    };

/** Stable string form of a `ReplyAnswer` identity, stored and shown by the Inspector. */
export const answerRef = (_answer: ReplyAnswer): string =>
  notImplemented("answerRef");

/** One record per event; keyed by event ID as today. */
export interface CoordinatorReply extends JsonObject {
  eventId: string;
  source: { [Key in keyof EventAddress]: EventAddress[Key] };
  answerRef: string;
  destination: SlackReplyDestination | null;
  dependencies: {
    sourceIds: ContentDependencies["sourceIds"][number][];
    toolIds: ContentDependencies["toolIds"][number][];
  };
  key: string;
  text: string;
  delivery: SlackDelivery | null;
  taskId: TaskId | null;
  attempts: number;
  until: number;
}

export interface CoordinatorReplyOutbox {
  readonly definition: unknown; // task `cerebro.coordinator-reply`, unchanged
  readonly hold: (nativeId?: ConversationId) => Promise<boolean>;
  /** Slack thread, saved-timer destination, or the originating human event of an internal event. Unchanged. */
  readonly origin: (event: BotEvent) => Promise<
    | { kind: "event"; event: BotEvent }
    | { kind: "saved-timer"; destination: SlackReplyDestination }
    | null
  >;
  /**
   * Idempotent per `answerRef`: the same answer returns; a different answer
   * for an event that already has a record throws `Conflict`
   * ("already replied"). Text is the caller's; `toSlackText` still applies.
   * Blocked when `blocked`, text empty, or no destination.
   */
  readonly enqueueIn: (
    tx: Tx,
    input: {
      readonly event: BotEvent;
      readonly nativeId: ConversationId;
      readonly answer: ReplyAnswer;
      readonly destination: SlackReplyDestination | null;
      readonly dependencies: ContentDependencies;
      readonly blocked: boolean;
    }
  ) => Promise<void>;
}

/* ════════════════════════ coordinator-reply-tool.ts (new) ════════════════════════ */

export interface ReplyEventToolOptions {
  readonly pi: Harness;
  readonly native: Conversation;
  readonly replies: CoordinatorReplyOutbox;
  /** Destination + post-time authorization ports of the current profile. */
  readonly scope: () => Promise<BotEventScope>;
  readonly ownerContext: () => Promise<ExecutionContext>;
  readonly contentDependencies: () => Promise<ContentDependencies>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * Tool `reply_event({ eventId, text })`.
 *
 * Contract: posts `text` to the destination recorded for `eventId`, through
 * the existing outbox (authorization at post time, rate-limit retry, never
 * repeat an uncertain post). The model can only name an event of this
 * conversation; the destination comes from the receipt, never from the model.
 *
 * execute:
 *   1. receipt = read(eventId); require receipt.nativeId === api.conversationId
 *   2. origin = replies.origin(event); null → isError "no external destination;
 *      the transcript is the reply"
 *   3. destination + dependencies (recorded ∪ event) + port.authorize →
 *      Denied/NotFound → blocked = true (record a blocked reply, as today)
 *   4. api.commit(tx => replies.enqueueIn(tx, { answer: { kind: "tool",
 *      taskId: api.taskId, callId: api.callId, text }, ... }))
 *      — a replay of the same call returns the same record; a second call
 *      for the same event gets Conflict → isError "already replied"
 *   5. replies.hold(native.id); output "queued" | "blocked: <reason>"
 * `replay: "safe"` (step 4 is idempotent on the call identity).
 */
export const createReplyEventTool = (
  _options: ReplyEventToolOptions
): ToolRegistration => notImplemented("createReplyEventTool");

export const REPLY_NUDGE_PREFIX = "[cerebro] Unreplied external events:";

/**
 * `hook(GenerationTask, { onYield })` for the coordinator conversation only.
 *
 * At a final answer, map `pi.live.run.inputs` → `pi.submission(id).status()
 * .requestId` → receipts; keep those whose `replies.origin(event)` resolves
 * and that have no `CoordinatorReplies` record. If any remain and no nudge
 * was appended yet in this run (scan entries newest-first for a `pi.user`
 * entry starting with `REPLY_NUDGE_PREFIX`, stopping at the first
 * `cerebro.bot-event-input` entry; same technique as run-limits.ts), return
 * `{ continue: "<prefix> <ids>. Use reply_event for each, or say why no reply
 * is needed." }`. At most one nudge per run; after that the event stays
 * unreplied and the Inspector shows it. Nothing is ever auto-posted.
 */
export const createReplyNudge = (options: {
  readonly pi: Harness;
  readonly nativeId: ConversationId;
  readonly replies: CoordinatorReplyOutbox;
}): HookRegistration => notImplemented(`createReplyNudge:${options.nativeId}`);

/* ═══════════════════════════ conversation-bindings.ts ═══════════════════════════ */

export interface ConversationBinding extends JsonObject {
  address: { [Key in keyof EventAddress]: EventAddress[Key] };
  agentVersion: number;
  nativeId: ConversationId;
  /** A requested publication not yet in force. While set, admission stages. */
  refresh: { agentVersion: number } | null;
}
// Bindings doc version 4; migrate from 3 drops policyVersion / legacyVersion / releaseEvent.

/* ═══════════════════════════ conversation-scope.ts ═══════════════════════════ */

export interface ConversationScopeChanges {
  /**
   * Publication: (1) no refresh and latest version differs → set refresh;
   * (2) refresh set → prepare the target profile, then one commit that
   * requires `nativeDrainIn(tx, native.id)` (no run, empty inbox, no live
   * non-outbox task) and no admission lease, applies `configure(tx,
   * native.id, agent)`, sets `agentVersion`, clears `refresh`; (3) returns
   * whether the gate is open. Single-flight. Staged events are submitted by
   * `events.drive` afterwards, so they run under the new definition.
   * Events already inside Pi when the refresh was requested run under the
   * definition they were admitted under; the refresh waits for them.
   */
  readonly advancePublication: () => Promise<boolean>;
  readonly eventScope: () => Promise<BotEventScope>;
  /** `/stop`: `events.withdraw(native.id)` then `harness.abort(...)`. */
  readonly stop: (context: ExecutionContext, signal?: AbortSignal) => Promise<boolean>;
}

/* ═══════════════════════════ conversation-drain.ts ═══════════════════════════ */

/**
 * Pi-only drain: every owned conversation has no live task other than
 * `cerebro.coordinator-reply`, no `pi.live.run` / generation / compaction /
 * running tool slot, and an empty `pi.inbox`. The event queue read is gone.
 */
export const nativeDrainIn = (_tx: Tx, _root: ConversationId): Promise<boolean> =>
  notImplemented("nativeDrainIn");

/* ═══════════════════════════ instruction-cause.ts ═══════════════════════════ */

/**
 * Candidates stay `pi.live.run.inputs` → submission `requestId` (= event
 * ID), so a batched run yields several. Verification per candidate, in tx:
 *   submissionByRequest(nativeId, eventId) placed|done and in run.inputs
 *   entry(submission.entry).kind === BOT_EVENT_INPUT, data.eventId === eventId
 *   receipt exists, digest matches, receipt.nativeId === nativeId, owner/address match
 *   source web|slack → human; savedtimer → routine; internal → none
 * `findLast` over candidates: a run mixing one human input with internal
 * inputs has a human cause; an internal-only run has none → Denied.
 */
export const requireInstructionCauseIn = (
  _tx: Tx,
  _options: {
    readonly address: EventAddress;
    readonly ownerPrincipalId: PrincipalId;
    readonly nativeId: ConversationId;
    readonly candidates: readonly { operationId: string; key: string; submissionId: unknown }[];
  }
): Promise<{ kind: "human" | "routine"; eventId: string }> =>
  notImplemented("requireInstructionCauseIn");

/* ═══════════════════════════ session-agent.ts ═══════════════════════════ */

/**
 * - `Harness.open(..., { settings: { followUpMode: "all", ... } })`.
 * - registry tasks: `[replies.definition]` only.
 * - `/owned-event` and web `send` → `events.admit` (unchanged entry points).
 * - job `cerebro-coordination`:
 *     const open = await scope.advancePublication();
 *     const pending = await events.wake(binding.nativeId);   // drives when open
 *     const replies = await host.replies.hold(binding.nativeId);
 *     reschedule in 5 s while `pending || replies || !open`.
 * - restore: for each binding, `events.restore()` (drive) after profiles load.
 */
export declare const sessionAgentChanges: never;

/* ═══════════════════════════ conversation-profile.ts ═══════════════════════════ */

/**
 * tools extension gains `createReplyEventTool(...)`; hooks gain
 * `createReplyNudge({ pi, nativeId, replies })`. Both are coordinator-only
 * (the nudge returns early when `api.conversationId !== nativeId`).
 */
export declare const conversationProfileChanges: never;

/* ═══════════════════════════ inspection-events.ts ═══════════════════════════ */

/**
 * `admission` ← `admissionStateIn(tx, receipt)`; `outcome` ← null (the state
 * already says done / unanswered). `reply.answerEntryId` → `reply.answerRef`
 * (contract field rename in `@cerebro/contracts/inspection`).
 */
export declare const inspectionEventChanges: never;
