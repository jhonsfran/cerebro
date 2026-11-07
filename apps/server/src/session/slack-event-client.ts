import type { ChannelOptions } from "@cerebro/channels/types";
import type { EventAddress } from "@cerebro/contracts/events";
import { Denied, Unavailable } from "@cerebro/contracts/failures";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import { EventAddressSchema } from "@cerebro/contracts/work";
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
    address?: EventAddress
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
    const path = address ? "/slack-event" : "/slack-targets";
    const proof = address
      ? await signSessionRequest(
          address,
          context,
          "/slack-event",
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
    discover: async ({ context, thread }) =>
      Schema.decodeUnknownSync(
        Schema.Array(EventAddressSchema).check(Schema.isMaxLength(18))
      )(await request(context, { thread })),
    admit: async ({ context, address, eventKey }) =>
      Schema.decodeUnknownSync(reference)(
        await request(context, { eventKey }, address)
      ),
  };
};
