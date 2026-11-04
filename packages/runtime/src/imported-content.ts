import type { ContentDependencies } from "@cerebro/contracts/session";
import { BoundedContentDependenciesSchema } from "@cerebro/contracts/work";
import type { WorkAdmission } from "@cerebro/contracts/work";
import { defineDoc } from "@earendil-works/pi-durable";
import type { ConversationId, Harness, Tx } from "@earendil-works/pi-durable";
import { Schema } from "effect";

import { piContext } from "./pi-harness.ts";

export const ImportedContent = defineDoc({
  kind: "cerebro.imported-content",
  scope: "conversation",
  history: "latest",
  fork: "current",
  version: 1,
  initial: (): WorkAdmission["contentDependencies"] => ({
    sourceIds: [],
    toolIds: [],
  }),
});
export const readImportedContent = async (
  pi: Harness,
  nativeId: ConversationId | undefined
): Promise<ContentDependencies> => {
  if (nativeId === undefined) {
    return { sourceIds: [], toolIds: [] };
  }
  return (
    (await pi.snapshot(ImportedContent, nativeId, piContext())) ?? {
      sourceIds: [],
      toolIds: [],
    }
  );
};
export const importContentIn = async (
  tx: Tx,
  nativeId: ConversationId,
  incoming: ContentDependencies
): Promise<void> => {
  const stored = await tx.doc(ImportedContent, nativeId);
  const merged = Schema.decodeUnknownSync(BoundedContentDependenciesSchema)({
    sourceIds: [...new Set([...stored.sourceIds, ...incoming.sourceIds])],
    toolIds: [...new Set([...stored.toolIds, ...incoming.toolIds])],
  });
  stored.sourceIds = merged.sourceIds;
  stored.toolIds = merged.toolIds;
};
