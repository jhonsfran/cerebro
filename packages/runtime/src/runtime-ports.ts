import {
  Conflict,
  Denied,
  InvalidInput,
  NotFound,
  Unavailable,
  UnknownOutcome,
} from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import type { ReadOptions } from "@cerebro/contracts/port";
import { Effect } from "effect";

export type HostCheckpoint = (
  boundary:
    | "before-engine-submission"
    | `${"before" | "after"}-${"admission" | "approval" | "projection" | "result-persistence"}`,
  operationId: string
) => Effect.Effect<void, ContractFailure>;

export const contractFailure = (cause: unknown): ContractFailure =>
  cause instanceof Conflict ||
  cause instanceof Denied ||
  cause instanceof InvalidInput ||
  cause instanceof NotFound ||
  cause instanceof Unavailable ||
  cause instanceof UnknownOutcome
    ? cause
    : new Unavailable({ reason: "Runtime adapter unavailable" });

export const checkOptions = (options: ReadOptions): void => {
  if (
    !Number.isFinite(options.deadlineAt) ||
    options.deadlineAt <= Date.now() ||
    options.signal?.aborted
  ) {
    throw new Unavailable({ reason: "Deadline or caller interruption" });
  }
};

export const attempt = <A>(run: () => A): Effect.Effect<A, ContractFailure> =>
  Effect.try({ catch: contractFailure, try: run });

// Host observation deadlines can exceed the platform's signed 32-bit timer range.
const waitingMs = (options: ReadOptions) =>
  Math.min(2_147_483_647, Math.max(1, options.deadlineAt - Date.now()));

export const waitForCaller = <A>(
  program: Effect.Effect<A, ContractFailure>,
  options: ReadOptions
): Effect.Effect<A, ContractFailure> => {
  const { signal } = options;
  const interrupted = Effect.callback<never, ContractFailure>((resume) => {
    const cancel = () =>
      resume(
        Effect.fail(new Unavailable({ reason: "Caller stopped waiting" }))
      );
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) {
      cancel();
    }
    return Effect.sync(() => signal?.removeEventListener("abort", cancel));
  });
  return Effect.raceFirst(program, interrupted).pipe(
    Effect.timeoutOrElse({
      duration: waitingMs(options),
      orElse: () =>
        Effect.fail(new Unavailable({ reason: "Caller deadline exceeded" })),
    })
  );
};

// The caller's scope limits the vendor call, not the durable work it admits.
export const vendorEffect = <A>(
  options: ReadOptions,
  run: (signal: AbortSignal) => Promise<A>
): Effect.Effect<A, ContractFailure> =>
  Effect.gen(function* invokeVendor() {
    yield* attempt(() => checkOptions(options));
    return yield* Effect.tryPromise({
      catch: contractFailure,
      try: (signal) =>
        run(
          options.signal ? AbortSignal.any([signal, options.signal]) : signal
        ),
    }).pipe(
      Effect.timeoutOrElse({
        duration: waitingMs(options),
        orElse: () =>
          Effect.fail(new Unavailable({ reason: "Vendor deadline exceeded" })),
      })
    );
  });
