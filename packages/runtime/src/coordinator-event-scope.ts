import type { BotEvent } from "@cerebro/contracts/bot-events";
import type { EventAdmission } from "@cerebro/contracts/bot-routing";
import type { EventAddress } from "@cerebro/contracts/events";
import type {
  ExecutionContext,
  PrincipalId,
} from "@cerebro/contracts/identity";
import type { ContentDependencies } from "@cerebro/contracts/session";
import type { SlackDeliveryStore } from "@cerebro/contracts/slack-events";
import type {
  Conversation,
  ConversationId,
  SettledSubmissionRecord,
  Tx,
} from "@earendil-works/pi-durable";

import type { createCoordinatorAdmissions } from "./coordinator-admission.ts";
import type { BotEventReceipt, EventSkip } from "./coordinator-event-state.ts";
import type { CoordinatorReply } from "./coordinator-replies.ts";

export interface BotEventScope {
  readonly deliverReply?: (
    record: CoordinatorReply,
    store: SlackDeliveryStore,
    signal?: AbortSignal
  ) => Promise<void>;
  readonly native: Conversation;
  readonly requireCurrent?: () => void;
  readonly agentVersion: number;
  readonly policyVersion?: 0 | 1;
  readonly ownerPrincipalId: PrincipalId;
  readonly prepareAdmission?: (eventId: string) => Promise<boolean>;
  readonly claimIn?: (tx: Tx, eventId: string) => Promise<boolean>;
  readonly admissions: ReturnType<typeof createCoordinatorAdmissions>;
  readonly readAccess: (context: ExecutionContext) => Promise<void>;
  readonly prepareRoute?: (
    input: EventAdmission,
    context: ExecutionContext
  ) => Promise<EventRouteIn>;
  readonly prepareLocalControl?: (
    event: BotEvent,
    action: "status" | "stop",
    context: ExecutionContext
  ) => Promise<EventRouteIn>;
  readonly prepareSettlement?: (
    receipt: BotEventReceipt,
    result: SettledSubmissionRecord,
    signal?: AbortSignal
  ) => Promise<(tx: Tx) => Promise<void>>;
  readonly routingAccess?: (
    context: ExecutionContext,
    dependencies: ContentDependencies
  ) => Promise<void>;
  readonly authorize: (
    event: BotEvent,
    context?: ExecutionContext,
    signal?: AbortSignal,
    action?: "admit" | "deliver" | "read" | "control"
  ) => Promise<void>;
}
export type EventRouteIn = (
  tx: Tx
) => Promise<
  | { kind: "coordinator"; skipped?: EventSkip[] }
  | Extract<
      BotEventReceipt["route"],
      { kind: "teams" | "control" | "local-answer" }
    >
>;
export type EventTargetIn = (
  tx: Tx,
  address: EventAddress
) => Promise<{
  readonly nativeId: ConversationId;
  readonly agentVersion: number;
  readonly policyVersion?: 0 | 1;
}>;
