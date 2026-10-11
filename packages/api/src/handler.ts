/* oxlint-disable no-await-in-loop -- Each body chunk must pass the byte limit before the reader requests another chunk. */
import {
  START_FAILED,
  receiveSlackEvent,
  receiveSlackInteraction,
  verifySlackRequest,
} from "@cerebro/channels/slack";
import { createSlackApi } from "@cerebro/channels/slack-api";
import { ChannelError } from "@cerebro/channels/types";
import type { ProductHandlerOptions } from "@cerebro/channels/types";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { z } from "zod";

import type { Context } from "./context";
import { createAppRouter } from "./routers/index";
import type { MemoryApiFactory } from "./routers/memory";
import { observeConversation } from "./routers/observations";

const BODY_LIMIT_BYTES = 100_000;
const OBSERVATION_PATH =
  /^\/api\/product\/conversations\/(?<conversationId>[^/]+)\/observations$/u;
const SLACK_EVENTS_PATH = "/api/channels/slack/events";
const SLACK_INTERACTIONS_PATH = "/api/channels/slack/interactions";

// Lets a response return before background work finishes, as a Worker's
// ExecutionContext does. Without one, the work completes before the response.
export interface BackgroundWork {
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

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

const slackEventSchema = z.object({
  event: z
    .object({
      channel: z.string().optional(),
      thread_ts: z.string().optional(),
      ts: z.string().optional(),
    })
    .optional(),
});

const verifiedSlack = async (
  options: ProductHandlerOptions,
  request: Request,
  raw: string
) => {
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
  return slack;
};

const parseJson = (raw: string): unknown => {
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

// Slack retries an event that is not acknowledged within three seconds, so the
// work runs after the response when the host allows it.
const receiveSlack = async (
  options: ProductHandlerOptions,
  request: Request,
  raw: string,
  background?: BackgroundWork
): Promise<Response> => {
  const slack = await verifiedSlack(options, request, raw);
  const body = parseJson(raw);
  const challenge = z
    .object({
      challenge: z.string().min(1).max(1000),
      type: z.literal("url_verification"),
    })
    .safeParse(body);
  if (challenge.success) {
    return json({ challenge: challenge.data.challenge });
  }
  const retry = request.headers.has("x-slack-retry-num");
  const receive = () =>
    options.withDatabase((database) =>
      receiveSlackEvent(database, options, body, slack, retry)
    );
  if (!background) {
    return json(await receive());
  }
  // After the acknowledgement, a failure is reported in the thread instead.
  const work = async () => {
    try {
      await receive();
    } catch {
      const event = slackEventSchema.safeParse(body).data?.event;
      if (event?.channel && !retry) {
        await createSlackApi(slack, options.fetch).send({
          channel: event.channel,
          text: START_FAILED,
          threadTs: event.thread_ts ?? event.ts,
        });
      }
    }
  };
  background.waitUntil(work());
  return json({ ok: true });
};

const receiveSlackAction = async (
  options: ProductHandlerOptions,
  request: Request,
  raw: string,
  background?: BackgroundWork
): Promise<Response> => {
  const slack = await verifiedSlack(options, request, raw);
  const payload = new URLSearchParams(raw).get("payload");
  if (!payload) {
    throw new ChannelError(
      422,
      "invalid-input",
      "The Slack action is invalid."
    );
  }
  const body = parseJson(payload);
  const receive = () =>
    options.withDatabase((database) =>
      receiveSlackInteraction(database, options, body, slack)
    );
  if (!background) {
    return json(await receive());
  }
  // The session posts the decision back into the thread once it commits; a
  // refused press changes nothing, so its error is not reported to Slack.
  const work = async () => {
    try {
      await receive();
    } catch {
      // Nothing to undo.
    }
  };
  background.waitUntil(work());
  return new Response(null, { status: 200 });
};

// One handler serves the whole API: typed RPC under /rpc, the same procedures
// as REST under /api, and two raw routes that cannot be procedures: the Slack
// webhook (its signature covers the raw body) and the NDJSON observation stream.
export const createApiHandler = (
  options: ProductHandlerOptions,
  memory?: MemoryApiFactory
) => {
  const router = createAppRouter(memory);
  const rest = new OpenAPIHandler(router);
  const rpc = new RPCHandler(router);
  const reference = new OpenAPIHandler(router, {
    plugins: [
      new OpenAPIReferencePlugin({
        schemaConverters: [new ZodToJsonSchemaConverter()],
      }),
    ],
  });
  return async (
    request: Request,
    background?: BackgroundWork
  ): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const observation = OBSERVATION_PATH.exec(url.pathname);
      if (request.method === "GET" && observation?.[1]) {
        return await observeConversation(
          request,
          options,
          decodeURIComponent(observation[1])
        );
      }
      // Product and Slack bodies are small; RPC carries large memory documents.
      const limited =
        url.pathname.startsWith("/api/product/") ||
        url.pathname.startsWith("/api/channels/slack/");
      const raw =
        limited && !["GET", "HEAD"].includes(request.method)
          ? await readBody(request)
          : undefined;
      if (url.pathname === SLACK_EVENTS_PATH && request.method === "POST") {
        return await receiveSlack(options, request, raw ?? "", background);
      }
      if (
        url.pathname === SLACK_INTERACTIONS_PATH &&
        request.method === "POST"
      ) {
        return await receiveSlackAction(
          options,
          request,
          raw ?? "",
          background
        );
      }
      // The body was already read within its limit, so it is passed on as text.
      const bounded =
        raw === undefined
          ? request
          : new Request(request.url, {
              body: raw,
              headers: request.headers,
              method: request.method,
              signal: request.signal,
            });
      let prefix: "/api" | "/rpc" | "/api-reference" = "/api";
      let handler: OpenAPIHandler<Context> | RPCHandler<Context> = rest;
      if (url.pathname.startsWith("/rpc/")) {
        prefix = "/rpc";
        handler = rpc;
      } else if (url.pathname.startsWith("/api-reference")) {
        prefix = "/api-reference";
        handler = reference;
      }
      return await options.withDatabase(async (database) => {
        const user = await options.getUser(bounded, database);
        const result = await handler.handle(bounded, {
          context: {
            channels: options,
            db: database,
            session: user ? { user } : null,
          },
          prefix,
        });
        return result.matched
          ? result.response
          : json(
              { code: "not-found", message: "The route was not found." },
              404
            );
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
};
