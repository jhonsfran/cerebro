import type { HostCheckpoint } from "@cerebro/runtime/runtime-ports";
import { Effect } from "effect";

interface AdapterMeasurement {
  readonly adapter: "permission" | "projection";
  readonly durationMs: number;
  readonly operationId?: string;
  readonly recordedAt: number;
}
const measurements = new WeakMap<DurableObjectStorage, AdapterMeasurement[]>();
const record = (
  storage: DurableObjectStorage,
  measurement: AdapterMeasurement
): void => {
  const samples = measurements.get(storage) ?? [];
  samples.push(measurement);
  if (samples.length > 4096) {
    samples.shift();
  }
  measurements.set(storage, samples);
};

export const measureFixturePermission = <Value, Failure, Requirements>(
  storage: DurableObjectStorage,
  effect: Effect.Effect<Value, Failure, Requirements>
): Effect.Effect<Value, Failure, Requirements> =>
  Effect.suspend(() => {
    const started = performance.now();
    return effect.pipe(
      Effect.onExit(() =>
        Effect.sync(() =>
          record(storage, {
            adapter: "permission",
            durationMs: performance.now() - started,
            recordedAt: Date.now(),
          })
        )
      )
    );
  });

export const measureFixtureProjection = (
  storage: DurableObjectStorage,
  checkpoint: HostCheckpoint
): HostCheckpoint => {
  const started = new Map<string, number>();
  return (boundary, operationId) =>
    Effect.gen(function* measuredCheckpoint() {
      if (boundary === "after-projection") {
        const at = started.get(operationId);
        if (at !== undefined) {
          record(storage, {
            adapter: "projection",
            durationMs: performance.now() - at,
            operationId,
            recordedAt: Date.now(),
          });
          started.delete(operationId);
        }
      }
      yield* checkpoint(boundary, operationId);
      if (boundary === "before-projection") {
        started.set(operationId, performance.now());
        if (started.size > 128) {
          const oldest = started.keys().next().value;
          if (oldest !== undefined) {
            started.delete(oldest);
          }
        }
      }
    });
};

export const readFixtureMetrics = (
  storage: DurableObjectStorage
): readonly AdapterMeasurement[] =>
  structuredClone(measurements.get(storage) ?? []);
