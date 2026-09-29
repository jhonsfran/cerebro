import type {
  EffectOptions,
  MemoryScope,
  PortResult,
  ReadOptions,
} from "@cerebro/contracts";
import type { EffectBinding } from "@cerebro/db/repositories/memory";

export const denied = (reason: string) => ({
  code: "unauthorized" as const,
  reason,
  status: "denied" as const,
});
export const invalid = (reason: string) => ({
  reason,
  status: "invalid-input" as const,
});
const canonicalArguments = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalArguments);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([first], [second]) => first.localeCompare(second))
        .map(([key, entry]) => [key, canonicalArguments(entry)])
    );
  }
  return value;
};
export const fingerprint = async (value: unknown): Promise<string> => {
  const bytes =
    value instanceof Uint8Array
      ? new Uint8Array(value)
      : new TextEncoder().encode(JSON.stringify(canonicalArguments(value)));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
};
export const effectBinding = async (
  scope: MemoryScope,
  kind: string,
  argumentsValue: unknown,
  options: EffectOptions
): Promise<EffectBinding> => ({
  actorBinding: JSON.stringify([
    scope.context.actor.id,
    scope.context.represented?.id ?? null,
    scope.context.delegation?.id ?? null,
  ]),
  fingerprint: await fingerprint(argumentsValue),
  id: options.operationId,
  kind,
  organizationId: scope.organizationId,
  principalId: scope.context.represented?.id ?? scope.context.actor.id,
  requestDigest: options.requestDigest,
});

export const interrupted = (
  options: ReadOptions,
  now: () => number = Date.now
): PortResult<void> => {
  if (options.signal?.aborted) {
    return {
      code: "cancelled",
      reason: "The caller cancelled the request.",
      status: "unavailable",
    };
  }
  if (!Number.isFinite(options.deadlineAt) || now() >= options.deadlineAt) {
    return {
      code: "deadline-exceeded",
      reason: "The deadline has passed.",
      status: "unavailable",
    };
  }
  return { status: "ok", value: undefined };
};

export const bounded = async <T>(
  options: ReadOptions,
  run: () => Promise<PortResult<T>>,
  now: () => number = Date.now,
  effect?: EffectOptions | (() => EffectOptions | undefined)
): Promise<PortResult<T>> => {
  const check = interrupted(options, now);
  if (check.status !== "ok") {
    return check;
  }
  const interruptionToken = Symbol("interrupted");
  const { promise, resolve } =
    Promise.withResolvers<typeof interruptionToken>();
  const interrupt = () => resolve(interruptionToken);
  const timer = setTimeout(
    interrupt,
    Math.min(options.deadlineAt - now(), 2_147_483_647)
  );
  options.signal?.addEventListener("abort", interrupt, { once: true });
  try {
    const result = await Promise.race([run(), promise]);
    if (
      result === interruptionToken ||
      options.signal?.aborted ||
      now() >= options.deadlineAt
    ) {
      const currentEffect = typeof effect === "function" ? effect() : effect;
      if (currentEffect) {
        return {
          operationId: currentEffect.operationId,
          reason: "The effect may have completed after local waiting stopped.",
          status: "unknown-outcome",
        };
      }
      return {
        code: options.signal?.aborted ? "cancelled" : "deadline-exceeded",
        reason: "The read stopped before completion.",
        status: "unavailable",
      };
    }
    return result;
  } catch {
    const currentEffect = typeof effect === "function" ? effect() : effect;
    if (currentEffect) {
      return {
        operationId: currentEffect.operationId,
        reason: "The effect result could not be confirmed.",
        status: "unknown-outcome",
      };
    }
    return {
      code: "provider-unavailable",
      reason: "The memory provider is unavailable.",
      status: "unavailable",
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", interrupt);
  }
};
