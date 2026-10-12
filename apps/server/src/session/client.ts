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
  ChatReceipt,
  ChatSnapshot,
} from "@cerebro/contracts/session-service";
import type { ChatClient } from "@cerebro/contracts/session-service";
import { Schema } from "effect";
import { z } from "zod";

import type { WorkerEnv } from "../bindings";
import { runtimeConfiguration } from "../config";
import { signSessionRequest } from "./proof";

type SessionPath = "/send" | "/read" | "/observe" | "/decide" | "/stop";
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
      const proof = await signSessionRequest(
        input.address,
        input.context,
        input.path,
        text,
        runtimeConfiguration(env).gatewaySigningKey
      );
      const { organizationId, agentId, conversationId } = input.address;
      const name = JSON.stringify([organizationId, agentId, conversationId]);
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
