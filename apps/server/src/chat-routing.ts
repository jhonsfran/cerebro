import { createChannelService } from "@cerebro/channels/service";
import { ChannelError } from "@cerebro/channels/types";
import { getAgentByName } from "agents";

import { sessionName } from "../../../packages/runtime/src/event-handler";
import { createChannelOptions } from "./channel-services";
import type { WorkerEnv } from "./env.server";
import { createAuth } from "./services";

export const handleChatRequest = async (
  request: Request,
  env: WorkerEnv,
  conversationId: string
): Promise<Response> => {
  try {
    const origin = request.headers.get("Origin");
    const upgrade = request.headers.get("Upgrade")?.toLowerCase();
    if (
      (upgrade === "websocket" && origin !== env.CORS_ORIGIN) ||
      (origin !== null && origin !== env.CORS_ORIGIN)
    ) {
      throw new ChannelError(
        403,
        "forbidden",
        "The request origin is not permitted."
      );
    }
    const options = createChannelOptions(env);
    const { address, authSessionId, userId } = await options.withDatabase(
      async (database) => {
        const authenticated = await createAuth(env, database).api.getSession({
          headers: request.headers,
        });
        if (!authenticated) {
          throw new ChannelError(401, "unauthorized", "Sign in to continue.");
        }
        const access = await createChannelService(database, options).chatAccess(
          authenticated.user.id,
          conversationId
        );
        return {
          address: access.address,
          authSessionId: authenticated.session.id,
          userId: authenticated.user.id,
        };
      }
    );
    const headers = new Headers(request.headers);
    for (const name of headers.keys()) {
      if (name.toLowerCase().startsWith("x-cerebro-")) {
        headers.delete(name);
      }
    }
    headers.set("x-cerebro-chat-user", userId);
    headers.set("x-cerebro-chat-auth-session", authSessionId);
    headers.set("x-cerebro-chat-conversation", conversationId);
    const agent = await getAgentByName(env.SESSION, sessionName(address));
    return await agent.fetch(new Request(request, { headers }));
  } catch (error) {
    if (error instanceof ChannelError) {
      return Response.json(
        { code: error.code, message: error.message },
        { headers: { "Cache-Control": "no-store" }, status: error.status }
      );
    }
    return Response.json(
      { code: "unavailable", message: "The chat connection is unavailable." },
      { headers: { "Cache-Control": "no-store" }, status: 503 }
    );
  }
};
