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
  readonly address: EventAddress;
  readonly authorize: Effect.Effect<void, ContractFailure>;
  readonly source: Stream.Stream<Value, ContractFailure, Scope.Scope>;
}

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
      duration: 500,
      orElse: () =>
        Effect.fail(
          new Unavailable({
            reason: "Current access could not be verified.",
          })
        ),
    })
  );
  const validate = (value?: Value) =>
    Effect.gen(function* checkDelivery() {
      if (denied) {
        return;
      }
      const access = yield* Effect.result(authorize);
      if (access._tag === "Failure") {
        if (access.failure._tag !== "Denied") {
          return yield* Effect.fail(access.failure);
        }
        if (denied) {
          return;
        }
        denied = true;
        return deniedValue(denial());
      }
      if (denied || value === undefined) {
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
    });
  const delivery = Stream.mapEffect(attachment.source, validate);
  const idle = Stream.mapEffect(Stream.drop(Stream.tick(250), 1), () =>
    validate()
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
