import { Schema } from "effect";

import { BotEventSchema } from "./bot-events.ts";
import { WorkIdSchema } from "./work.ts";

export const EventRoutingSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("automatic") }),
  Schema.Struct({
    kind: Schema.Literal("control"),
    workId: WorkIdSchema,
    action: Schema.Literals(["update", "cancel"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("local-control"),
    action: Schema.Literals(["status", "stop"]),
  }),
]);
export const RoutedEventAdmissionSchema = Schema.Struct({
  version: Schema.Literal(2),
  kind: Schema.Literal("event-admission"),
  event: BotEventSchema,
  routing: EventRoutingSchema,
}).check(
  Schema.makeFilter(
    ({ event, routing }) =>
      (event.source.kind === "web" ||
        event.source.kind === "slack" ||
        event.source.kind === "savedtimer") &&
      (routing.kind !== "local-control" ||
        event.content.text === routing.action)
  )
);
export const EventAdmissionSchema = Schema.Union([
  BotEventSchema,
  RoutedEventAdmissionSchema,
]);
export type EventAdmission = typeof EventAdmissionSchema.Type;
export type RoutedEventAdmission = typeof RoutedEventAdmissionSchema.Type;
export type EventRouting = typeof EventRoutingSchema.Type;

export const normalizeEventAdmission = (input: unknown) => {
  const wire = Schema.decodeUnknownSync(EventAdmissionSchema, {
    onExcessProperty: "error",
  })(input);
  return "event" in wire
    ? { wire, event: wire.event, routing: wire.routing }
    : { wire, event: wire, routing: { kind: "direct" as const } };
};
