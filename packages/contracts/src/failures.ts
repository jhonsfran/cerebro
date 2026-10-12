/* oxlint-disable max-classes-per-file -- S1-0 owns one shared typed-failure module. */
import { Data, Effect } from "effect";

import type { OperationId } from "./identity.ts";
import type { PortResult } from "./port.ts";

export class Denied extends Data.TaggedError("Denied")<{
  readonly reason: string;
  readonly code: "unauthorized" | "approval-required" | "revoked";
}> {}
export class InvalidInput extends Data.TaggedError("InvalidInput")<{
  readonly reason: string;
}> {}
export class Conflict extends Data.TaggedError("Conflict")<{
  readonly reason: string;
  readonly code: "digest-mismatch" | "version-mismatch" | "already-final";
}> {}
export class Unavailable extends Data.TaggedError("Unavailable")<{
  readonly reason: string;
  readonly retryAfter?: number;
}> {}
export class NotFound extends Data.TaggedError("NotFound")<{
  readonly resource: string;
}> {}
export class UnknownOutcome extends Data.TaggedError("UnknownOutcome")<{
  readonly operationId: OperationId;
  readonly reason: string;
}> {}

export type ContractFailure =
  | Denied
  | InvalidInput
  | Conflict
  | Unavailable
  | NotFound
  | UnknownOutcome;

// Only for responses whose headers have not been sent. A streaming denial is data.
export const failureToHttp = (failure: ContractFailure) => {
  const statuses = {
    Conflict: 409,
    Denied: 403,
    InvalidInput: 400,
    NotFound: 404,
    Unavailable: 503,
    UnknownOutcome: 409,
  } as const;
  return {
    body: {
      error: failure._tag,
      message: "reason" in failure ? failure.reason : failure.resource,
    },
    status: statuses[failure._tag],
  };
};

export const isContractFailure = (cause: unknown): cause is ContractFailure =>
  cause instanceof Conflict ||
  cause instanceof Denied ||
  cause instanceof InvalidInput ||
  cause instanceof NotFound ||
  cause instanceof Unavailable ||
  cause instanceof UnknownOutcome;

// Keeps a typed failure and hides every other cause behind one safe reason.
export const toContractFailure = (
  cause: unknown,
  reason = "The adapter is unavailable."
): ContractFailure =>
  isContractFailure(cause) ? cause : new Unavailable({ reason });

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
      return Effect.fail(
        new Unavailable({
          reason: result.reason,
          retryAfter: result.retryAfter,
        })
      );
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

// Runs a Promise-based adapter call; an untyped rejection becomes Unavailable.
export const tryAdapter = <A>(
  run: () => Promise<A>,
  reason = "The company store is unavailable."
): Effect.Effect<A, ContractFailure> =>
  Effect.tryPromise({
    catch: (cause) => toContractFailure(cause, reason),
    try: run,
  });
