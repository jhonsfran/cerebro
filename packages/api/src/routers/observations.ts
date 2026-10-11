import { createChannelService } from "@cerebro/channels/service";
import { ChannelError } from "@cerebro/channels/types";
import type { ProductHandlerOptions } from "@cerebro/channels/types";
import { Denied } from "@cerebro/contracts/failures";

import {
  guardedObservation,
  OBSERVATION_CONTENT_TYPE,
} from "../observation-delivery";

const unavailable = () =>
  new ChannelError(503, "unavailable", "Observation is unavailable.");

const openSession = async (
  options: ProductHandlerOptions,
  input: Parameters<
    NonNullable<ProductHandlerOptions["observationResponse"]>
  >[0]
): Promise<Response> => {
  if (!options.observationResponse) {
    throw unavailable();
  }
  try {
    return await options.observationResponse(input);
  } catch (error) {
    const cause = error instanceof Error ? (error.cause ?? error) : error;
    if (cause instanceof Denied) {
      throw new ChannelError(403, "forbidden", cause.reason);
    }
    throw unavailable();
  }
};

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
    return { ...access, userId: user.id };
  });
  const authorize = async () => {
    await options.withDatabase(async (database) => {
      const current = await options.getUser(request, database);
      if (!current || current.id !== attachment.userId) {
        throw new ChannelError(
          401,
          "unauthorized",
          "Authentication was revoked."
        );
      }
      await createChannelService(database, options).conversationAccess(
        current.id,
        conversationId
      );
    });
  };
  const session = await openSession(options, {
    accessGeneration: generation,
    address: attachment.address,
    context: attachment.context,
    signal: request.signal,
  });
  if (
    !session.body ||
    !session.headers.get("Content-Type")?.startsWith(OBSERVATION_CONTENT_TYPE)
  ) {
    await session.body?.cancel();
    throw unavailable();
  }
  return new Response(
    guardedObservation({
      accessGeneration: generation,
      address: attachment.address,
      authorize,
      body: session.body,
    }),
    {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": OBSERVATION_CONTENT_TYPE,
      },
    }
  );
};
