import type { EventAddress } from "@cerebro/contracts/events";
import {
  Conflict,
  Denied,
  InvalidInput,
  NotFound,
  Unavailable,
  UnknownOutcome,
  toContractFailure,
} from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import { id } from "@cerebro/contracts/identity";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import {
  ChatDecisionReceipt,
  ChatControlReceipt,
  ChatForkReceipt,
  ChatReceipt,
  ChatSnapshot,
} from "@cerebro/contracts/session-service";
import type { ChatClient } from "@cerebro/contracts/session-service";
import { withDatabase } from "@cerebro/db";
import { channelConversation } from "@cerebro/db/schema/agents";
import { and, eq, isNull } from "drizzle-orm";
import { Schema } from "effect";
import { z } from "zod";

import type { WorkerEnv } from "../bindings";
import { runtimeConfiguration } from "../config";
import { signSessionRequest } from "./proof";

type SessionPath =
  | "/send"
  | "/read"
  | "/observe"
  | "/decide"
  | "/stop"
  | "/control"
  | "/fork";
const responseSchema = z.object({
  status: z.literal("ok"),
  value: z.unknown(),
});
const stopSchema = z.strictObject({ stopped: z.boolean() });
const failureSchema = z.object({ error: z.string(), message: z.string() });

const responseFailure = (
  value: unknown,
  operationId?: string
): ContractFailure => {
  const failure = failureSchema.safeParse(value);
  if (!failure.success) {
    return new Unavailable({ reason: "Invalid session failure response." });
  }
  const reason = failure.data.message;
  switch (failure.data.error) {
    case "Denied": {
      return new Denied({ code: "unauthorized", reason });
    }
    case "InvalidInput": {
      return new InvalidInput({ reason });
    }
    case "Conflict": {
      return new Conflict({ code: "digest-mismatch", reason });
    }
    case "NotFound": {
      return new NotFound({ resource: reason });
    }
    case "UnknownOutcome": {
      return operationId
        ? new UnknownOutcome({ operationId: id.operation(operationId), reason })
        : new Unavailable({ reason });
    }
    default: {
      return new Unavailable({ reason: "The session is unavailable." });
    }
  }
};

export const createSessionClient = (env: WorkerEnv): ChatClient => {
  const request = async (input: {
    readonly address: EventAddress;
    readonly context: ExecutionContext;
    readonly path: SessionPath;
    readonly body: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  }): Promise<Response> => {
    try {
      const text = JSON.stringify(input.body);
      const [conversation] = await withDatabase(env, (database) =>
        database
          .select()
          .from(channelConversation)
          .where(
            and(
              eq(
                channelConversation.organizationId,
                input.address.organizationId
              ),
              eq(channelConversation.agentId, input.address.agentId),
              eq(
                channelConversation.conversationId,
                input.address.conversationId
              ),
              eq(channelConversation.sessionId, input.address.sessionId),
              eq(channelConversation.engine, "pi-identity-v1"),
              isNull(channelConversation.retiredAt)
            )
          )
      );
      if (!conversation) {
        throw new Denied({
          code: "unauthorized",
          reason: "The conversation is retired or unavailable.",
        });
      }
      const identity = {
        organizationId: id.organization(conversation.organizationId),
        ownerPrincipalId: id.principal(conversation.ownerPrincipalId),
      };
      const proof = await signSessionRequest(
        input.address,
        input.context,
        input.path,
        text,
        runtimeConfiguration(env).gatewaySigningKey,
        identity
      );
      const name = JSON.stringify([
        identity.organizationId,
        identity.ownerPrincipalId,
      ]);
      const stub = env.SESSION.get(env.SESSION.idFromName(name));
      return await stub.fetch(
        new Request(`https://session.internal${input.path}`, {
          body: text,
          headers: {
            "Content-Type": "application/json",
            "x-cerebro-session-proof": proof,
          },
          method: "POST",
          signal: input.signal,
        })
      );
    } catch (error) {
      throw toContractFailure(error, "The session transport is unavailable.");
    }
  };
  const invoke = async <Value>(
    input: Parameters<typeof request>[0],
    decode: (value: unknown) => Value,
    operationId?: string
  ): Promise<Value> => {
    const response = await request(input);
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new Unavailable({ reason: "Invalid session response." });
    }
    if (!response.ok) {
      throw responseFailure(value, operationId);
    }
    try {
      return decode(responseSchema.parse(value).value);
    } catch {
      throw new Unavailable({ reason: "Invalid session response." });
    }
  };
  return {
    control: ({ command, ...input }) =>
      invoke(
        { ...input, body: { command }, path: "/control" },
        Schema.decodeUnknownSync(ChatControlReceipt),
        "operationId" in command ? command.operationId : undefined
      ),
    fork: ({ destination, entryId, operationId, ...input }) =>
      invoke(
        {
          ...input,
          body: { destination, entryId, operationId },
          path: "/fork",
        },
        Schema.decodeUnknownSync(ChatForkReceipt),
        operationId
      ),
    decide: ({ approvalId, decision, ...input }) =>
      invoke(
        { ...input, body: { approvalId, decision }, path: "/decide" },
        Schema.decodeUnknownSync(ChatDecisionReceipt)
      ),
    observe: async (input) => {
      const response = await request({ ...input, body: {}, path: "/observe" });
      if (!response.ok) {
        let value: unknown;
        try {
          value = await response.json();
        } catch {
          throw new Unavailable({ reason: "Invalid session response." });
        }
        throw responseFailure(value);
      }
      return response;
    },
    read: (input) =>
      invoke(
        { ...input, body: {}, path: "/read" },
        Schema.decodeUnknownSync(ChatSnapshot)
      ),
    send: ({ operationId, text, ...input }) =>
      invoke(
        { ...input, body: { operationId, text }, path: "/send" },
        Schema.decodeUnknownSync(ChatReceipt),
        operationId
      ),
    stop: (input) =>
      invoke({ ...input, body: {}, path: "/stop" }, (value) =>
        stopSchema.parse(value)
      ),
  };
};
