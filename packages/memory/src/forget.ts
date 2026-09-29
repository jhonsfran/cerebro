import type {
  EffectOptions,
  MemoryScope,
  PortResult,
  SourceId,
} from "@cerebro/contracts";

import { authorizeNewSource } from "./access";
import { bounded, effectBinding, interrupted } from "./runtime";
import type { MemoryDependencies } from "./types";

export const forget = async (
  dependencies: MemoryDependencies,
  scope: MemoryScope,
  sourceId: SourceId,
  options: EffectOptions,
  state: "deleted" | "revoked" = "deleted"
): Promise<PortResult<{ readonly removed: number }>> => {
  const now = dependencies.now ?? Date.now;
  let effectStarted = false;
  return await bounded(
    options,
    async () => {
      const current = await dependencies.repository.source(
        scope.organizationId,
        sourceId
      );
      const allowed = await authorizeNewSource(
        dependencies,
        scope,
        sourceId,
        current?.visibility ?? { kind: "organization" },
        options
      );
      if (allowed.status !== "ok") {
        return allowed;
      }
      const binding = await effectBinding(
        scope,
        state === "deleted" ? "forget" : "revoke",
        { sourceId },
        options
      );
      effectStarted = true;
      const result = await bounded(
        options,
        async () =>
          await dependencies.repository.remove(binding, sourceId, state),
        now,
        options
      );
      if (result.status !== "ok") {
        return result;
      }
      if (interrupted(options, now).status === "ok") {
        await dependencies.repository.cleanup(
          async (key) => await dependencies.objects.delete(key, options),
          new Date(now())
        );
      }
      return { status: "ok", value: { removed: result.value.removed ?? 0 } };
    },
    now,
    () => (effectStarted ? options : undefined)
  );
};
