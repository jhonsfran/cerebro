import type { ChannelService } from "@cerebro/channels/service";
import { z } from "zod";

import { parseInput } from "./agents";

export const handleApprovalRequest = (
  service: ChannelService,
  method: string,
  path: readonly string[],
  userId: string,
  body: unknown
): Promise<unknown> => {
  const [, conversationId] = path;
  if (path[0] !== "conversations" || !conversationId || method !== "POST") {
    return Promise.resolve();
  }
  if (path[2] === "approvals" && path[3] && path.length === 4) {
    const input = parseInput(
      z.object({ operationId: z.string().min(1).max(256) }),
      body
    );
    return service.approve(userId, conversationId, path[3], input.operationId);
  }
  if (
    path[2] === "runs" &&
    path[3] &&
    path[4] === "cancel" &&
    path.length === 5
  ) {
    const input = parseInput(
      z.object({ operationId: z.string().min(1).max(256) }),
      body
    );
    return service.cancel(userId, conversationId, path[3], input.operationId);
  }
  return Promise.resolve();
};
