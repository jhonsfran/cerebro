/**
 * Candidate 3: channels are adapters; the runtime core owns one `Trigger` and one `Reply`.
 *
 * Reading order
 *   §1 contracts: Trigger, TriggerOrigin, ReplyDestination, TriggerAdmission, entry data
 *   §2 channel ports: ReplyPort registry, inputText
 *   §3 runtime triggers module: Receipts, Backlog, TriggerScope, createTriggers
 *   §4 replies: Reply record, outbox task, reply_event tool, onYield nudge
 *   §5 instruction cause in a batched run
 *   §6 call-site changes (signatures only)
 *   §7 deletions
 *
 * Every body is `throw new Error("not implemented")`; tricky logic is `// TODO` pseudocode.
 * Imports name the real modules so a reader can trace data from an HTTP request to a Slack post
 * by reading this file plus Pi's `Conversation.submit`.
 *
 * Pi facts this sketch rests on (verified in @earendil-works/pi-durable 1.3.0):
 *   - `Conversation.submit({ requestId })` returns the existing submission for a known requestId without
 *     writing (dist/harness/submissions.js admitSubmission). That is the only dedup the placement needs.
 *   - `followUpMode: "all"` places every queued follow-up at the final boundary into one run
 *     (dist/harness/inbox.js applyBoundary); `endRun` settles all of them with one answer entry.
 *   - `Conversation.abort()` withdraws queued inputs (settled `unanswered`/`aborted`) and aborts the run.
 *   - `admitSubmission` is not exported: a receipt commit and a Pi submission are two commits.
 *     Atomicity comes from `Backlog` + idempotent re-drive, not from one transaction.
 *   - `GenerationHooks.onYield` may return `{ continue: UserInput }`; a hook may close over the Harness
 *     (run-limits.ts does) and read submissions through `pi.submission(id).status()`.
 */

import type { EventAddress } from "@cerebro/contracts/events";
import type {
  ExecutionContext,
  OperationId,
  PrincipalId,
} from "@cerebro/contracts/identity";
import type { ChatQueuedInput } from "@cerebro/contracts/session-service";
import type { ContentDependencies } from "@cerebro/contracts/session";
import type { SlackEventAuthority } from "@cerebro/contracts/slack-events";
import type { TeamEventCommand } from "@cerebro/contracts/team-events";
import type {
  SlackThread,
  WorkKey,
  WorkReportId,
  WorkStatus,
} from "@cerebro/contracts/work";
import type {
  Conversation,
  ConversationId,
  Cursor,
  EntryId,
  Harness,
  HookRegistration,
  JsonObject,
  TaskId,
  ToolRegistration,
  Tx,
} from "@earendil-works/pi-durable";

// ───────────────────────────────────────────────────────────────────────────────────────────────
// §1 Contracts — packages/contracts/src/triggers.ts
//     (replaces bot-events.ts, bot-routing.ts, and the reply-destination half of slack-events.ts)
// ───────────────────────────────────────────────────────────────────────────────────────────────

export type TriggerId = string & { readonly __brand: "TriggerId" };

/**
 * Who stands behind a trigger, as the adapter that produced it decided. The runtime core reads policy
 * off `actor` and never off `origin.kind`:
 *   human    may authorize new Team work and new schedules
 *   routine  an authorized saved instruction; may cause a schedule, may cause Team work (today's rule)
 *   internal a report or notice the system raised; can never authorize new work
 */
export type TriggerActor = "human" | "routine" | "internal";

/** Channel identity of a trigger. Adding a channel adds one member here and one adapter. */
export type TriggerOrigin =
  | { readonly kind: "web"; readonly operationId: OperationId }
  | {
      readonly kind: "slack";
      readonly eventId: string;
      readonly thread: SlackThread;
    }
  | {
      readonly kind: "timer";
      readonly scheduleId: string;
      readonly occurrenceId: string;
    }
  | {
      readonly kind: "teamreport";
      readonly key: WorkKey;
      readonly reportId: WorkReportId;
      readonly outcome: "completed" | "failed" | "cancelled";
    }
  | {
      readonly kind: "teamnotice";
      readonly key: WorkKey;
      readonly reason: "expired" | "dispatch-failed";
    };

/**
 * Where a reply to a trigger is posted. Recorded with the trigger at admission; never resolved later.
 * A channel without a destination (web) replies through the transcript. Adding a channel adds a member
 * here and a `ReplyPort` for it; the outbox and the tool dispatch on `kind` only.
 */
export type ReplyDestination = {
  readonly kind: "slack";
  readonly authority: SlackEventAuthority;
  readonly ownerPrincipalId: PrincipalId;
  readonly source: EventAddress;
};

/**
 * One thing that may wake the coordinator. Produced by an adapter, validated once at the boundary,
 * stored verbatim in its receipt, placed into Pi as one user message.
 *
 * Invariants the schema filter encodes (the current channel table lives here, not in the runtime):
 *   - `id === triggerId(address, origin)`
 *   - `origin.kind === "web"` ⇒ `reply === null` (the transcript is the reply)
 *   - `actor === "internal"` ⇔ `origin.kind ∈ {teamreport, teamnotice}`
 *   - `actor === "human"` ⇒ `origin.kind ∈ {web, slack}`
 *   - text length within the per-origin limit (web/slack 16k, timer 32k, team 2k)
 *   - a `reference.key` or an origin `key` shares the trigger's organization and owner
 */
export interface Trigger {
  readonly version: 2;
  readonly id: TriggerId;
  /** The coordinator conversation this trigger wakes. */
  readonly address: EventAddress;
  readonly ownerPrincipalId: PrincipalId;
  readonly origin: TriggerOrigin;
  readonly actor: TriggerActor;
  readonly text: string;
  readonly reference: { readonly kind: "work"; readonly key: WorkKey } | null;
  readonly reply: ReplyDestination | null;
  readonly dependencies: ContentDependencies;
}

/**
 * Stable identity: same digest scheme and `bot-event:` prefix as today's `botEventId`, so receipts
 * written before the migration keep their keys. Identity per origin kind is unchanged
 * (web: operationId; slack: workspace+eventId; timer: schedule+occurrence; team: workId+reportId/reason).
 */
export const triggerId = (
  _address: EventAddress,
  _origin: TriggerOrigin
): Promise<TriggerId> => {
  throw new Error("not implemented");
};

/** How the caller wants the trigger routed. `direct` (a bare Trigger) always means the coordinator inbox. */
export type TriggerRouting =
  | { readonly kind: "automatic" }
  | {
      readonly kind: "control";
      readonly workId: string;
      readonly action: "update" | "cancel";
    }
  | { readonly kind: "local-control"; readonly action: "status" | "stop" };

export interface TriggerAdmission {
  readonly version: 3;
  readonly kind: "trigger-admission";
  readonly trigger: Trigger;
  readonly routing: TriggerRouting;
}
/** Wire → domain. Throws InvalidInput on any violation; nothing downstream re-validates. */
export const parseTriggerAdmission = (
  _wire: unknown
): {
  readonly trigger: Trigger;
  readonly routing: TriggerRouting | { readonly kind: "direct" };
  readonly digest: Promise<string>;
} => {
  throw new Error("not implemented");
};

/** Entry kind of every trigger input in the transcript (replaces `cerebro.bot-event-input`). */
export const TRIGGER_ENTRY_KIND = "cerebro.trigger" as const;
/**
 * Entry data placed with the input. The web UI reads `operationId`; instruction-cause reads `id` and
 * `actor`, and verifies both against the receipt. No agent or policy version: the gate (§3) guarantees
 * the definition in force at placement, so nothing needs to be re-checked at run time.
 */
export interface TriggerInputData extends JsonObject {
  id: TriggerId;
  actor: TriggerActor;
  channel: TriggerOrigin["kind"];
  operationId?: OperationId;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// §2 Channel ports — the only thing a channel contributes besides producing Triggers
// ───────────────────────────────────────────────────────────────────────────────────────────────

/** Durable state of one post; unchanged shape of today's SlackDelivery, renamed. */
export type ReplyDelivery =
  | { readonly state: "sent"; readonly text: string; readonly ts: string }
  | { readonly state: "unknown" | "failed"; readonly text: string }
  | { readonly state: "retry"; readonly text: string; readonly retryAt?: number }
  | {
      readonly state: "blocked";
      readonly text: string;
      readonly reason: "access-changed" | "cancelled";
    };
export interface ReplyDeliveryStore {
  readonly get: (key: string) => Promise<ReplyDelivery | undefined>;
  readonly set: (key: string, delivery: ReplyDelivery) => Promise<void>;
}

/**
 * What a channel implements to receive replies. `authorize` is the post-time check (current link,
 * authority unchanged); `deliver` owns the channel's never-repeat-an-uncertain-post rule through
 * `store` (today's deliverSlackMessage, unchanged). The outbox calls `beforePost` right before the
 * network call so authorization and content dependencies are re-checked at post time.
 */
export interface ReplyPort<D extends ReplyDestination = ReplyDestination> {
  readonly authorize: (destination: D) => Promise<void>;
  readonly deliver: (input: {
    readonly destination: D;
    readonly key: string;
    readonly text: string;
    readonly store: ReplyDeliveryStore;
    readonly beforePost: () => Promise<void>;
  }) => Promise<void>;
}
/** The reply destination registry: one port per destination kind the deployment can reach. */
export type ReplyPorts = {
  readonly [K in ReplyDestination["kind"]]?: ReplyPort<
    Extract<ReplyDestination, { kind: K }>
  >;
};

/**
 * The one user message a trigger becomes. Phrasing per origin is today's `botEventInput`, kept:
 *   web        text verbatim (the UI renders it as the person's message; the id rides in entry data)
 *   slack      `Slack message. Reply with reply_event.\n{"eventId": <id>, "text": ...}`
 *   timer      `Saved authorized instruction (eventId <id>).\n<text>`
 *   teamreport/teamnotice
 *              `Internal coordinator event. This event is not a new human request and cannot approve
 *               new team work.` + JSON `{eventId, origin, text, reference}`
 * Every non-web trigger names its id, and one with `reply !== null` says a reply is expected.
 */
export const inputText = (_trigger: Trigger): string => {
  throw new Error("not implemented");
};

// ───────────────────────────────────────────────────────────────────────────────────────────────
// §3 Runtime — packages/runtime/src/triggers.ts
//     (replaces coordinator-events.ts, coordinator-event-state.ts, coordinator-event-input.ts,
//      coordinator-event-scope.ts, conversation-event-scope.ts, coordinator-event-access.ts)
// ───────────────────────────────────────────────────────────────────────────────────────────────

export interface EventRecipient extends JsonObject {
  key: WorkKey;
  admissionDigest: string;
  commandId: string;
  disposition:
    | { kind: "admitted" }
    | { kind: "returned"; digest: string }
    | { kind: "not-delivered"; reason: "cancelled" | "expired" };
}
export interface EventSkip extends JsonObject {
  workId: string;
  reason: "missing" | "denied" | "terminal" | "full";
}

/**
 * The receipt is what the adapter is told and what dedup is decided on. It carries no Pi state:
 * whether the trigger is queued, placed, answered, or withdrawn is read from Pi by `requestId`.
 *
 *   route inbox         placed through Pi under `requestId = trigger.id`
 *   route local-answer  answered without a model call in the admitting commit (`status`/`stop`)
 *   route teams/control Team routing (out of scope, kept as-is); a `returned` recipient makes
 *                       `placeIn` add the trigger to the Backlog, after which it is an inbox trigger
 */
export interface TriggerReceipt extends JsonObject {
  trigger: Trigger;
  /** digest of the admission wire; same id + other digest is a Conflict, same digest counts a duplicate */
  digest: string;
  nativeId: ConversationId;
  duplicates: number;
  route:
    | { kind: "inbox" }
    | { kind: "local-answer"; action: "status" | "stop"; answerEntryId: EntryId }
    | { kind: "teams"; recipients: EventRecipient[]; skipped: EventSkip[] }
    | { kind: "control"; workId: string; status: WorkStatus };
}
/**
 * Session-scoped family keyed by trigger id, kind `cerebro.bot-event` version 3 (same kind, so the
 * Inspector's key scan and existing documents carry over). `migrate` from version 2 drops
 * `delivery`, `sequence`, `input` → `trigger` (adds `actor` from the old source kind, `reply` from
 * `replyTo` where it was a recorded destination, else null).
 */
export declare const Receipts: unknown; // defineDocFamily<{ receipt: TriggerReceipt | null }, null>

/**
 * Per conversation: trigger ids accepted but not yet handed to Pi, in arrival order. Non-empty only
 * between the receipt commit and the submit commit, or while the publication gate holds. Bounded by
 * `MAX_WAITING` together with Pi's inbox. This is the whole re-drive state; nothing else records
 * "where" a trigger is.
 */
export declare const Backlog: unknown; // defineDoc<{ ids: TriggerId[] }> scope "conversation", history "latest"
/** Inbox items + backlog per conversation; replaces the 96/64 identity-wide caps. */
export const MAX_WAITING = 64;

/** Where a trigger is, derived at read time from Pi and the Backlog. Never stored. */
export type TriggerPlacement =
  | { readonly kind: "backlog" }
  | { readonly kind: "queued"; readonly submissionId: string }
  | { readonly kind: "placed"; readonly submissionId: string; readonly entry: EntryId }
  | {
      readonly kind: "done";
      readonly submissionId: string;
      readonly entry: EntryId;
      readonly answer: EntryId;
    }
  | { readonly kind: "unanswered"; readonly submissionId: string; readonly reason: string }
  /** receipt route is inbox, no submission, not in the backlog: Stop withdrew it before placement */
  | { readonly kind: "withdrawn" }
  | { readonly kind: "local-answer"; readonly answer: EntryId }
  | { readonly kind: "routed"; readonly route: "teams" | "control" };

export type RouteIn = (
  tx: Tx
) => Promise<
  | { kind: "inbox" }
  | Extract<TriggerReceipt["route"], { kind: "teams" | "control" | "local-answer" }>
>;

/**
 * What the trigger module needs from one conversation. Replaces BotEventScope. No admission claim,
 * no settlement, no reply delivery: those were the delivery task's concerns.
 */
export interface TriggerScope {
  readonly native: Conversation;
  readonly ownerPrincipalId: PrincipalId;
  /** Throws ProfileChanged when the profile this scope was built from is no longer current. */
  readonly requireCurrent: () => void;
  /** Caller-context authorization at the boundary; `admit` also checks `trigger.dependencies`. */
  readonly authorize: (
    trigger: Trigger,
    context: ExecutionContext | undefined,
    action: "admit" | "control" | "read",
    signal?: AbortSignal
  ) => Promise<void>;
  /** Lease-serialized native commit (CoordinatorAdmissions) that also arms the coordination wake job. */
  readonly commit: <A>(key: string, change: (tx: Tx) => Promise<A>) => Promise<A>;
  /**
   * Publication gate. "open": the bound definition is the one that must run the next placement, and the
   * in-memory profile matches it. "waiting": a refresh is pending and Pi is not drained; the caller must
   * not hand inputs to Pi. Pure read when no refresh is pending; otherwise may `configure` in one commit.
   */
  readonly gate: () => Promise<"open" | "waiting">;
  /** Team routing (subscriptions). Out of scope; signature kept. */
  readonly route?: (admission: TriggerAdmission, context: ExecutionContext) => Promise<RouteIn>;
  /** Exact `status`/`stop`: appends the trigger entry and a passive answer, and enqueues a reply when `trigger.reply`. */
  readonly localAnswer?: (
    trigger: Trigger,
    action: "status" | "stop",
    context: ExecutionContext
  ) => Promise<RouteIn>;
  readonly routingAccess?: (context: ExecutionContext, dependencies: ContentDependencies) => Promise<void>;
  readonly readAccess: (context: ExecutionContext) => Promise<void>;
}

export const createTriggers = (_options: {
  readonly pi: Harness;
  readonly resolve: (address: EventAddress) => Promise<TriggerScope>;
  /** Receipt key scan for `list` (Inspector). */
  readonly scan: (cursor?: Cursor) => Promise<{ readonly keys: readonly string[]; readonly next?: Cursor }>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  /** Reschedule `drain` for a conversation after `delayMs` (the coordination lifecycle job). */
  readonly wake: (nativeId: ConversationId, delayMs: number) => Promise<void>;
}) => ({
  /**
   * Boundary entry for every adapter that holds a request context (web, Slack, timers).
   * Idempotent by trigger id: a known id with the same digest counts a duplicate and returns the saved
   * receipt; another digest is a Conflict. Nothing here is a task.
   *
   * TODO
   *   { trigger, routing, digest } = parseTriggerAdmission(wire)
   *   scope = resolve(trigger.address); require scope.ownerPrincipalId === trigger.ownerPrincipalId
   *   scope.authorize(trigger, context, routing.kind === "local-control" ? "control" : "admit")
   *   previous = pi.snapshot(Receipts, trigger.id); previous && previous.digest !== digest → Conflict
   *   routeIn = previous ? undefined
   *           : routing local-control → scope.localAnswer(...)
   *           : routing automatic|control → scope.route(...)      (Denied "revoked" when absent)
   *           : direct → tx => ({ kind: "inbox" })
   *   receipt = scope.commit(trigger.id, tx => { scope.requireCurrent(); return acceptIn(tx, wire, routeIn) })
   *   waitUntil(drain(scope.native.id))         // placement; a failure here is re-driven by wake/restore
   *   return receipt
   * Crash before commit: nothing written, the caller retries with the same id.
   * Crash after commit: the id is in the Backlog; `drain` runs on restore and on every coordination wake.
   */
  admit: (_wire: unknown, _context: ExecutionContext): Promise<TriggerReceipt> => {
    throw new Error("not implemented");
  },
  /**
   * Transactional entry for adapters that already hold a commit (Team reports and notices inside
   * `applyCoordinatorReport`, event returns). Writes the receipt and, for an inbox route, appends the id to
   * the conversation's Backlog. Throws Unavailable(retryAfter) when `inbox.items.length + backlog.ids.length
   * >= MAX_WAITING` and the trigger is new. Returns a copy of the saved receipt.
   */
  acceptIn: (_tx: Tx, _wire: unknown, _routeIn?: RouteIn): Promise<TriggerReceipt> => {
    throw new Error("not implemented");
  },
  /**
   * Hand every backlogged trigger of one conversation to Pi, in order. Single-flight per conversation
   * in process. Returns "waiting" when the publication gate holds (a refresh is pending and a run is
   * active); the caller reschedules through `wake` (1 s, as today's admission-wait).
   *
   * TODO (loop until the backlog is empty or the gate waits)
   *   ids = snapshot(Backlog, nativeId).ids; if none → "idle"
   *   scope = resolve(binding.address); if (await scope.gate()) === "waiting" → "waiting"
   *   for id of ids:
   *     receipt = read(id); require receipt.nativeId === nativeId && receipt.route.kind !== "local-answer"
   *     require receipt.digest === digest(receipt.trigger)        // storage integrity, as today
   *     await scope.native.submit({ type: "input", requestId: id, whenBusy: "followUp",
   *                                 content: inputText(receipt.trigger),
   *                                 entry: { kind: TRIGGER_ENTRY_KIND, data: triggerInputData(receipt.trigger) } })
   *       // known requestId → existing submission, no write: a crash between submit and the next commit
   *       // re-drives here without a second placement
   *     pi.commit(tx => remove id from Backlog)
   *   waitUntil(scope.native.waitForIdle())   // keeps the DO alive while the batched run executes
   * Bounded: at most MAX_WAITING submits per conversation per pass; each is idempotent.
   */
  drain: (_nativeId: ConversationId): Promise<"idle" | "waiting"> => {
    throw new Error("not implemented");
  },
  /** Restore path: `drain` for every bound conversation whose Backlog is non-empty. */
  drainAll: (): Promise<void> => {
    throw new Error("not implemented");
  },
  /**
   * Stop. Drops the conversation's Backlog in one commit; the caller then runs Pi's `abort()`, which
   * withdraws queued inputs and settles them `unanswered`. Receipts stay; `placement` reports `withdrawn`
   * for a trigger that never reached Pi. Idempotent.
   */
  withdraw: (_nativeId: ConversationId): Promise<void> => {
    throw new Error("not implemented");
  },
  /**
   * Web triggers waiting in the Backlog (only during a refresh window), for the chat snapshot.
   * Pi's own inbox is already projected by `chatPresentation` from `pi.inbox` entry data.
   */
  queuedWeb: (_nativeId: ConversationId): Promise<ChatQueuedInput[]> => {
    throw new Error("not implemented");
  },
  /** Derived from `pi.submissionByRequest(receipt.nativeId, receipt.trigger.id)` and the Backlog. */
  placement: (_receipt: TriggerReceipt): Promise<TriggerPlacement> => {
    throw new Error("not implemented");
  },
  read: (_id: string, _context: ExecutionContext): Promise<TriggerReceipt> => {
    throw new Error("not implemented");
  },
  list: (
    _address: EventAddress,
    _context: ExecutionContext,
    _cursor?: Cursor
  ): Promise<{ readonly items: TriggerReceipt[]; readonly next?: Cursor }> => {
    throw new Error("not implemented");
  },
  // Team routing entry points, kept with today's semantics. `returnIn` now ends with `placeIn` (Backlog
  // append) instead of `reserveDeliveryIn`, and the caller calls `drain`.
  returnEventIn: (_tx: Tx, _command: TeamEventCommand): Promise<void> => {
    throw new Error("not implemented");
  },
  receiveReturn: (_input: unknown, _context: ExecutionContext): Promise<unknown> => {
    throw new Error("not implemented");
  },
  listSubscribedBotSources: (_thread: SlackThread, _context: ExecutionContext): Promise<unknown> => {
    throw new Error("not implemented");
  },
});
export type Triggers = ReturnType<typeof createTriggers>;

// ───────────────────────────────────────────────────────────────────────────────────────────────
// §4 Replies — packages/runtime/src/replies.ts (replaces coordinator-replies.ts)
// ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * One reply per trigger, keyed by trigger id. `destination` is copied from the trigger's receipt and
 * is the only place a post can go. `text` is the final Slack text (toSlackText + concise), `key` the
 * channel delivery key (thread + session + trigger id). `delivery` is the channel's post state.
 */
export interface Reply extends JsonObject {
  triggerId: TriggerId;
  nativeId: ConversationId;
  destination: ReplyDestination;
  /** recorded conversation dependencies ∪ trigger.dependencies at enqueue time; re-checked at post time */
  dependencies: { sourceIds: string[]; toolIds: string[] };
  key: string;
  text: string;
  delivery: ReplyDelivery | null;
  taskId: TaskId | null;
  attempts: number;
  until: number;
}
/** Session family `cerebro.coordinator-reply` version 2; migrate from v1 drops `answerEntryId`, `source` → trigger receipt. */
export declare const Replies: unknown; // defineDocFamily<{ record: Reply | null }, null>

export const createReplies = (_options: {
  readonly pi: Harness;
  /** The destination registry for the conversation that owns the trigger. */
  readonly ports: (address: EventAddress) => Promise<ReplyPorts>;
  /** Post-time authorization: owner read access + content dependencies for the conversation. */
  readonly authorizeDelivery: (
    address: EventAddress,
    dependencies: ContentDependencies,
    signal?: AbortSignal
  ) => Promise<void>;
  readonly persist: () => Promise<void>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}) => ({
  /**
   * The outbox task `cerebro.coordinator-reply`, unchanged in substance: phases send/retry, exponential
   * backoff under `until`, rate-limit `retryAt`, Denied/NotFound → blocked(access-changed), the
   * channel's store keeps the uncertain-post rule. One change: `deliver` resolves
   * `ports(address)[record.destination.kind]` instead of `scope.deliverReply`.
   */
  definition: undefined as unknown, // defineTask<{ triggerId }, send|retry, { delivered: boolean }>
  /**
   * Enqueue a reply inside a commit. Used by the `reply_event` tool and by `localAnswer` (status/stop
   * answered without a model call). Idempotent by trigger id: an existing record with the same text
   * returns it; another text is a Conflict (one reply per trigger, today's one-event-one-answer rule).
   * `blocked` records a `blocked` delivery and creates no task.
   */
  enqueueIn: (
    _tx: Tx,
    _input: {
      readonly trigger: Trigger;
      readonly nativeId: ConversationId;
      readonly text: string;
      readonly dependencies: ContentDependencies;
      readonly blocked: boolean;
    }
  ): Promise<Reply> => {
    throw new Error("not implemented");
  },
  /** Track live outbox tasks so the DO stays alive; returns whether any are pending. */
  hold: (_nativeId?: ConversationId): Promise<boolean> => {
    throw new Error("not implemented");
  },
  read: (_triggerId: TriggerId): Promise<Reply | undefined> => {
    throw new Error("not implemented");
  },
});
export type ReplyOutbox = ReturnType<typeof createReplies>;

/**
 * The `reply_event` tool, one per conversation profile (it needs the profile's owner context and
 * dependency checks). Parameters `{ event_id: string, text: string }`. `replay: "safe"`.
 *
 * TODO execute(args, api, context)
 *   receipt = read(args.event_id); require receipt.nativeId === api.conversationId      // own triggers only
 *   require receipt.trigger.reply !== null → else return isError "This event has no external destination; the transcript is the reply."
 *   dependencies = contentDependencies() ∪ receipt.trigger.dependencies
 *   blocked = false; try { owner = ownerContext(); authorize(owner, "read"); checkDependencies(owner, dependencies);
 *                          ports()[reply.kind].authorize(reply) } catch Denied|NotFound { blocked = true }
 *   reply = api.commit(tx => { guardIn(tx); return replies.enqueueIn(tx, { trigger, nativeId, text: args.text, dependencies, blocked }) })
 *   replies.hold(api.conversationId)
 *   return blocked ? isError "Reply blocked: access changed." : output `Reply queued for ${event_id}.`
 * A Pi replay of the call re-enters `enqueueIn` with the same trigger id and text and finds the record.
 */
export const createReplyTool = (_profile: {
  readonly pi: Harness;
  readonly nativeId: ConversationId;
  readonly triggers: Pick<Triggers, "read">;
  readonly replies: Pick<ReplyOutbox, "enqueueIn" | "hold">;
  readonly ports: () => ReplyPorts;
  readonly ownerContext: () => Promise<ExecutionContext>;
  readonly authorize: (context: ExecutionContext, operation: "read") => Promise<void>;
  readonly checkDependencies: (context: ExecutionContext, dependencies: ContentDependencies) => Promise<void>;
  readonly contentDependencies: () => Promise<ContentDependencies>;
  readonly guardIn: (tx: Tx) => Promise<void>;
}): ToolRegistration => {
  throw new Error("not implemented");
};

/**
 * What makes sure a Slack-origin trigger gets a reply when the model forgets: one nudge per run.
 *
 * TODO hook(GenerationTask, { onYield(answer, api, context) })
 *   if api.conversationId !== nativeId → return
 *   if await api.memo("cerebro-reply-nudged", context) → return          // at most one continue per run
 *   live = api.snapshot(LiveDoc, nativeId); inputs = live.run?.inputs ?? []
 *   unreplied = for each submission in inputs (pi.submission(id).status → requestId):
 *                 receipt = snapshot(Receipts, requestId); keep when receipt.trigger.reply && !snapshot(Replies, requestId).record
 *   if none → return
 *   await api.memo("cerebro-reply-nudged", true, context)
 *   return { continue: `You have not replied to ${ids.join(", ")}. Call reply_event for each with the
 *                       answer for that person, or state that no reply is needed.` }
 * The continue is a `pi.user` entry; it shows in the web transcript (accepted, see rationale).
 */
export const createReplyHooks = (_options: {
  readonly pi: Harness;
  readonly nativeId: ConversationId;
}): HookRegistration[] => {
  throw new Error("not implemented");
};

// ───────────────────────────────────────────────────────────────────────────────────────────────
// §5 Instruction cause in a batched run — packages/runtime/src/instruction-cause.ts
// ───────────────────────────────────────────────────────────────────────────────────────────────

export interface InstructionCandidate {
  readonly operationId: string; // = requestId = trigger id
  readonly key: string;
  readonly submissionId: string;
}
export interface InstructionCause extends InstructionCandidate {
  readonly kind: "human" | "routine";
  readonly eventId: TriggerId;
}
/** Unchanged: the current run's input submissions with a requestId, from `pi.live.run.inputs`. */
export const currentInstructionCandidates = (
  _pi: Harness,
  _nativeId: ConversationId
): Promise<InstructionCandidate[]> => {
  throw new Error("not implemented");
};
/**
 * A batched run mixes human, routine, and internal triggers. The cause is the last human trigger of the
 * current run, else the last routine one; internal triggers never qualify. The claim checks of today
 * (agentVersion, policyVersion, submission id on the receipt) are gone: the gate makes the profile a
 * property of placement, and the entry's `data.id`/`data.actor` are verified against the receipt.
 *
 * TODO
 *   live = tx.doc(LiveDoc, nativeId); inputs = new Set(live.run?.inputs)
 *   for each candidate: submission = tx.submissionByRequest(nativeId, candidate.operationId)
 *     require input, id === candidate.submissionId, in `inputs`, status placed|done
 *     entry = tx.entry(submission.entry); require entry.kind === TRIGGER_ENTRY_KIND && data.id === candidate.operationId
 *     receipt = tx.doc(Receipts, candidate.operationId); require receipt.nativeId === nativeId,
 *       receipt.digest intact, trigger.ownerPrincipalId/address match, receipt.trigger.actor === data.actor
 *     actor human → {kind: "human"}; routine → {kind: "routine"}; internal → skip
 *   return lastHuman ?? lastRoutine ?? throw Denied("A new instruction requires a current human request or authorized routine.")
 */
export const requireInstructionCauseIn = (
  _tx: Tx,
  _options: {
    readonly address: EventAddress;
    readonly ownerPrincipalId: PrincipalId;
    readonly nativeId: ConversationId;
    readonly candidates: readonly InstructionCandidate[];
  }
): Promise<InstructionCause> => {
  throw new Error("not implemented");
};

// ───────────────────────────────────────────────────────────────────────────────────────────────
// §6 Call-site changes (signatures only)
// ───────────────────────────────────────────────────────────────────────────────────────────────

// session-agent.ts
//   Harness.open settings: { followUpMode: "all" }  (steeringMode stays default; nothing steers)
//   NativeHost: { triggers: Triggers; replies: ReplyOutbox }   registry.install({ tasks: [replies.definition] })
//   SessionHostConfiguration.eventReplies → replyPorts?: ReplyPorts
//   harness open, after scopes restore: await triggers.drainAll(); await replies.hold()
//   onJob "cerebro-coordination": waiting = await triggers.drain(binding.nativeId) === "waiting";
//                                 pendingReplies = await replies.hold(binding.nativeId);
//                                 reschedule min(outcome, now + 1000) when waiting || pendingReplies
//   onRequest "/owned-event": triggers.admit(resolved.admission, context) → { eventId }

// conversation-scope.ts
//   eventScope() → triggerScope(): Promise<TriggerScope>  built from the current profile:
//     gate: () => this.advance()
//     commit: (key, change) => coordination.admissions.commit(key, change)
//     localAnswer: profile.web.localAnswer
//   "/stop": await Promise.all([triggers.withdraw(native.id), harness.abort({ session })])
//   snapshot: queuedInputs = chatPresentation(view).queuedInputs ++ triggers.queuedWeb(native.id)
//   advance(): Promise<"open" | "waiting">   (no eventId, no releaseEvent)
//     TODO if !publication.primary → "open"
//          binding = read; if !binding.refresh: latest = resolve("latest"); same → "open"; else set refresh (commit)
//          candidate = prepareTarget(refresh)
//          activated = commit(tx): refresh unchanged && !nativeOperations.pending() && !approvals.hasPending()
//                      && no live admission lease && nativeDrainIn(tx)   // no run, empty pi.inbox, no live non-outbox task
//                      → configure(tx, native.id, candidate.registration.agent); binding.agentVersion = target; refresh = null
//          !activated → "waiting"; else reconcile + prune profiles → "open"
//   Invariant: a trigger is handed to Pi only by `drain`, and `drain` runs only after `gate() === "open"`,
//   so no input is placed under a stale definition and nothing queued in Pi predates a pending refresh.

// conversation-bindings.ts
//   ConversationBinding: { address, nativeId, agentVersion, refresh: { agentVersion } | null }   (releaseEvent, policyVersion, legacyVersion deleted)

// conversation-drain.ts
//   nativeDrainIn(tx, root): live tasks other than "cerebro.coordinator-reply" → false; pi.inbox non-empty or live.run → false
//   oldestHeldEventIn: deleted

// conversation-profile.ts
//   tools: [..., createReplyTool({...})]   hooks: [...work.hooks, ...createRunLimits(), ...createReplyHooks({ pi, nativeId })]

// coordinator-web.ts (the web adapter)
export const createWebAdapter = (_options: {
  readonly triggers: Pick<Triggers, "admit" | "read">;
  readonly replies: Pick<ReplyOutbox, "enqueueIn">;
  readonly address: EventAddress;
  readonly ownerContext: () => Promise<ExecutionContext>;
}) => ({
  /**
   * TODO send(operationId, text, context)
   *   origin = { kind: "web", operationId }; trigger = { version 2, id: triggerId(address, origin), address, owner,
   *             origin, actor: "human", text, reference: null, reply: null, dependencies: [] }
   *   receipt = triggers.admit({ trigger, routing: text ∈ {status, stop} ? local-control : automatic }, context)
   *   return { accepted: local || receipt.duplicates === 0, operationId, session }
   * Replay by operation id is the receipt's idempotency: same id, same digest, same receipt. The legacy
   * native-submission replay branch is gone with the legacy input path.
   */
  send: (_operationId: string, _text: string, _context: ExecutionContext, _signal?: AbortSignal): Promise<unknown> => {
    throw new Error("not implemented");
  },
  /** Today's prepareLocalControl; ends with `replies.enqueueIn` when `trigger.reply` (local text, blocked by the same pre-check as the tool). */
  localAnswer: (_trigger: Trigger, _action: "status" | "stop", _context: ExecutionContext): Promise<RouteIn> => {
    throw new Error("not implemented");
  },
});

// saved-timer-submit.ts (the timer adapter)
//   ReminderOrigins.record: { creatingEventId: TriggerId | null; reply: ReplyDestination | null }
//     saveReminderOriginIn copies `reply` from the cause trigger's receipt at schedule time (slack-event lookup deleted).
//   submitSavedTimer(options): builds Trigger { origin: { kind: "timer", scheduleId, occurrenceId }, actor: "routine",
//     reply: origin.record.reply, dependencies: contentDependencies() } after ports()[reply.kind].authorize(reply),
//     then triggers.admit(trigger, owner). TimerOccurrences doc deleted (the receipt holds the trigger).

// coordinator-event-content.ts + coordinator-report.ts (the Team adapter)
/**
 * Build an internal trigger inside the report commit. The reply destination is the originating human
 * trigger's: `record.humanOperationId` is a trigger id, so `tx.doc(Receipts, it).trigger.reply` — owner
 * and address re-checked — becomes `reply`; null when the cause was web or routine without a destination.
 * Then `triggers.acceptIn(tx, trigger)`; the caller runs `triggers.drain` after the commit.
 */
export const teamTriggerIn = (
  _tx: Tx,
  _record: { humanOperationId: string | null },
  _origin: Extract<TriggerOrigin, { kind: "teamreport" | "teamnotice" }>,
  _text: string,
  _dependencies: ContentDependencies
): Promise<Trigger> => {
  throw new Error("not implemented");
};

// apps/server/src/session/agent.ts (the Slack adapter; the only place that reads Slack decision receipts)
//   "/slack-event": decision = readSlackPrimaryEvent(...); trigger = { origin: { kind: "slack", eventId, thread },
//     actor: "human", text: decision.text, reply: { kind: "slack", authority: decision.authority, ownerPrincipalId, source: address },
//     ... }; routing by exact status/stop → owned-event admission.
//   createSlackEventReplies → createSlackReplyPort(env, slack, primary, access): ReplyPort<"slack">  ( `destination()` deleted )
//   SessionHostConfiguration.replyPorts = { slack: createSlackReplyPort(...) }

// pi-harness.ts
//   queuedInputs / presentedEntry: entry.kind === TRIGGER_ENTRY_KIND && data.channel === "web" → operationId: data.operationId

// inspection-events.ts (Inspector reads receipts + placement + reply)
export interface InspectionEvent {
  readonly id: string;
  readonly channel: TriggerOrigin["kind"];
  readonly actor: TriggerActor;
  readonly route: TriggerReceipt["route"]["kind"];
  readonly duplicates: number;
  readonly placement: TriggerPlacement["kind"];
  readonly answerEntryId: string | null;
  readonly workIds: readonly string[];
  readonly returns: readonly { readonly workId: string; readonly decision: string }[];
  readonly reply: {
    readonly state: ReplyDelivery["state"] | "pending";
    readonly attempts: number;
    readonly deadlineAt: number;
    readonly retryAt: number | null;
    readonly timestamp: string | null;
  } | null;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// §7 Deleted
// ───────────────────────────────────────────────────────────────────────────────────────────────
//
// Tasks and documents
//   cerebro.bot-event-delivery task (phases deliver / admission-wait / settle / retry) and its abort handler
//   BotEventQueue (identity-wide pending map, 96/64 caps), BotEventSequence
//   BotEventAdmission (held / claimed / submitted / settled done|unanswered|blocked), CoordinatorEventDelivery
//   TimerOccurrences (destination + replyOrigin now live in the trigger receipt)
//   ConversationBinding.releaseEvent, policyVersion, legacyVersion
//
// Functions
//   reserveDeliveryIn, withdraw (submission abort by claim), settledAdmission, finishIn, deliveryOf
//   eventHasPredecessorIn, abortPendingEvents, pendingWebInputs, webPendingInput, oldestHeldEventIn
//   authorizeEventDelivery, BotEventScope.prepareAdmission / claimIn / prepareSettlement / deliverReply /
//     agentVersion / policyVersion, advancePublication(eventId)
//   CoordinatorReplies.origin(event), ReplyOrigin, ReplyAnswer, Reply.answerEntryId, EventReplyServices.destination
//   resolveFixedReplyOrigin, timerReplyDestination, FixedReplyOrigin."slack-event" / "legacy-slack-timer"
//   events.restore / wake / hold (→ drain), holdReplies plumbing in createCoordinatorEvents
//   coordinator-web.send's native-submission replay branch; sendLegacyInput; source-admission (parallel unit)
//   instruction-cause claim checks (agentVersion / policyVersion / submissionId on the receipt)
//
// Contracts
//   BotEventSchema v1 → Trigger v2 (replyTo → reply: ReplyDestination | null; + actor); RoutedEventAdmission v2 → TriggerAdmission v3
//   SlackReplyDestination union (legacy member) → ReplyDestination; InspectionEvent.admission / outcome → placement / answerEntryId
//
// Settings
//   followUpMode "one-at-a-time" → "all"
