import { Unavailable } from "@cerebro/contracts/failures";
import type { HostCheckpoint } from "@cerebro/runtime/runtime-ports";
import { Effect } from "effect";

export const fixtureCheckpoint =
  (baseUrl: string): HostCheckpoint =>
  (boundary, operationId) =>
    Effect.tryPromise({
      catch: () =>
        new Unavailable({ reason: "Fixture checkpoint is unavailable" }),
      try: async (signal) => {
        const response = await fetch(new URL("/checkpoints", baseUrl), {
          body: JSON.stringify({ boundary, operationId }),
          headers: {
            "Content-Type": "application/json",
            "X-Fixture-Control": "slice-1-control",
          },
          method: "POST",
          signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
        });
        if (!response.ok) {
          throw new Error("Fixture checkpoint failed");
        }
        await response.body?.cancel();
      },
    });
