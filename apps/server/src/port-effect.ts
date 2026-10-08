import {
  Conflict,
  Denied,
  InvalidInput,
  NotFound,
  Unavailable,
  UnknownOutcome,
} from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import type { PortResult } from "@cerebro/contracts/port";
import { Effect } from "effect";

export const fromPortResult = <A>(
  result: PortResult<A>
): Effect.Effect<A, ContractFailure> => {
  switch (result.status) {
    case "ok": {
      return Effect.succeed(result.value);
    }
    case "denied": {
      return Effect.fail(
        new Denied({
          code:
            result.code === "approval-required"
              ? "approval-required"
              : "unauthorized",
          reason: result.reason,
        })
      );
    }
    case "conflict": {
      return Effect.fail(
        new Conflict({ code: result.code, reason: result.reason })
      );
    }
    case "invalid-input": {
      return Effect.fail(new InvalidInput({ reason: result.reason }));
    }
    case "not-found": {
      return Effect.fail(new NotFound({ resource: result.resource }));
    }
    case "unavailable": {
      return Effect.fail(new Unavailable({ reason: result.reason }));
    }
    case "unknown-outcome": {
      return Effect.fail(
        new UnknownOutcome({
          operationId: result.operationId,
          reason: result.reason,
        })
      );
    }
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
};

export const databaseEffect = <A>(
  operation: () => Promise<A>
): Effect.Effect<A, ContractFailure> =>
  Effect.tryPromise({
    catch: (cause) =>
      cause instanceof Conflict ||
      cause instanceof Denied ||
      cause instanceof InvalidInput ||
      cause instanceof NotFound ||
      cause instanceof Unavailable ||
      cause instanceof UnknownOutcome
        ? cause
        : new Unavailable({ reason: "The company store is unavailable." }),
    try: operation,
  });
