import {
  ObservationTransport,
  observationTransportLayer,
} from "@cerebro/ag-ui/authorized-observation";
import { createChannelService } from "@cerebro/channels/service";
import { ChannelError } from "@cerebro/channels/types";
import type { ProductHandlerOptions } from "@cerebro/channels/types";
import { Denied, Unavailable } from "@cerebro/contracts/failures";
import { Effect } from "effect";

export const observeConversation = async (
  request: Request,
  options: ProductHandlerOptions,
  conversationId: string
): Promise<Response> => {
  const raw = new URL(request.url).searchParams.get("accessGeneration");
  const generation = Number(raw);
  if (raw === null || !Number.isSafeInteger(generation) || generation < 0) {
    throw new ChannelError(
      422,
      "invalid-input",
      "The access generation is invalid."
    );
  }
  const attachment = await options.withDatabase(async (database) => {
    const user = await options.getUser(request, database);
    if (!user) {
      throw new ChannelError(401, "unauthorized", "Sign in to continue.");
    }
    const access = await createChannelService(database, options).chatAccess(
      user.id,
      conversationId
    );
    const sessions = options.sessions?.(database);
    if (!sessions) {
      throw new ChannelError(503, "unavailable", "Observation is unavailable.");
    }
    return { ...access, sessions, userId: user.id };
  });
  const authorize = Effect.tryPromise({
    catch: (error) => {
      if (
        error instanceof Denied ||
        (error instanceof ChannelError && [401, 403].includes(error.status))
      ) {
        return new Denied({
          code: "revoked",
          reason: "Conversation access is no longer available.",
        });
      }
      return new Unavailable({
        reason: "Current access could not be verified.",
      });
    },
    try: async () => {
      const startedAt = performance.now();
      try {
        await options.withDatabase(async (database) => {
          const current = await options.getUser(request, database);
          if (!current || current.id !== attachment.userId) {
            throw new Denied({
              code: "revoked",
              reason: "Authentication was revoked",
            });
          }
          await createChannelService(database, options).chatAccess(
            current.id,
            conversationId
          );
        });
      } finally {
        options.recordAdapterTime?.({
          adapter: "permission",
          durationMs: performance.now() - startedAt,
          resourceId: conversationId,
        });
      }
    },
  });
  const source = attachment.sessions.stream(
    attachment.address,
    attachment.context,
    { accessGeneration: generation },
    { deadlineAt: Number.MAX_SAFE_INTEGER, signal: request.signal }
  );
  return await Effect.runPromise(
    Effect.gen(function* response() {
      const transport = yield* ObservationTransport;
      return transport.response({
        accessGeneration: generation,
        address: attachment.address,
        authorize,
        source,
      });
    }).pipe(Effect.provide(observationTransportLayer))
  );
};
