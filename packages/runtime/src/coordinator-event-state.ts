import {
  EventAdmissionSchema,
  normalizeEventAdmission,
} from "@cerebro/contracts/bot-routing";
import type { EventAdmission } from "@cerebro/contracts/bot-routing";
import { WorkKeySchema, WorkStatusSchema } from "@cerebro/contracts/work";
import type { WorkKey, WorkStatus } from "@cerebro/contracts/work";
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  EntryId,
  JsonObject,
  SubmissionId,
  TaskId,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";

type Claim = JsonObject & {
  agentVersion: number;
  requestId: string;
};
export type BotEventAdmission =
  | { kind: "held" }
  | ({ kind: "claimed" } & Claim)
  | ({ kind: "submitted"; submissionId: SubmissionId } & Claim)
  | ({
      kind: "settled";
      outcome: "done";
      submissionId: SubmissionId;
      entry: EntryId;
      answer: EntryId;
    } & Claim)
  | ({
      kind: "settled";
      outcome: "unanswered";
      reason: string;
      submissionId: SubmissionId;
      entry: EntryId | null;
    } & Claim)
  | { kind: "settled"; outcome: "blocked"; reason: string };
export interface CoordinatorEventDelivery extends JsonObject {
  kind: "coordinator";
  taskId: TaskId;
  admission: BotEventAdmission;
}
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
interface EventReceiptFields extends JsonObject {
  input: EventAdmission;
  digest: string;
  nativeId: ConversationId;
  sequence: number;
  duplicates: number;
}
export type BotEventReceipt = EventReceiptFields &
  (
    | {
        route: { kind: "coordinator"; skipped: EventSkip[] };
        delivery: CoordinatorEventDelivery;
      }
    | {
        route: {
          kind: "teams";
          recipients: EventRecipient[];
          skipped: EventSkip[];
        };
        delivery: { kind: "none" } | CoordinatorEventDelivery;
      }
    | {
        route: { kind: "control"; workId: string; status: WorkStatus };
        delivery: { kind: "none" };
      }
    | {
        route: {
          kind: "local-answer";
          action: "status" | "stop";
          answerEntryId: EntryId;
        };
        delivery: { kind: "none" };
      }
  );

const nativeId = <A extends number>() =>
  Schema.declare<A>(
    (value): value is A =>
      typeof value === "number" && Number.isSafeInteger(value) && value > 0
  );
const claim = {
  agentVersion: Schema.Int.check(Schema.isGreaterThan(0)),
  requestId: Schema.String,
};
const admissionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("held") }),
  Schema.Struct({ ...claim, kind: Schema.Literal("claimed") }),
  Schema.Struct({
    ...claim,
    kind: Schema.Literal("submitted"),
    submissionId: nativeId<SubmissionId>(),
  }),
  Schema.Struct({
    ...claim,
    kind: Schema.Literal("settled"),
    outcome: Schema.Literal("done"),
    submissionId: nativeId<SubmissionId>(),
    entry: nativeId<EntryId>(),
    answer: nativeId<EntryId>(),
  }),
  Schema.Struct({
    ...claim,
    kind: Schema.Literal("settled"),
    outcome: Schema.Literal("unanswered"),
    reason: Schema.String,
    submissionId: nativeId<SubmissionId>(),
    entry: Schema.NullOr(nativeId<EntryId>()),
  }),
  Schema.Struct({
    kind: Schema.Literal("settled"),
    outcome: Schema.Literal("blocked"),
    reason: Schema.String,
  }),
]);
const receiptFields = {
  input: EventAdmissionSchema,
  digest: Schema.String,
  nativeId: nativeId<ConversationId>(),
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  duplicates: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 })),
};
const skipped = Schema.mutable(
  Schema.Array(
    Schema.Struct({
      workId: Schema.String,
      reason: Schema.Literals(["missing", "denied", "terminal", "full"]),
    })
  ).check(Schema.isMaxLength(8))
);
const coordinatorDelivery = Schema.Struct({
  kind: Schema.Literal("coordinator"),
  taskId: nativeId<TaskId>(),
  admission: admissionSchema,
});
const noDelivery = Schema.Struct({ kind: Schema.Literal("none") });
export const BotEventReceiptSchema = Schema.Union([
  Schema.Struct({
    ...receiptFields,
    route: Schema.Struct({ kind: Schema.Literal("coordinator"), skipped }),
    delivery: coordinatorDelivery,
  }),
  Schema.Struct({
    ...receiptFields,
    route: Schema.Struct({
      kind: Schema.Literal("teams"),
      recipients: Schema.mutable(
        Schema.Array(
          Schema.Struct({
            key: WorkKeySchema,
            admissionDigest: Schema.String,
            commandId: Schema.String,
            disposition: Schema.Union([
              Schema.Struct({ kind: Schema.Literal("admitted") }),
              Schema.Struct({
                kind: Schema.Literal("returned"),
                digest: Schema.String,
              }),
              Schema.Struct({
                kind: Schema.Literal("not-delivered"),
                reason: Schema.Literals(["cancelled", "expired"]),
              }),
            ]),
          })
        ).check(Schema.isMinLength(1), Schema.isMaxLength(8))
      ),
      skipped,
    }),
    delivery: Schema.Union([noDelivery, coordinatorDelivery]),
  }),
  Schema.Struct({
    ...receiptFields,
    route: Schema.Struct({
      kind: Schema.Literal("control"),
      workId: Schema.String,
      status: WorkStatusSchema,
    }),
    delivery: noDelivery,
  }),
  Schema.Struct({
    ...receiptFields,
    route: Schema.Struct({
      kind: Schema.Literal("local-answer"),
      action: Schema.Literals(["status", "stop"]),
      answerEntryId: nativeId<EntryId>(),
    }),
    delivery: noDelivery,
  }),
]) satisfies Schema.Codec<BotEventReceipt>;
export const copyEventReceipt = (receipt: BotEventReceipt): BotEventReceipt =>
  Schema.decodeUnknownSync(Schema.fromJsonString(BotEventReceiptSchema), {
    onExcessProperty: "error",
  })(JSON.stringify(receipt));
export const BotEventReceipts = defineDocFamily({
  kind: "cerebro.bot-event",
  scope: "session",
  family: true,
  version: 3,
  migrate: (): { receipt: BotEventReceipt | null } => {
    throw new Error("Unsupported coordinator event version.");
  },
  initial: (_seed: null): { receipt: BotEventReceipt | null } => ({
    receipt: null,
  }),
});
export const BotEventSequence = defineDoc({
  kind: "cerebro.bot-event-sequence",
  scope: "conversation",
  history: "latest",
  fork: "initial",
  version: 1,
  initial: (): { next: number } => ({ next: 0 }),
});
export const eventOf = (receipt: BotEventReceipt) =>
  normalizeEventAdmission(receipt.input).event;

export const BotEventQueue = defineDoc({
  kind: "cerebro.bot-event-queue",
  scope: "session",
  version: 1,
  initial: (): {
    pending: Record<
      string,
      { nativeId: ConversationId; taskId: TaskId; internal: boolean }
    >;
  } => ({ pending: {} }),
});
