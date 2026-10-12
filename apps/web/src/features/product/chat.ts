import { z } from "zod";

export const pendingChatSchema = z.object({
  operationId: z.string(),
  text: z.string(),
});
export type PendingChatMessage = z.infer<typeof pendingChatSchema>;
