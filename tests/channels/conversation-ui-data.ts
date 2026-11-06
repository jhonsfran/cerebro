import { currentAccessGeneration } from "../../apps/web/src/features/product/api";
import { conversationSchema } from "../../apps/web/src/features/product/types";
import type { LoadedConversation } from "../../apps/web/src/features/product/types";
import type { ChatSnapshot } from "../../packages/contracts/src/session-service.ts";

export const loadedConversation = (
  snapshot: ChatSnapshot,
  mode = "local"
): LoadedConversation => ({
  userId: "user",
  principalId: "principal",
  accessGeneration: currentAccessGeneration(),
  selectionRevision: 1,
  conversation: conversationSchema.parse({
    ...snapshot.address,
    mode,
    snapshot,
  }),
});
