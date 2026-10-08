import type { EventAddress } from "@cerebro/contracts/events";
import { Unavailable } from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import type { Observation } from "@cerebro/contracts/session-service";
import { Context, Effect, Layer, Stream } from "effect";
import type { Scope } from "effect";

import { observationResponse, sameAddress } from "./protocol.ts";

interface ObservationAttachment {
  readonly accessGeneration: number;
  readonly address: EventAddress;
  readonly authorize: Effect.Effect<void, ContractFailure>;
  readonly source: Stream.Stream<Observation, ContractFailure, Scope.Scope>;
}

export const authorizedObservation = (attachment: ObservationAttachment) => {
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
  const validate = (frame?: Observation) =>
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
        return denial();
      }
      if (denied || !frame) {
        return;
      }
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
      return frame;
    });
  const delivery = Stream.mapEffect(attachment.source, validate);
  const idle = Stream.mapEffect(Stream.tick(250), () => validate());
  return Stream.merge(delivery, idle, { haltStrategy: "left" }).pipe(
    Stream.filter((frame): frame is Observation => frame !== undefined),
    Stream.takeUntil((frame) => frame.type === "access-denied")
  );
};

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
