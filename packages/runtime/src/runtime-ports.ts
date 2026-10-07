import {
  Conflict,
  Denied,
  InvalidInput,
  NotFound,
  Unavailable,
  UnknownOutcome,
} from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import type { MemoryHit } from "@cerebro/contracts/memory";
import type { AuthorizationPolicy } from "@cerebro/contracts/policy";
import type { PortResult, ReadOptions } from "@cerebro/contracts/port";
import type { ContentDependencies } from "@cerebro/contracts/session";
import type { PaidWork } from "@cerebro/policy/authorization-gate";
import type { ToolBroker } from "@cerebro/tools/broker";
import type { ToolRegistry } from "@cerebro/tools/registry";
import { Effect } from "effect";

import type { StoredRun } from "./ledger.ts";
import type { DurableOperationJournal } from "./operation-journal.ts";

export interface ConfiguredModel {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly maxInputBytes: number;
  readonly maxRequestsPerRun: number;
  readonly maxOutputTokens: number;
  readonly maxResponseBytes: number;
  readonly deadlineMs: number;
  readonly pricing: {
    readonly version: string;
    readonly unit: string;
    readonly inputPerToken: number;
    readonly outputPerToken: number;
  };
}
export interface ModelHttpReceipt {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly units: number;
  readonly unit: string;
}
export interface RuntimePorts {
  readonly model: ConfiguredModel;
  readonly authorization: AuthorizationPolicy;
  readonly registry: ToolRegistry;
  readonly broker: ToolBroker;
  readonly modelJournal: DurableOperationJournal<ModelHttpReceipt>;
  readonly paidModel: PaidWork<ModelHttpReceipt>;
  readonly retrieve: (
    run: StoredRun,
    options: ReadOptions
  ) => Promise<PortResult<readonly MemoryHit[]>>;
  readonly checkDependencies: (
    run: StoredRun,
    dependencies: ContentDependencies,
    options: ReadOptions
  ) => Promise<PortResult<void>>;
  readonly prepareApproval: (operationId: string) => Promise<void>;
}

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
