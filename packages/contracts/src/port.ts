import type { Digest, OperationId } from "./identity.ts";

export type PortResult<Value> =
  | { readonly status: "ok"; readonly value: Value }
  | {
      readonly status: "denied";
      readonly code:
        | "unauthorized"
        | "expired-delegation"
        | "entitlement"
        | "approval-required";
      readonly reason: string;
    }
  | {
      readonly status: "conflict";
      readonly code: "digest-mismatch" | "version-mismatch" | "already-final";
      readonly reason: string;
    }
  | {
      readonly status: "unavailable";
      readonly code: "provider-unavailable" | "deadline-exceeded" | "cancelled";
      readonly reason: string;
      readonly retryAfter?: number;
    }
  | { readonly status: "not-found"; readonly resource: string }
  | { readonly status: "invalid-input"; readonly reason: string }
  | {
      readonly status: "unknown-outcome";
      readonly operationId: OperationId;
      readonly reason: string;
    };

export interface ReadOptions {
  readonly deadlineAt: number;
  readonly signal?: AbortSignal;
}

export interface EffectOptions extends ReadOptions {
  // One logical intent keeps the same ID and digest across all retries.
  readonly operationId: OperationId;
  readonly requestDigest: Digest;
}

// Cancellation and deadlines stop local work or waiting. They do not prove that
// a remote effect did not occur, so such a result is "unknown-outcome".
export const preflightEffect = (
  options: ReadOptions,
  now: number
): PortResult<void> => {
  if (options.signal?.aborted) {
    return {
      code: "cancelled",
      reason: "The caller cancelled the operation.",
      status: "unavailable",
    };
  }
  if (!Number.isFinite(options.deadlineAt) || options.deadlineAt <= now) {
    return {
      code: "deadline-exceeded",
      reason: "The operation deadline has passed.",
      status: "unavailable",
    };
  }
  return { status: "ok", value: undefined };
};

export const classifyRetry = (
  prior:
    | { readonly operationId: OperationId; readonly requestDigest: Digest }
    | undefined,
  next: EffectOptions
): "new" | "duplicate" | "conflict" => {
  if (!prior || prior.operationId !== next.operationId) {
    return "new";
  }
  return prior.requestDigest === next.requestDigest ? "duplicate" : "conflict";
};
