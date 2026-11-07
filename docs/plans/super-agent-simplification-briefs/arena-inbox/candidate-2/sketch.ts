/**
 * Candidate 2: Pi is the queue; the app keeps one receipt and one tiny placer per event.
 *
 * Module map (packages/runtime/src):
 *   coordinator-event-state.ts   receipt type + doc family (shrunk; no admission state)
 *   coordinator-event-input.ts   model-visible text and entry drafts for events and nudges
 *   coordinator-events.ts        admit / enqueueIn / returnIn / read / list / wake / withdraw / pendingWeb
 *                                + the `cerebro.bot-event-admission` task (place | held)
 *   coordinator-event-scope.ts   BotEventScope (per-conversation policy the events module calls)
 *   conversation-event-scope.ts  BotEventScope implementation (prepareReply, placementOpen, authorize ...)
 *   coordinator-replies.ts       reply outbox (unchanged delivery layer; `ReplyAnswer` and `enqueueIn` change)
 *   coordinator-reply-tool.ts    NEW: `reply_event` tool, the onYield nudge hook, the prompt section
 *   instruction-cause.ts         human cause from the run's placed inputs (batched run aware)
 *   inspection-events.ts         admission status derived from Pi submission + task records
 *   conversation-scope.ts        Stop, snapshot merge, advancePublication() without releaseEvent
 *   conversation-drain.ts        nativeDrainIn without BotEventQueue; oldestHeldEventIn deleted
 *   session-agent.ts             followUpMode "all"; installs the admission task; wake() in the job
 *
 * Deleted (named at the bottom of this file).
 */
import type { BotEvent } from "@cerebro/contracts/bot-events";
import type { EventAdmission } from "@cerebro/contracts/bot-routing";
import type { EventAddress } from "@cerebro/contracts/events";
import type { ExecutionContext, PrincipalId } from "@cerebro/contracts/identity";
import type { InspectionEvent } from "@cerebro/contracts/inspection";
import type { ContentDependencies } from "@cerebro/contracts/session";
import type { ChatQueuedInput } from "@cerebro/contracts/session-service";
import type {
  SlackDeliveryStore,
  SlackReplyDestination,
} from "@cerebro/contracts/slack-events";
import type { TeamEventCommand, TeamEventReturn } from "@cerebro/contracts/team-events";
import type { SlackThread, WorkStatus } from "@cerebro/contracts/work";
import type {
  Conversation,
  ConversationId,
  Cursor,
  EntryId,
  Extension,
  Harness,
  HookRegistration,
  JsonObject,
  PromptSection,
  SubmissionId,
  TaskId,
  ToolRegistration,
  Tx,
} from "@earendil-works/pi-durable";

import type { createCoordinatorAdmissions } from "./coordinator-admission.ts";
import type { EventRecipient, EventSkip } from "./coordinator-event-state.ts";
import type { CoordinatorReply, ReplyOrigin } from "./coordinator-replies.ts";
import type { PiContext } from "./pi-harness.ts";

// ---------------------------------------------------------------------------
// 1. Contract types — coordinator-event-state.ts
// ---------------------------------------------------------------------------

/**
 * One event, once. Everything about *delivery progress* is derived from Pi and never written here:
 *   placed?     tx.submissionByRequest(nativeId, event.id)            (queued | placed | done | unanswered)
 *   held?       the admission task `delivery.taskId` is live            (pending publication)
 *   withdrawn?  that task is terminal `aborted`                         (Stop during a hold)
 *   failed?     that task is terminal `failed`                          (authorization or Pi refused)
 *   replied?    CoordinatorReplies[event.id] exists                     (reply tool or local control)
 *   nudged?     tx.submissionByRequest(nativeId, nudgeRequestId(id))    (onYield hook submitted a nudge)
 * Invariant: `delivery` is non-null iff this receipt owes the coordinator a placement; the task ID is the
 * durable link to the one re-driver, and it is created in the same transaction as the receipt.
 */
export type BotEventReceipt = {
  input: EventAdmission;
  digest: string;
  nativeId: ConversationId;
  duplicates: number;
} & (
  | {
      route: { kind: "coordinator"; skipped: EventSkip[] };
      delivery: { taskId: TaskId };
    }
  | {
      route: { kind: "teams"; recipients: EventRecipient[]; skipped: EventSkip[] };
      /** Null until a Team hands the event back; `returnIn` then creates the admission task. */
      delivery: { taskId: TaskId } | null;
    }
  | { route: { kind: "control"; workId: string; status: WorkStatus }; delivery: null }
  | {
      route: { kind: "local-answer"; action: "status" | "stop"; answerEntryId: EntryId };
      delivery: null;
    }
);

/** `cerebro.bot-event` doc family, version 3. `migrate` throws: pre-cutover data is not migrated. */
export declare const BotEventReceipts: unknown;

/** Entry data placed with every event input. `agentVersion`/`policyVersion` are gone. */
export interface BotEventInputData extends JsonObject {
  eventId: string;
  source: BotEvent["source"]["kind"];
  operationId?: string; // web only; the UI reads it for queued-input and message attribution
}
export const BOT_EVENT_INPUT_KIND = "cerebro.bot-event-input";

/** Entry data of a reply nudge the onYield hook submits; carries the cause of the event it nudges. */
export interface ReplyNudgeData extends JsonObject {
  eventId: string;
}
export const REPLY_NUDGE_KIND = "cerebro.reply-nudge";
/** Pi request ID of an event's one nudge; `submissionByRequest` on it answers "nudged?". */
export const nudgeRequestId = (eventId: string): string => `reply-nudge:${eventId}`;

// ---------------------------------------------------------------------------
// 2. Model-visible input — coordinator-event-input.ts
// ---------------------------------------------------------------------------

/**
 * Unchanged per source kind: web text verbatim; Slack as JSON with `eventId` (the handle for `reply_event`);
 * saved timer; internal report / terminal notice with the "cannot approve new team work" sentence.
 * A batched run sees one user message per event, in inbox order; no merging.
 */
export declare const botEventInput: (event: BotEvent) => string;

/** The submission draft for an event: `requestId = event.id`, `whenBusy: "followUp"`, entry kind BOT_EVENT_INPUT_KIND. */
export declare const eventSubmission: (event: BotEvent) => {
  readonly type: "input";
  readonly requestId: string;
  readonly whenBusy: "followUp";
  readonly content: string;
  readonly entry: { kind: typeof BOT_EVENT_INPUT_KIND; data: BotEventInputData };
};

/** "Slack event <id> has no reply yet. Use reply_event, or say in one line why no reply is needed." */
export declare const replyNudgeSubmission: (event: BotEvent) => {
  readonly type: "input";
  readonly requestId: string; // nudgeRequestId(event.id)
  readonly whenBusy: "followUp";
  readonly content: string;
  readonly entry: { kind: typeof REPLY_NUDGE_KIND; data: ReplyNudgeData };
};

/** Whether an event expects an external reply: `event.replyTo?.kind === "slack"`. Web and internal events do not. */
export declare const expectsReply: (event: BotEvent) => boolean;

// ---------------------------------------------------------------------------
// 3. Per-conversation policy — coordinator-event-scope.ts
// ---------------------------------------------------------------------------

export type EventRouteIn = (
  tx: Tx
) => Promise<
  | { kind: "coordinator"; skipped?: EventSkip[] }
  | Extract<BotEventReceipt["route"], { kind: "teams" | "control" | "local-answer" }>
>;

/** A reply the outbox will deliver. Text is always explicit now; no native answer entry is read. */
export type ReplyAnswer =
  | { readonly kind: "local"; readonly entryId: EntryId } // passive status/stop answer
  | { readonly kind: "tool"; readonly callId: string }; // reply_event call

/** What prepareReply resolved outside the transaction; `enqueueIn` writes it inside one. */
export interface PreparedReply {
  readonly destination: SlackReplyDestination | null;
  readonly dependencies: ContentDependencies;
  /** Authorization or lookup was denied: the record is written `blocked`, never delivered. */
  readonly blocked: boolean;
}

export interface BotEventScope {
  readonly native: Conversation;
  readonly ownerPrincipalId: PrincipalId;
  readonly admissions: ReturnType<typeof createCoordinatorAdmissions>;
  /** Throws ProfileChanged when the profile this scope was built from is no longer current. */
  readonly requireCurrent: () => void;
  readonly readAccess: (context: ExecutionContext) => Promise<void>;
  readonly authorize: (
    event: BotEvent,
    context?: ExecutionContext,
    signal?: AbortSignal,
    action?: "admit" | "deliver" | "read" | "control"
  ) => Promise<void>;
  readonly prepareRoute: (input: EventAdmission, context: ExecutionContext) => Promise<EventRouteIn>;
  /** Exact `status` / `stop`: passive answer, no model call; enqueues a local reply for Slack-origin events. */
  readonly prepareLocalControl: (
    event: BotEvent,
    action: "status" | "stop",
    context: ExecutionContext
  ) => Promise<EventRouteIn>;
  /**
   * The publication gate. Advances a pending publication when Pi is idle, then reports whether placement may
   * proceed: true iff `Bindings[session].refresh === null` and this scope is still current.
   * Replaces prepareAdmission + claimIn; there is no release event and no per-event claim.
   */
  readonly placementOpen: () => Promise<boolean>;
  /** Resolve destination + dependencies + authorization for a reply to `event` (null origin → blocked). */
  readonly prepareReply: (event: BotEvent, signal?: AbortSignal) => Promise<PreparedReply>;
  readonly deliverReply: (
    record: CoordinatorReply,
    store: SlackDeliveryStore,
    signal?: AbortSignal
  ) => Promise<void>;
  readonly routingAccess: (
    context: ExecutionContext,
    dependencies: ContentDependencies
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// 4. Events module — coordinator-events.ts
// ---------------------------------------------------------------------------

/** Checkpoint of the admission task. `held` exists only while a publication is pending. */
export type AdmissionCheckpoint =
  | { phase: "place"; attempt: number }
  | { phase: "held"; attempt: number; until: number };

export type AdmissionOutcome = { placed: true; submissionId: SubmissionId };

export const createCoordinatorEvents = (options: {
  readonly pi: Harness;
  /** Binding lookup inside a transaction: the native conversation an address maps to. */
  readonly targetIn: (tx: Tx, address: EventAddress) => Promise<{ nativeId: ConversationId }>;
  readonly resolve: (address: EventAddress) => Promise<BotEventScope>;
  readonly scan: (cursor?: Cursor) => Promise<{ keys: readonly string[]; next?: Cursor }>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly holdReplies?: () => Promise<boolean>;
}) => {
  /**
   * `cerebro.bot-event-admission`, version 1. Input `{ eventId }`. Background, conversation-owned, created in
   * the same transaction as the receipt (enqueueIn / returnIn), so a receipt without a live or terminal task
   * cannot exist. Phases:
   *
   *   place: receipt = read(eventId); verify delivery.taskId === runtime.taskId, nativeId, digest.
   *          scope = resolve(event.coordinator); requireScope(receipt, scope).
   *          if (!(await scope.placementOpen())) → commit { phase: "held", attempt, until: now + 1000 }.
   *          await scope.authorize(event, undefined, signal, "deliver")   // Denied → terminal failed
   *          submission = await scope.native.submit(eventSubmission(event), context)
   *            // requestId = event.id: a replay after a crash returns the existing submission, writes nothing.
   *          commit terminal completed { placed: true, submissionId }.
   *          Transient errors: retry with backoff (attempt < 5), then terminal failed.
   *          ProfileChanged: re-enter place (the scope is re-resolved).
   *   held:  runtime.sleep(until) → commit { phase: "place", attempt }.
   *   abort: terminal aborted. Nothing to undo: no submission was made (abort before place) or the
   *          submission exists and Stop's native.abort() withdraws it from Pi's inbox.
   *
   * No predecessor wait: order within a burst is Pi inbox order, which is task scheduling order (creation
   * order in practice). No settlement: the run answers the batch; replies are the model's tool calls.
   */
  const definition: unknown = undefined; // defineTask<{ eventId: string }, AdmissionCheckpoint, AdmissionOutcome>

  /** Create the placer for `eventId` in this transaction and return its ID. */
  const createAdmissionTaskIn = (
    _tx: Tx,
    _eventId: string,
    _nativeId: ConversationId
  ): Promise<TaskId> => {
    throw new Error("not implemented");
  };

  /**
   * Record one event inside a transaction. Dedup: same ID + same digest → duplicates += 1, return the saved
   * receipt; same ID + other digest → Conflict. Routing decided by `routeIn` (default coordinator).
   * Coordinator-routed receipts get their admission task here. Backpressure: Unavailable(retryAfter 5)
   * when the target conversation's Pi inbox already holds ≥ MAX_QUEUED_INPUTS user items (read from InboxDoc
   * in this transaction); replaces the identity-wide 96/64 caps and the BotEventQueue.
   */
  const enqueueIn = (
    _tx: Tx,
    _input: EventAdmission,
    _routeIn?: EventRouteIn
  ): Promise<BotEventReceipt> => {
    throw new Error("not implemented");
  };

  /**
   * HTTP / queue / web / timer entry point. authorize(admit|control) → digest conflict check → prepareRoute /
   * prepareLocalControl outside the transaction → admissions.commit(event.id, tx => enqueueIn(tx, input, routeIn))
   * → wake(nativeId) so the DO alarm tracks the new task. Returns the receipt; `duplicates` tells a web caller
   * whether this was a replay. Nothing here waits for Pi: the admission task places the input.
   */
  const admit = (_input: EventAdmission, _context: ExecutionContext): Promise<BotEventReceipt> => {
    throw new Error("not implemented");
  };

  /**
   * Team handback. Verifies the Team route and recipient as today; on the first return creates the admission
   * task and sets `delivery = { taskId }`. Idempotent on the return digest.
   */
  const returnIn = (_tx: Tx, _delivery: TeamEventReturn, _origin?: "team" | "source"): Promise<void> => {
    throw new Error("not implemented");
  };

  /**
   * Live admission tasks of a conversation, read from Pi's task table (no app index):
   * scanTasks({ conversationId, kind: "cerebro.bot-event-admission", status }) for status in pending|running|waiting.
   * Terminal tasks accumulate like every Pi task; the status filter keeps this read bounded by live work.
   */
  const liveAdmissionsIn = (
    _tx: Tx,
    _nativeId: ConversationId
  ): Promise<readonly { taskId: TaskId; eventId: string }[]> => {
    throw new Error("not implemented");
  };

  return {
    definition,
    enqueueIn,
    admit,
    returnEventIn: (_tx: Tx, _command: TeamEventCommand): Promise<void> => {
      throw new Error("not implemented");
    },
    receiveReturn: (_input: unknown, _context: ExecutionContext) => {
      throw new Error("not implemented");
    },
    /** Track live admission tasks for the DO alarm; returns whether any exist. Used by restore and the job. */
    wake: (_nativeId?: ConversationId): Promise<boolean> => {
      throw new Error("not implemented");
    },
    restore: (): Promise<boolean> => {
      throw new Error("not implemented");
    },
    /**
     * Stop: abort every live admission task of the conversation (events held by a pending publication).
     * Called alongside native.abort(), which withdraws what is already in Pi's inbox. Unavailable(retry) if a
     * task is neither terminal nor abort-marked afterwards.
     */
    withdraw: (_nativeId: ConversationId): Promise<void> => {
      throw new Error("not implemented");
    },
    /**
     * Web events that are held (live admission task, not yet in Pi's inbox), as ChatQueuedInput with their
     * operation IDs. The snapshot merges these behind Pi's own inbox items. Empty whenever no publication is pending.
     */
    pendingWeb: (_nativeId: ConversationId): Promise<ChatQueuedInput[]> => {
      throw new Error("not implemented");
    },
    read: (_id: string, _context: ExecutionContext): Promise<BotEventReceipt> => {
      throw new Error("not implemented");
    },
    list: (
      _address: EventAddress,
      _context: ExecutionContext,
      _cursor?: Cursor
    ): Promise<{ items: BotEventReceipt[]; next?: Cursor }> => {
      throw new Error("not implemented");
    },
    listSubscribedBotSources: (_thread: SlackThread, _context: ExecutionContext) => {
      throw new Error("not implemented");
    },
    /** Internal read without authorization, for the reply tool and the nudge hook (same conversation only). */
    readOwnedIn: (_tx: Tx, _nativeId: ConversationId, _eventId: string): Promise<BotEventReceipt> => {
      throw new Error("not implemented");
    },
    liveAdmissionsIn,
    createAdmissionTaskIn,
  };
};
export type CoordinatorEvents = ReturnType<typeof createCoordinatorEvents>;

// ---------------------------------------------------------------------------
// 5. Publication gate — conversation-scope.ts / conversation-bindings.ts / conversation-drain.ts
// ---------------------------------------------------------------------------

/** `releaseEvent` is deleted. `refresh` is the whole gate. */
export interface ConversationBinding extends JsonObject {
  address: { [Key in keyof EventAddress]: EventAddress[Key] };
  agentVersion: number;
  nativeId: ConversationId;
  refresh: { agentVersion: number } | null;
}

/**
 * On ConversationScope. Called by placementOpen() (every admission task, so an arriving event drives the
 * publication, as today).
 *   1. If latest published version != binding.agentVersion and no refresh is pending: set `refresh`.
 *   2. If a refresh is pending: prepare the target profile, then in ONE transaction: require
 *      nativeDrainIn(tx, nativeId) — no live run (LiveDoc.run undefined), no user items in InboxDoc, no
 *      approvals, no leases, no live tasks except kinds cerebro.bot-event-admission and cerebro.coordinator-reply —
 *      then configure(tx, nativeId, candidate.agent) and set agentVersion, refresh = null. Uninstall the
 *      superseded profile afterwards.
 *   3. Return `binding.refresh === null`.
 * Invariant (constraint 5): a submission admitted after this transaction runs under the new definition; one
 * admitted before it either started a run (drain fails, activation retries on the next poll) or sits in the
 * inbox (drain fails). No input runs under a definition older than the one in force when it was placed.
 */
export declare const advancePublication: (this: unknown) => Promise<boolean>;

/** nativeDrainIn: as today minus the BotEventQueue block; admission tasks are excluded by kind. oldestHeldEventIn: deleted. */
export declare const nativeDrainIn: (tx: Tx, root: ConversationId) => Promise<boolean>;

// ---------------------------------------------------------------------------
// 6. Replies — coordinator-replies.ts (delivery layer) and coordinator-reply-tool.ts (decision layer)
// ---------------------------------------------------------------------------

/** Record keyed by event ID; one reply per event. `answerEntryId` → `answer`. Delivery fields unchanged. */
export interface CoordinatorReplyRecord extends JsonObject {
  eventId: string;
  source: { [Key in keyof EventAddress]: EventAddress[Key] };
  answer: ReplyAnswer;
  destination: SlackReplyDestination | null;
  dependencies: { sourceIds: string[]; toolIds: string[] };
  key: string; // digest([thread ?? eventId, sessionId, answer.kind === "tool" ? answer.callId : String(answer.entryId)])
  text: string; // conciseSlackText(toSlackText(text)); never re-read from the transcript
  delivery: CoordinatorReply["delivery"];
  taskId: TaskId | null;
  attempts: number;
  until: number;
}

/**
 * Outbox write. Idempotent on (eventId, answer): a replay of the same tool call returns; another answer for an
 * event that already has one throws Conflict("already replied"). `blocked` or empty text or null destination
 * → record written blocked, no task. Outbox cap 96 stays (Unavailable retryAfter 5).
 */
export declare const enqueueReplyIn: (
  tx: Tx,
  input: {
    readonly event: BotEvent;
    readonly nativeId: ConversationId;
    readonly answer: ReplyAnswer;
    readonly text: string;
    readonly prepared: PreparedReply;
  }
) => Promise<{ state: "queued" | "blocked" }>;

/** Unchanged: Slack → the event's thread; savedtimer → saved destination; teamreport/terminal notice → the human origin. */
export declare const replyOrigin: (pi: Harness, event: BotEvent) => Promise<ReplyOrigin | null>;

/**
 * `reply_event` — callers ["model"], replay "safe".
 * parameters: { eventId: string(1..512), text: string(1..16000) }
 * execute:
 *   1. api.conversationId === nativeId, else Denied.
 *   2. receipt = events.readOwnedIn(tx, nativeId, eventId) (snapshot read; NotFound → isError).
 *      The event must have been placed in this conversation: submissionByRequest(nativeId, eventId) defined.
 *   3. event = eventOf(receipt). Web events: isError "This event needs no reply; the transcript is the reply."
 *   4. prepared = await scope.prepareReply(event, signal)   // destination, dependencies, authorization now
 *   5. api.commit(tx => enqueueReplyIn(tx, { event, nativeId, answer: { kind: "tool", callId: api.callId }, text, prepared }))
 *   6. holdReplies(); return JSON { eventId, state }.
 * The outbox task re-authorizes at post time, retries rate limits, and never repeats an uncertain post.
 */
export declare const createReplyTool: (options: {
  readonly nativeId: ConversationId;
  readonly events: Pick<CoordinatorEvents, "readOwnedIn">;
  readonly scope: () => Pick<BotEventScope, "prepareReply">;
  readonly holdReplies: () => Promise<boolean>;
}) => ToolRegistration;

/**
 * The nudge. hook(GenerationTask, { onYield }) on the coordinator's tools extension:
 *   for each submission ID in LiveDoc.run.inputs (this run's placed inputs):
 *     requestId → receipt (api.snapshot(BotEventReceipts, requestId)); skip unless receipt.nativeId === nativeId
 *     && expectsReply(event) && no CoordinatorReplies[event.id] && no submissionByRequest(nudgeRequestId(event.id)).
 *   For each remaining event: native.submit(replyNudgeSubmission(event)) — a durable follow-up input.
 *   Return undefined (never `{ continue }`).
 * Why a follow-up and not `continue`: Pi applies an onYield continuation only when the final boundary selected
 * no user item (generation.js:433); with a burst waiting the nudge would be dropped. A follow-up submitted
 * before the ending commit is placed by that commit's boundary: alone it starts the next run at once, with a
 * burst it joins the batch. One nudge per event ever (requestId dedup). After the nudge the event stays
 * unreplied if the model still declines; the Inspector shows reply null + nudged.
 */
export declare const createReplyNudge: (options: {
  readonly pi: Harness;
  readonly nativeId: ConversationId;
  readonly native: Conversation;
}) => HookRegistration;

/** Prompt section "external-replies": Slack events carry an eventId; answer them with reply_event; web needs none. */
export declare const replyGuidance: PromptSection;

/** conversation-profile.ts adds to the tools extension: tools [...existing, replyTool], hooks [..., replyNudge], sections [replyGuidance]. */
export declare const toolsExtension: Extension;

// ---------------------------------------------------------------------------
// 7. Human cause in a batched run — instruction-cause.ts
// ---------------------------------------------------------------------------

export interface InstructionCandidate {
  readonly requestId: string;
  readonly submissionId: SubmissionId;
}
export interface InstructionCause extends InstructionCandidate {
  readonly kind: "human" | "routine";
  readonly eventId: string;
}

/** Candidates = LiveDoc.run.inputs → submission.requestId (unchanged). */
export declare const currentInstructionCandidates: (
  pi: Harness,
  nativeId: ConversationId
) => Promise<InstructionCandidate[]>;

/**
 * In the transaction: for each candidate, the submission must be by that requestId, in run.inputs, placed|done.
 * Entry kind BOT_EVENT_INPUT_KIND → data.eventId; REPLY_NUDGE_KIND → data.eventId (a nudge run keeps the
 * nudged event's cause). Receipt must exist, match nativeId / owner / address, and have the recorded digest.
 * web|slack → human; savedtimer → routine; teamreport|terminal notice → none. A batch mixing human and internal
 * inputs yields the last human one. No `pi.user` branch, no claim/version checks, no allowLegacyUser.
 */
export declare const requireInstructionCauseIn: (
  tx: Tx,
  options: {
    readonly address: EventAddress;
    readonly ownerPrincipalId: PrincipalId;
    readonly nativeId: ConversationId;
    readonly candidates: readonly InstructionCandidate[];
  }
) => Promise<InstructionCause>;

// ---------------------------------------------------------------------------
// 8. Inspector — inspection-events.ts
// ---------------------------------------------------------------------------

/**
 * Admission column derived, in this order: delivery null → "none"; submissionByRequest(nativeId, id) present →
 * its status ("queued" | "placed" | "done" | "unanswered", outcome = reason); else task record by delivery.taskId:
 * live → "held", terminal aborted → "withdrawn", terminal failed → "failed" (outcome = error message).
 * reply: { answerRef: callId | entryId, taskId, state, attempts, deadlineAt, retryAt, timestamp }.
 */
export declare const readInspectionEvents: (input: {
  readonly pi: Harness;
  readonly keys: readonly string[];
  readonly nativeId: ConversationId;
  readonly address: EventAddress;
  readonly ownerPrincipalId: PrincipalId;
  readonly signal?: AbortSignal;
}) => Promise<{ items: InspectionEvent[]; dependencies: ContentDependencies[] }>;

// ---------------------------------------------------------------------------
// 9. Glue — coordinator-web.ts, conversation-scope.ts, conversation-snapshot.ts, session-agent.ts
// ---------------------------------------------------------------------------

/**
 * web.send: build the web BotEvent (id from operationId), routing local-control for exact status/stop else
 * automatic, events.admit(...). Receipt: accepted = local || duplicates === 0. Replay by operation ID is the
 * receipt dedup (constraint 7). The legacy direct-submission branch, SourceOperations and replayHandled go.
 */
export declare const webSend: (
  operationId: string,
  text: string,
  context: ExecutionContext,
  signal?: AbortSignal
) => Promise<{ accepted: boolean; operationId: string; session: string }>;

/** /stop: Promise.all([harness.abort({ session }), events.withdraw(native.id)]). */
export declare const stop: () => Promise<{ stopped: boolean }>;

/**
 * Snapshot: queuedInputs = Pi inbox items (pi-harness queuedInputs already reads operationId from
 * BOT_EVENT_INPUT_KIND data; REPLY_NUDGE_KIND items are hidden) + events.pendingWeb(native.id) not already visible.
 */
export declare const conversationSnapshot: unknown;

/** Harness.open settings: { followUpMode: "all", steeringMode: "one-at-a-time" (unchanged), ... }. */
export declare const harnessSettings: { followUpMode: "all" };

/** cerebro-coordination job: events.wake(nativeId) || replies.hold(nativeId) → reschedule in 5 s. */
export declare const coordinationJob: unknown;

/** Identity request handler: `owned-event` → events.admit(admission, context) → { eventId } (unchanged). */
export declare const ownedEventRequest: unknown;

/** piContext stays the Pi context factory; no change. */
export type { PiContext };

// ---------------------------------------------------------------------------
// 10. Deleted
// ---------------------------------------------------------------------------
//
// coordinator-events.ts        cerebro.bot-event-delivery task (deliver / admission-wait / settle / retry),
//                              reserveDeliveryIn caps, settledAdmission, withdraw, abortPending, hold-by-queue
// coordinator-event-state.ts   BotEventAdmission, CoordinatorEventDelivery, Claim, BotEventQueue, BotEventSequence,
//                              receipt.sequence, legacy v1 codec and migrate
// coordinator-event-input.ts   webPendingInput, eventHasPredecessorIn, abortPendingEvents, pendingWebInputs
// coordinator-event-scope.ts   agentVersion, policyVersion, prepareAdmission, claimIn, prepareSettlement
// conversation-event-scope.ts  prepareSettlement; prepareReply becomes public
// coordinator-event-access.ts  whole file (authorizeEventDelivery); the task calls scope.authorize directly
// conversation-bindings.ts     ConversationBinding.releaseEvent, policyVersion, legacyVersion
// conversation-drain.ts        oldestHeldEventIn; the BotEventQueue block in nativeDrainIn
// conversation-scope.ts        advancePublication(eventId) parameter; releaseEvent handling in advance()
// coordinator-replies.ts       ReplyAnswer "native"; enqueueIn reading the answer entry's assistant text
// coordinator-source.ts        whole file (routeHuman / replayHandled), with coordinator-web's legacy branch
// instruction-cause.ts         eventData claim fields, pi.user branch, allowLegacyUser
// pi-harness.ts                nothing deleted; queuedInputs hides REPLY_NUDGE_KIND items
