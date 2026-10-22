import { z } from "zod";

export const MAX_CHAT_MESSAGE_LENGTH = 16_000;
export const CHAT_MESSAGE_LENGTH_ERROR =
  "Messages can contain at most 16,000 characters.";

export const pendingChatSchema = z.object({
  operationId: z.string(),
  text: z.string().max(MAX_CHAT_MESSAGE_LENGTH, CHAT_MESSAGE_LENGTH_ERROR),
});
export type PendingChatMessage = z.infer<typeof pendingChatSchema>;
