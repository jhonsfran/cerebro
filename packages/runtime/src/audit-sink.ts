import type { ToolAuditEvent } from "@cerebro/contracts/audit";
import { Unavailable } from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import { Effect } from "effect";

export const sendToAuditSink =
  (sink: Fetcher) =>
  (event: ToolAuditEvent): Effect.Effect<void, ContractFailure> =>
    Effect.tryPromise({
      catch: () =>
        new Unavailable({ reason: "The audit sink is unavailable." }),
      try: async () => {
        const response = await sink.fetch(
          new Request("https://audit.internal/project", {
            body: JSON.stringify(event),
            headers: { "content-type": "application/json" },
            method: "POST",
          })
        );
        await response.body?.cancel();
        if (!response.ok) {
          throw new Error(`The audit sink answered ${response.status}.`);
        }
      },
    });
