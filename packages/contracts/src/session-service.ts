/* oxlint-disable no-redeclare -- Schemas define their corresponding TypeScript types. */
import { Schema } from "effect";

import type { EventAddress } from "./events.ts";
import { UiPresentationFromUnknown } from "./generative-ui.ts";
import type { ExecutionContext } from "./identity.ts";
import { canonicalToolArguments } from "./tools.ts";

const identifier = <Name extends string>() =>
  Schema.declare<string & { readonly __brand: Name }>(
    (value): value is string & { readonly __brand: Name } =>
      typeof value === "string" && value.length > 0 && value.trim() === value
  );
const address = Schema.Struct({
  agentId: identifier<"AgentId">(),
  conversationId: identifier<"ConversationId">(),
  organizationId: identifier<"OrganizationId">(),
  sessionId: identifier<"SessionId">(),
});
const jsonValue = Schema.Unknown.check(
  Schema.makeFilter((value) => {
    try {
      canonicalToolArguments(value);
      return true;
    } catch {
      return false;
    }
  })
);

export const ChatMessage = Schema.Struct({
  entryId: Schema.optional(Schema.NonEmptyString),
  kind: Schema.optional(Schema.Literal("summary")),
  id: Schema.NonEmptyString,
  outcome: Schema.optional(
    Schema.Literals(["answered", "tool-call", "failed", "interrupted"])
  ),
  role: Schema.Literals(["user", "assistant", "tool"]),
  state: Schema.Literals(["complete", "streaming"]),
  text: Schema.String,
  thinking: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
});
export type ChatMessage = typeof ChatMessage.Type;

export const ChatQueuedInput = Schema.Struct({
  mode: Schema.Literals(["steer", "followUp"]),
  submissionId: Schema.NonEmptyString,
  text: Schema.String,
});
export type ChatQueuedInput = typeof ChatQueuedInput.Type;

export const ChatToolExecution = Schema.Struct({
  arguments: jsonValue,
  callId: Schema.NonEmptyString,
  id: Schema.NonEmptyString,
  messageId: Schema.NonEmptyString,
  output: Schema.String,
  presentation: Schema.optional(UiPresentationFromUnknown),
  resultMessageId: Schema.optional(Schema.NonEmptyString),
  state: Schema.Literals([
    "pending",
    "running",
    "succeeded",
    "failed",
    "interrupted",
  ]),
  toolName: Schema.NonEmptyString,
});
export type ChatToolExecution = typeof ChatToolExecution.Type;

export const ChatApproval = Schema.Struct({
  approvalId: Schema.NonEmptyString,
  arguments: jsonValue,
  callId: Schema.NonEmptyString,
  expiresAt: Schema.Number.check(Schema.isFinite()),
  operationId: Schema.NonEmptyString,
  state: Schema.Literals([
    "pending",
    "allowed",
    "denied",
    "expired",
    "cancelled",
  ]),
  taskId: Schema.NonEmptyString,
  toolId: Schema.NonEmptyString,
});
export type ChatApproval = typeof ChatApproval.Type;

export const ChatDecisionReceipt = Schema.Struct({
  approvalId: ChatApproval.fields.approvalId,
  state: ChatApproval.fields.state,
});
export type ChatDecisionReceipt = typeof ChatDecisionReceipt.Type;

export const ChatRecurrence = Schema.Struct({
  interval: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })),
  timezone: Schema.NonEmptyString,
  unit: Schema.Literals(["minute", "hour", "day", "week", "month"]),
});
export type ChatRecurrence = typeof ChatRecurrence.Type;

export const ChatReminder = Schema.Struct({
  id: Schema.NonEmptyString,
  instruction: Schema.NonEmptyString,
  lastDeliveredAt: Schema.optional(Schema.Number),
  recurrence: Schema.optional(ChatRecurrence),
  runAt: Schema.Number,
  state: Schema.Literals(["scheduled", "completed", "cancelled", "revoked"]),
});
export type ChatReminder = typeof ChatReminder.Type;

export const ChatChild = Schema.Struct({
  callId: Schema.NonEmptyString,
  id: Schema.NonEmptyString,
  messages: Schema.Array(ChatMessage),
  ownerTaskId: Schema.NonEmptyString,
  purpose: Schema.Literals(["delegate", "history"]),
  state: Schema.Literals(["running", "succeeded", "failed", "interrupted"]),
  title: Schema.String,
  tools: Schema.Array(ChatToolExecution),
});
export type ChatChild = typeof ChatChild.Type;

export const ChatActivity = Schema.Struct({
  children: Schema.Array(ChatChild),
  compactionFailure: Schema.optional(Schema.String),
  compactions: Schema.Array(
    Schema.Struct({
      attempt: Schema.Number,
      blocking: Schema.Boolean,
      id: Schema.NonEmptyString,
      reason: Schema.Literals(["manual", "threshold", "overflow"]),
      retryAt: Schema.optional(Schema.Number),
    })
  ),
  origin: Schema.optional(
    Schema.Struct({
      conversationId: Schema.NonEmptyString,
      entryId: Schema.NonEmptyString,
    })
  ),
  reminders: Schema.Array(ChatReminder),
  tasks: Schema.Array(
    Schema.Struct({
      background: Schema.Boolean,
      conversationId: Schema.NonEmptyString,
      id: Schema.NonEmptyString,
      kind: Schema.NonEmptyString,
      ownerTaskId: Schema.optional(Schema.NonEmptyString),
      state: Schema.Literals(["pending", "running", "waiting", "completing"]),
    })
  ),
});
export type ChatActivity = typeof ChatActivity.Type;

export const ChatControl = Schema.Union([
  Schema.Struct({
    instructions: Schema.optional(Schema.String),
    kind: Schema.Literal("compact"),
    operationId: Schema.NonEmptyString,
  }),
  Schema.Struct({
    childId: Schema.NonEmptyString,
    kind: Schema.Literal("stop-child"),
  }),
  Schema.Struct({
    instruction: Schema.NonEmptyString,
    kind: Schema.Literal("schedule"),
    operationId: Schema.NonEmptyString,
    recurrence: Schema.optional(ChatRecurrence),
    runAt: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("cancel-schedule"),
    scheduleId: Schema.NonEmptyString,
  }),
]);
export type ChatControl = typeof ChatControl.Type;
export const ChatControlReceipt = Schema.Struct({
  id: Schema.NonEmptyString,
  kind: Schema.Literals([
    "compact",
    "stop-child",
    "schedule",
    "cancel-schedule",
  ]),
});
export type ChatControlReceipt = typeof ChatControlReceipt.Type;

export const ConversationForkOrigin = Schema.Struct({
  agentVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  entryId: Schema.NonEmptyString,
  parentConversationId: Schema.NonEmptyString,
  parentSessionId: Schema.NonEmptyString,
});
export type ConversationForkOrigin = typeof ConversationForkOrigin.Type;

export const ChatSnapshot = Schema.Struct({
  activity: Schema.optional(ChatActivity),
  address,
  agentVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  approvals: Schema.Array(ChatApproval),
  busy: Schema.Boolean,
  messages: Schema.Array(ChatMessage),
  queuedInputs: Schema.Array(ChatQueuedInput),
  tools: Schema.Array(ChatToolExecution),
});
export type ChatSnapshot = typeof ChatSnapshot.Type;

export const ChatReceipt = Schema.Struct({
  accepted: Schema.Boolean,
  operationId: Schema.NonEmptyString,
  session: Schema.NonEmptyString,
});
export type ChatReceipt = typeof ChatReceipt.Type;
export const ChatForkReceipt = Schema.Struct({ address });

export const ChatObservation = Schema.Union([
  Schema.Struct({ snapshot: ChatSnapshot, type: Schema.Literal("snapshot") }),
  Schema.Struct({
    reason: Schema.Literals(["revoked", "unauthorized"]),
    type: Schema.Literal("access-denied"),
  }),
]);
export type ChatObservation = typeof ChatObservation.Type;

export interface ChatRequest {
  readonly address: EventAddress;
  readonly context: ExecutionContext;
  readonly signal?: AbortSignal;
}
export interface ChatSendRequest extends ChatRequest {
  readonly operationId: string;
  readonly text: string;
}
export interface ChatDecisionRequest extends ChatRequest {
  readonly approvalId: string;
  readonly decision: "allow" | "deny";
}
export interface ChatClient {
  readonly control: (
    request: ChatRequest & { readonly command: ChatControl }
  ) => Promise<ChatControlReceipt>;
  readonly fork: (
    request: ChatRequest & {
      readonly destination: EventAddress;
      readonly entryId: string;
      readonly operationId: string;
    }
  ) => Promise<{ readonly address: EventAddress }>;
  readonly send: (request: ChatSendRequest) => Promise<ChatReceipt>;
  readonly stop: (
    request: ChatRequest
  ) => Promise<{ readonly stopped: boolean }>;
  readonly read: (request: ChatRequest) => Promise<ChatSnapshot>;
  readonly decide: (
    request: ChatDecisionRequest
  ) => Promise<ChatDecisionReceipt>;
  readonly observe: (request: ChatRequest) => Promise<Response>;
}
