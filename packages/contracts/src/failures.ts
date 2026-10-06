/* oxlint-disable max-classes-per-file -- S1-0 owns one shared typed-failure module. */
import { Data } from "effect";

import type { OperationId } from "./identity.ts";

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
