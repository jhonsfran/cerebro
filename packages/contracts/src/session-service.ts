/* oxlint-disable no-redeclare -- Schemas define their corresponding TypeScript types. */
import { Schema } from "effect";

import type { EventAddress } from "./events.ts";
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
  id: Schema.NonEmptyString,
  role: Schema.Literals(["user", "assistant", "tool"]),
  state: Schema.Literals(["complete", "streaming"]),
  text: Schema.String,
  thinking: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
});
export type ChatMessage = typeof ChatMessage.Type;

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

export const ChatSnapshot = Schema.Struct({
  address,
  agentVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  approvals: Schema.Array(ChatApproval),
  busy: Schema.Boolean,
  messages: Schema.Array(ChatMessage),
});
export type ChatSnapshot = typeof ChatSnapshot.Type;

export const ChatReceipt = Schema.Struct({
  accepted: Schema.Boolean,
  operationId: Schema.NonEmptyString,
  session: Schema.NonEmptyString,
});
export type ChatReceipt = typeof ChatReceipt.Type;

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
