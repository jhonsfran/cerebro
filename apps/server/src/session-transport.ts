import type { EventAddress } from "@cerebro/contracts/events";
import {
  Conflict,
  Denied,
  InvalidInput,
  NotFound,
  Unavailable,
  UnknownOutcome,
} from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import { id } from "@cerebro/contracts/identity";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type { EffectOptions, ReadOptions } from "@cerebro/contracts/port";
import { DomainSnapshot } from "@cerebro/contracts/session-service";
import type { SessionService } from "@cerebro/contracts/session-service";
import { digestToolArguments } from "@cerebro/contracts/tools";
import { Effect, Schema, Stream } from "effect";
import { z } from "zod";

import { sessionName } from "../../../packages/runtime/src/event-handler";
import {
  attempt,
  checkOptions,
  waitForCaller,
} from "../../../packages/runtime/src/runtime-ports.ts";
import type { WorkerEnv } from "./env.server";
import { readObservationStream } from "./observation-stream";
import { runtimeConfiguration } from "./runtime-services";
import { signSessionRequest } from "./session-proof.ts";

const identifier = z.string().trim().min(1).max(512);
const receiptSchema = z.strictObject({
  acceptedEventId: identifier.transform(id.event),
  replayed: z.boolean(),
  runId: identifier.transform(id.run),
  sessionId: identifier.transform(id.session),
});
const runSchema = z.union([
  z.strictObject({
    runId: identifier.transform(id.run),
    state: z.enum(["queued", "running", "waiting-for-approval"]),
  }),
  z.strictObject({
    completedAt: z.number(),
    runId: identifier.transform(id.run),
    state: z.literal("completed"),
  }),
  z.strictObject({
    endedAt: z.number(),
    runId: identifier.transform(id.run),
    state: z.enum(["failed", "cancelled"]),
  }),
]);

const readOptions = async (
  address: EventAddress,
  options: ReadOptions
): Promise<EffectOptions> => ({
  deadlineAt: options.deadlineAt,
  operationId: id.operation(`read:${crypto.randomUUID()}`),
  requestDigest: await digestToolArguments(address),
});

const responseFailure = (
  value: unknown,
  options: ReadOptions
): ContractFailure => {
  const failure = z
    .object({ error: z.string(), message: z.string() })
    .safeParse(value);
  if (!failure.success) {
    return new Unavailable({ reason: "Invalid session failure response." });
  }
  switch (failure.data.error) {
    case "Denied": {
      return new Denied({ code: "unauthorized", reason: failure.data.message });
    }
    case "InvalidInput": {
      return new InvalidInput({ reason: failure.data.message });
    }
    case "Conflict": {
      return new Conflict({
        code: "digest-mismatch",
        reason: failure.data.message,
      });
    }
    case "NotFound": {
      return new NotFound({ resource: failure.data.message });
    }
    case "UnknownOutcome": {
      return "operationId" in options && typeof options.operationId === "string"
        ? new UnknownOutcome({
            operationId: id.operation(options.operationId),
            reason: failure.data.message,
          })
        : new Unavailable({ reason: failure.data.message });
    }
    default: {
      return new Unavailable({ reason: "The session is unavailable." });
    }
  }
};

export const createSessionClient = (env: WorkerEnv) => {
  const request = (
    address: EventAddress,
    context: ExecutionContext,
    path: "/submit" | "/inspect" | "/stream" | "/approve" | "/cancel",
    body: Readonly<Record<string, unknown>>,
    options: ReadOptions
  ) =>
    waitForCaller(
      Effect.gen(function* boundedRequest() {
        yield* attempt(() => checkOptions(options));
        return yield* Effect.tryPromise({
          catch: () =>
            new Unavailable({
              reason: "The session transport is unavailable.",
            }),
          try: async (signal) => {
            const text = JSON.stringify(body);
            const proof = await signSessionRequest(
              address,
              context,
              path,
              text,
              runtimeConfiguration(env).gatewaySigningKey
            );
            const stub = env.SESSION.get(
              env.SESSION.idFromName(sessionName(address))
            );
            return await stub.fetch(
              new Request(`https://session.internal${path}`, {
                body: text,
                headers: {
                  "Content-Type": "application/json",
                  "x-cerebro-session-proof": proof,
                },
                method: "POST",
                signal: options.signal
                  ? AbortSignal.any([signal, options.signal])
                  : signal,
              })
            );
          },
        });
      }),
      options
    );
  const invoke = <A>(
    address: EventAddress,
    context: ExecutionContext,
    path: "/submit" | "/inspect" | "/stream" | "/approve" | "/cancel",
    body: Readonly<Record<string, unknown>>,
    options: ReadOptions,
    decode: (value: unknown) => A
  ): Effect.Effect<A, ContractFailure> =>
    waitForCaller(
      Effect.gen(function* invokeSession() {
        const response = yield* request(address, context, path, body, options);
        const value = yield* Effect.tryPromise({
          catch: () => new Unavailable({ reason: "Invalid session response." }),
          try: () => response.json(),
        });
        if (!response.ok) {
          return yield* Effect.fail(responseFailure(value, options));
        }
        return yield* Effect.try({
          catch: () => new Unavailable({ reason: "Invalid session response." }),
          try: () =>
            decode(
              z
                .object({ status: z.literal("ok"), value: z.unknown() })
                .parse(value).value
            ),
        });
      }),
      options
    );
  const service: SessionService = {
    approve: (command, options) =>
      invoke(
        command.address,
        command.context,
        "/approve",
        { command, options },
        options,
        (value) => runSchema.parse(value)
      ),
    cancel: (command, options) =>
      invoke(
        command.address,
        command.context,
        "/cancel",
        { command, options },
        options,
        (value) => runSchema.parse(value)
      ),
    inspect: (address, context, options) =>
      Effect.gen(function* inspect() {
        const wireOptions = yield* Effect.promise(() =>
          readOptions(address, options)
        );
        return yield* invoke(
          address,
          context,
          "/inspect",
          { options: wireOptions },
          options,
          Schema.decodeUnknownSync(DomainSnapshot)
        );
      }),
    stream: (address, context, observation, options) =>
      Stream.unwrap(
        waitForCaller(
          Effect.gen(function* observe() {
            const wireOptions = yield* Effect.promise(() =>
              readOptions(address, options)
            );
            const response = yield* request(
              address,
              context,
              "/stream",
              { ...observation, options: wireOptions },
              options
            );
            if (!response.ok) {
              const failure = yield* Effect.tryPromise({
                catch: () =>
                  new Unavailable({
                    reason: "Invalid observation failure response.",
                  }),
                try: () => response.json(),
              });
              return yield* Effect.fail(responseFailure(failure, options));
            }
            if (!response.body) {
              return yield* Effect.fail(
                new Unavailable({ reason: "Observation response has no body." })
              );
            }
            return readObservationStream(response.body);
          }),
          options
        )
      ),
    submit: (command, options) =>
      invoke(
        command.event,
        command.event.context,
        "/submit",
        { command, options },
        options,
        (value) => receiptSchema.parse(value)
      ),
  };
  return {
    ...service,
    // The raw session response is forwarded to the browser without re-encoding.
    observationResponse: (
      address: EventAddress,
      context: ExecutionContext,
      accessGeneration: number,
      options: ReadOptions
    ): Effect.Effect<Response, ContractFailure> =>
      Effect.gen(function* openObservation() {
        const wireOptions = yield* Effect.promise(() =>
          readOptions(address, options)
        );
        const response = yield* request(
          address,
          context,
          "/stream",
          { accessGeneration, options: wireOptions },
          options
        );
        if (!response.ok) {
          const failure = yield* Effect.tryPromise({
            catch: () =>
              new Unavailable({
                reason: "Invalid observation failure response.",
              }),
            try: () => response.json(),
          });
          return yield* Effect.fail(responseFailure(failure, options));
        }
        return response;
      }),
  };
};
