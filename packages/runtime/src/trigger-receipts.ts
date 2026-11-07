import { TriggerSchema } from "@cerebro/contracts/triggers";
import type { Trigger } from "@cerebro/contracts/triggers";
import { WorkKeySchema, WorkStatusSchema } from "@cerebro/contracts/work";
import type { WorkKey, WorkStatus } from "@cerebro/contracts/work";
import { defineDoc, defineDocFamily } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  EntryId,
  JsonObject,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";

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
export type TriggerRoute =
  | { kind: "inbox"; skipped: EventSkip[] }
  | {
      kind: "local-answer";
      action: "status" | "stop";
      answerEntry: EntryId;
    }
  | { kind: "teams"; recipients: EventRecipient[]; skipped: EventSkip[] }
  | { kind: "control"; workId: string; status: WorkStatus };
export interface TriggerReceipt extends JsonObject {
  trigger: Trigger;
  digest: string;
  nativeId: ConversationId;
  duplicates: number;
  route: TriggerRoute;
}

const nativeId = <A extends number>() =>
  Schema.declare<A>(
    (value): value is A =>
      typeof value === "number" && Number.isSafeInteger(value) && value > 0
  );
const skipped = Schema.mutable(
  Schema.Array(
    Schema.Struct({
      workId: Schema.String,
      reason: Schema.Literals(["missing", "denied", "terminal", "full"]),
    })
  ).check(Schema.isMaxLength(8))
);
export const TriggerReceiptSchema = Schema.Struct({
  trigger: TriggerSchema,
  digest: Schema.String,
  nativeId: nativeId<ConversationId>(),
  duplicates: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 })),
  route: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("inbox"), skipped }),
    Schema.Struct({
      kind: Schema.Literal("local-answer"),
      action: Schema.Literals(["status", "stop"]),
      answerEntry: nativeId<EntryId>(),
    }),
    Schema.Struct({
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
    Schema.Struct({
      kind: Schema.Literal("control"),
      workId: Schema.String,
      status: WorkStatusSchema,
    }),
  ]),
}) satisfies Schema.Codec<TriggerReceipt>;
export const copyTriggerReceipt = (receipt: TriggerReceipt): TriggerReceipt =>
  Schema.decodeUnknownSync(Schema.fromJsonString(TriggerReceiptSchema), {
    onExcessProperty: "error",
  })(JSON.stringify(receipt));
export const Receipts = defineDocFamily({
  kind: "cerebro.bot-event",
  scope: "session",
  family: true,
  version: 4,
  migrate: (): { receipt: TriggerReceipt | null } => {
    throw new Error("Unsupported trigger receipt version.");
  },
  initial: (_seed: null): { receipt: TriggerReceipt | null } => ({
    receipt: null,
  }),
});
export const Backlog = defineDoc({
  kind: "cerebro.trigger-backlog",
  scope: "conversation",
  history: "latest",
  fork: "initial",
  version: 1,
  initial: (): { ids: string[] } => ({ ids: [] }),
});
