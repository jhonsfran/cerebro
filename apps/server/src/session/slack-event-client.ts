import type { ChannelOptions } from "@cerebro/channels/types";
import { BotEventAddressSchema } from "@cerebro/contracts/bot-events";
import type { EventAddress } from "@cerebro/contracts/events";
import { Denied, Unavailable } from "@cerebro/contracts/failures";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import { ChatReceipt } from "@cerebro/contracts/session-service";
import { Schema } from "effect";

import type { WorkerEnv } from "../bindings";
import { runtimeConfiguration } from "../config";
import { signIdentityRequest, signSessionRequest } from "./proof";

const success = Schema.Struct({
  status: Schema.Literal("ok"),
  value: Schema.Unknown,
});
const reference = Schema.Struct({ eventId: Schema.NonEmptyString });

export const createSlackEventClient = (
  env: WorkerEnv
): NonNullable<ChannelOptions["slackEvents"]> => {
  const request = async (
    context: ExecutionContext,
    body: object,
    address?: EventAddress,
    sourcePath: "/slack-event" | "/legacy-slack-input" = "/slack-event"
  ): Promise<unknown> => {
    if ("delegation" in context || context.actor.state !== "active") {
      throw new Denied({
        code: "unauthorized",
        reason: "Slack events require their linked owner.",
      });
    }
    const identity = {
      organizationId: context.actor.organizationId,
      ownerPrincipalId: context.actor.id,
    };
    const text = JSON.stringify(body);
    const secret = runtimeConfiguration(env).gatewaySigningKey;
    const path = address ? sourcePath : "/slack-targets";
    const proof = address
      ? await signSessionRequest(
          address,
          context,
          sourcePath,
          text,
          secret,
          identity
        )
      : await signIdentityRequest(identity, context, text, secret);
    const stub = env.SESSION.get(
      env.SESSION.idFromName(
        JSON.stringify([identity.organizationId, identity.ownerPrincipalId])
      )
    );
    const response = await stub.fetch(
      new Request(`https://session.internal${path}`, {
        method: "POST",
        body: text,
        headers: {
          "Content-Type": "application/json",
          [address ? "x-cerebro-session-proof" : "x-cerebro-identity-proof"]:
            proof,
        },
      })
    );
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 403 || response.status === 401) {
        throw new Denied({
          code: "revoked",
          reason: "The Slack event is no longer authorized.",
        });
      }
      throw new Unavailable({
        reason: "Slack event admission is unavailable.",
      });
    }
    try {
      return Schema.decodeUnknownSync(success)(await response.json()).value;
    } catch {
      throw new Unavailable({ reason: "The Slack event response is invalid." });
    }
  };
  return {
    admitLegacy: async ({ context, address, eventKey, callback }) =>
      Schema.decodeUnknownSync(ChatReceipt)(
        await request(
          context,
          { eventKey, callback },
          address,
          "/legacy-slack-input"
        )
      ),
    discover: async ({ context, thread }) =>
      Schema.decodeUnknownSync(
        Schema.Array(BotEventAddressSchema).check(Schema.isMaxLength(18))
      )(await request(context, { thread })),
    admit: async ({ context, address, eventKey }) =>
      Schema.decodeUnknownSync(reference)(
        await request(context, { eventKey }, address)
      ),
  };
};
