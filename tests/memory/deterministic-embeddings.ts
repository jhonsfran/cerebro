import type { PortResult } from "../../packages/contracts/src/index.ts";
import { interrupted } from "../../packages/memory/src/runtime.ts";
import type { EmbeddingPort } from "../../packages/memory/src/types.ts";

// Synthetic embeddings for tests only; a deployment always uses a real provider.
export const createDeterministicFixtureEmbeddings = (
  dimensions = 8
): EmbeddingPort => {
  if (!Number.isSafeInteger(dimensions) || dimensions < 1) {
    throw new Error("Fixture dimensions must be a positive integer.");
  }
  return {
    dimensions,
    embed(texts, options): Promise<PortResult<readonly (readonly number[])[]>> {
      const check = interrupted(options);
      if (check.status !== "ok") {
        return Promise.resolve(check);
      }
      return Promise.resolve({
        status: "ok",
        value: texts.map((text) => {
          const vector = Array.from({ length: dimensions }, () => 0.01);
          for (const word of text.toLowerCase().match(/[a-z0-9]+/gu) ?? []) {
            let hash = 0;
            for (const character of word) {
              hash =
                (hash * 31 + (character.codePointAt(0) ?? 0)) % 4_294_967_296;
            }
            vector[hash % dimensions] = (vector[hash % dimensions] ?? 0) + 1;
          }
          return vector;
        }),
      });
    },
    model: `synthetic-fixture-${dimensions}`,
  };
};
