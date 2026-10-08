import { Effect, Schema, Stream } from "effect";

import { Unavailable } from "../../../packages/contracts/src/failures.ts";
import { Observation } from "../../../packages/contracts/src/session-service.ts";

const MAX_FRAME_BYTES = 1_048_576;

export const readObservationStream = (body: ReadableStream<Uint8Array>) => {
  let frameBytes = 0;
  return Stream.fromReadableStream({
    evaluate: () => body,
    onError: () =>
      new Unavailable({ reason: "Session observation was interrupted." }),
  }).pipe(
    Stream.mapEffect((chunk) =>
      Effect.try({
        catch: () =>
          new Unavailable({
            reason: "Session observation frame is too large.",
          }),
        try: () => {
          for (const byte of chunk) {
            if (byte === 0x0a) {
              frameBytes = 0;
              continue;
            }
            frameBytes += 1;
            if (frameBytes > MAX_FRAME_BYTES) {
              throw new Error("Frame limit exceeded");
            }
          }
          return chunk;
        },
      })
    ),
    Stream.concat(
      Stream.suspend(() =>
        frameBytes === 0
          ? Stream.empty
          : Stream.fail(
              new Unavailable({
                reason: "Session observation frame is incomplete.",
              })
            )
      )
    ),
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.length > 0),
    Stream.mapEffect((line) =>
      Effect.try({
        catch: () =>
          new Unavailable({ reason: "Session observation frame is invalid." }),
        try: () => Schema.decodeUnknownSync(Observation)(JSON.parse(line)),
      })
    )
  );
};
