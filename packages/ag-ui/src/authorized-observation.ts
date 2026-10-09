import type { EventAddress } from "@cerebro/contracts/events";
import { Unavailable } from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import type { Observation } from "@cerebro/contracts/session-service";
import { Context, Effect, Layer, Stream } from "effect";
import type { Scope } from "effect";

import {
  observationEvent,
  observationIdentity,
  observationResponse,
  protocolResponse,
  sameAddress,
} from "./protocol.ts";
import type { ProtocolBatch } from "./protocol.ts";

interface ObservationAttachment<Value = Observation> {
  readonly accessGeneration: number;
  readonly accessRecheckMs?: number;
  readonly address: EventAddress;
  readonly authorize: Effect.Effect<void, ContractFailure>;
  readonly source: Stream.Stream<Value, ContractFailure, Scope.Scope>;
}

export const ACCESS_RECHECK_MS = 2000;
const ACCESS_CHECK_TIMEOUT_MS = 1000;

const authorizedDelivery = <Value>(
  attachment: ObservationAttachment<Value>,
  observation: (value: Value) => Observation,
  deniedValue: (frame: Observation) => Value
) => {
  let denied = false;
  let epoch = `access:${crypto.randomUUID()}`;
  let sequence = -1;
  const denial = (): Observation => ({
    accessGeneration: attachment.accessGeneration,
    address: attachment.address,
    epoch,
    reason: "revoked",
    schemaVersion: 1,
    sequence: sequence + 1,
    type: "access-denied",
  });
  const authorize = attachment.authorize.pipe(
    Effect.timeoutOrElse({
      duration: ACCESS_CHECK_TIMEOUT_MS,
      orElse: () =>
        Effect.fail(
          new Unavailable({
            reason: "Current access could not be verified.",
          })
        ),
    })
  );
  // Access is checked when the attachment opens and then once per interval.
  // Frames in between pass on the attachment's generation alone.
  const recheck = Effect.gen(function* recheckAccess() {
    if (denied) {
      return;
    }
    const access = yield* Effect.result(authorize);
    if (access._tag === "Failure") {
      if (access.failure._tag !== "Denied") {
        return yield* Effect.fail(access.failure);
      }
      denied = true;
      return deniedValue(denial());
    }
  });
  const validate = (value: Value): Value | undefined => {
    if (denied) {
      return;
    }
    const frame = observation(value);
    if (
      frame.accessGeneration !== attachment.accessGeneration ||
      !sameAddress(frame.address, attachment.address)
    ) {
      return;
    }
    ({ epoch, sequence } = frame);
    if (frame.type === "access-denied") {
      denied = true;
    }
    return value;
  };
  const delivery = attachment.source.pipe(Stream.map(validate));
  const idle = Stream.mapEffect(
    Stream.tick(attachment.accessRecheckMs ?? ACCESS_RECHECK_MS),
    () => recheck
  );
  return Stream.merge(delivery, idle, { haltStrategy: "left" }).pipe(
    Stream.filter((value): value is Value => value !== undefined),
    Stream.takeUntil((value) => observation(value).type === "access-denied")
  );
};

export const authorizedObservation = (attachment: ObservationAttachment) =>
  authorizedDelivery(
    attachment,
    (frame) => frame,
    (frame) => frame
  );

export const authorizedProtocolResponse = (
  attachment: ObservationAttachment<ProtocolBatch>
): Response =>
  protocolResponse(
    authorizedDelivery(
      attachment,
      (batch) => batch.observation,
      (frame) => ({
        events: [
          {
            ...observationEvent(frame),
            metadata: { cerebro: observationIdentity(frame) },
          },
        ],
        observation: frame,
      })
    )
  );

// oxlint-disable-next-line no-redeclare -- Effect service tags use their interface name.
export interface ObservationTransport {
  readonly response: (attachment: ObservationAttachment) => Response;
}
export const ObservationTransport = Context.Service<ObservationTransport>(
  "cerebro/ObservationTransport"
);
export const observationTransportLayer = Layer.succeed(ObservationTransport, {
  response: (attachment) =>
    observationResponse(authorizedObservation(attachment)),
});
