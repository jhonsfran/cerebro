/* oxlint-disable no-await-in-loop -- Each body chunk must pass the byte limit before the reader requests another chunk. */
import { createChannelService } from "@cerebro/channels/service";
import { receiveSlackEvent, verifySlackRequest } from "@cerebro/channels/slack";
import { ChannelError } from "@cerebro/channels/types";
import type { ProductHandlerOptions } from "@cerebro/channels/types";
import { z } from "zod";

import { handleAgentRequest, parseInput } from "./agents";
import { handleApprovalRequest } from "./approvals";

const BODY_LIMIT_BYTES = 100_000;
const readBody = async (request: Request): Promise<string> => {
  if (Number(request.headers.get("Content-Length")) > BODY_LIMIT_BYTES) {
    throw new ChannelError(
      413,
      "invalid-input",
      "The request body is too large."
    );
  }
  const reader = request.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > BODY_LIMIT_BYTES) {
        await reader.cancel();
        throw new ChannelError(
          413,
          "invalid-input",
          "The request body is too large."
        );
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};
const json = (value: unknown, status = 200) =>
  Response.json(value, { headers: { "Cache-Control": "no-store" }, status });
const parseBody = (raw: string): unknown => {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ChannelError(
      422,
      "invalid-input",
      "The request body must be JSON."
    );
  }
};
const handleConversationRequest = async (
  service: ReturnType<typeof createChannelService>,
  method: string,
  path: readonly string[],
  userId: string,
  body: unknown,
  cursor?: string
): Promise<Response | undefined> => {
  const [kind, conversationId, action, resourceId] = path;
  if (kind !== "conversations") {
    return;
  }
  if (path.length === 1) {
    if (method === "GET") {
      return json(await service.listConversations(userId));
    }
    if (method === "POST") {
      const input = parseInput(
        z.object({
          agentId: z.string().min(1).max(256),
          operationId: z.string().min(1).max(256),
        }),
        body
      );
      return json(
        await service.createConversation(
          userId,
          input.agentId,
          input.operationId
        )
      );
    }
    return;
  }
  if (!conversationId) {
    return;
  }
  if (path.length === 2 && method === "GET") {
    return json(await service.readConversation(userId, conversationId));
  }
  if (action === "messages" && method === "POST" && path.length === 3) {
    const input = parseInput(
      z.object({
        eventId: z.string().min(1).max(256),
        text: z.string().trim().min(1).max(16_000),
      }),
      body
    );
    return json(
      await service.submit(userId, conversationId, input.eventId, input.text)
    );
  }
  if (method !== "GET") {
    return;
  }
  switch (action) {
    case "events": {
      const view = await service.readConversation(
        userId,
        conversationId,
        cursor
      );
      const data = view.items
        .map(
          (item) =>
            `id: ${item.cursor}\nevent: item\ndata: ${JSON.stringify(item)}\n\n`
        )
        .join("");
      return new Response(`retry: 1000\n\n${data}`, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/event-stream",
          "X-Accel-Buffering": "no",
        },
      });
    }
    case "history": {
      return json(await service.history(userId, conversationId));
    }
    case "sources": {
      return resourceId
        ? json(await service.source(userId, conversationId, resourceId))
        : undefined;
    }
    case "audit": {
      return resourceId
        ? json(await service.audit(userId, conversationId, resourceId))
        : undefined;
    }
    default: {
      return undefined;
    }
  }
};
export const createProductHandler =
  (options: ProductHandlerOptions) =>
  async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const raw = request.method === "GET" ? "" : await readBody(request);
      if (
        url.pathname === "/api/channels/slack/events" &&
        request.method === "POST"
      ) {
        const { slack } = options;
        if (!slack) {
          throw new ChannelError(404, "not-found", "Slack is not configured.");
        }
        await verifySlackRequest(
          raw,
          request.headers.get("x-slack-signature"),
          request.headers.get("x-slack-request-timestamp"),
          slack.signingSecret,
          options.now?.()
        );
        const body = parseBody(raw);
        const challenge = z
          .object({
            challenge: z.string().min(1).max(1000),
            type: z.literal("url_verification"),
          })
          .safeParse(body);
        if (challenge.success) {
          return json({ challenge: challenge.data.challenge });
        }
        return await options.withDatabase(async (database) =>
          json(await receiveSlackEvent(database, options, body, slack))
        );
      }
      return await options.withDatabase(async (database) => {
        const user = await options.getUser(request, database);
        if (!user) {
          throw new ChannelError(401, "unauthorized", "Sign in to continue.");
        }
        const service = createChannelService(database, options);
        const body = parseBody(raw);
        if (
          url.pathname === "/api/fixture/slack/events" &&
          request.method === "POST"
        ) {
          const setup = await service.setup(user.id);
          if (options.mode !== "fixture") {
            throw new ChannelError(
              404,
              "not-found",
              "The fixture route is disabled."
            );
          }
          if (!setup.owner) {
            throw new ChannelError(
              403,
              "forbidden",
              "The fixture route requires the installation owner."
            );
          }
          const fixture = parseInput(
            z.object({ agentId: z.string().min(1), event: z.unknown() }),
            body
          );
          const config = options.slack ?? {
            agentId: fixture.agentId,
            appId: "fixture-app",
            signingSecret: "fixture-only",
            workspaceId: "fixture-workspace",
          };
          return json(
            await receiveSlackEvent(database, options, fixture.event, config)
          );
        }
        if (!url.pathname.startsWith("/api/product/")) {
          throw new ChannelError(404, "not-found", "The route was not found.");
        }
        const path = url.pathname
          .slice("/api/product/".length)
          .split("/")
          .filter(Boolean)
          .map(decodeURIComponent);
        const agentResult = await handleAgentRequest(
          service,
          request.method,
          path,
          user.id,
          body
        );
        if (agentResult !== undefined) {
          return json(agentResult);
        }
        const approvalResult = await handleApprovalRequest(
          service,
          request.method,
          path,
          user.id,
          body
        );
        if (approvalResult !== undefined) {
          return json(approvalResult);
        }
        const result = await handleConversationRequest(
          service,
          request.method,
          path,
          user.id,
          body,
          url.searchParams.get("cursor") ??
            request.headers.get("Last-Event-ID") ??
            undefined
        );
        if (result) {
          return result;
        }
        throw new ChannelError(404, "not-found", "The route was not found.");
      });
    } catch (error) {
      if (error instanceof ChannelError) {
        return json({ code: error.code, message: error.message }, error.status);
      }
      return json(
        { code: "unavailable", message: "The product service is unavailable." },
        503
      );
    }
  };
export type { ProductHandlerOptions } from "@cerebro/channels/types";
