/* oxlint-disable no-await-in-loop -- The provider stream preserves the vendor event order. */
import { Denied, InvalidInput } from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import type { ReadOptions } from "@cerebro/contracts/port";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  Api,
  ApiStreamOptions,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";
import { Effect } from "effect";

import { boundedModelResponse } from "./model-response.ts";

export interface ControlledProviderConfiguration {
  readonly model: Model<Api>;
  readonly provider: Provider;
  readonly authorize: (
    options: ReadOptions
  ) => Effect.Effect<void, ContractFailure>;
  readonly prepareContext?: (
    context: TranscriptContext,
    options: ReadOptions
  ) => Effect.Effect<TranscriptContext, ContractFailure>;
  readonly deadlineMs: number;
  readonly deadlineAt?: number;
  readonly maxInputBytes: number;
  readonly maxResponseBytes: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly beforeFetch?: (
    options: ReadOptions
  ) => Effect.Effect<void, ContractFailure>;
}

export const createControlledProvider = (
  configuration: ControlledProviderConfiguration
): Provider => {
  const deadline = () =>
    Math.min(
      Date.now() + configuration.deadlineMs,
      configuration.deadlineAt ?? Number.MAX_SAFE_INTEGER
    );
  const requireDispatch = (signal?: AbortSignal | null): void => {
    signal?.throwIfAborted();
    if (
      configuration.deadlineAt !== undefined &&
      configuration.deadlineAt <= Date.now()
    ) {
      throw new Denied({
        code: "revoked",
        reason: "The model execution deadline expired.",
      });
    }
  };
  if (
    [configuration.maxInputBytes, configuration.maxResponseBytes].some(
      (limit) => !Number.isSafeInteger(limit) || limit < 1
    )
  ) {
    throw new RangeError(
      "Positive model input and response byte limits are required"
    );
  }
  const runGuard = async (
    guard: ControlledProviderConfiguration["beforeFetch"],
    options: ReadOptions
  ): Promise<void> => {
    if (guard) {
      await Effect.runPromise(guard(options), { signal: options.signal });
    }
  };
  const physicalFetch: typeof globalThis.fetch = async (input, init) => {
    const body = init?.body;
    if (
      (body !== undefined && body !== null && typeof body !== "string") ||
      ((body === undefined || body === null) &&
        input instanceof Request &&
        input.body !== null)
    ) {
      throw new InvalidInput({
        reason: "Controlled model requests require a serialized body",
      });
    }
    if (
      typeof body === "string" &&
      new TextEncoder().encode(body).byteLength > configuration.maxInputBytes
    ) {
      throw new InvalidInput({
        reason: "Model input exceeds the configured byte limit",
      });
    }
    const signal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const options = {
      deadlineAt: deadline(),
      signal: signal ?? undefined,
    };
    requireDispatch(signal);
    await runGuard(configuration.beforeFetch, options);
    await Effect.runPromise(
      configuration.authorize({
        deadlineAt: deadline(),
        signal: signal ?? undefined,
      }),
      { signal: signal ?? undefined }
    );
    requireDispatch(signal);
    const response = await (configuration.fetch ?? globalThis.fetch)(
      input,
      init
    );
    return boundedModelResponse(response, configuration.maxResponseBytes);
  };
  const controlledStream = (
    model: Model<Api>,
    context: TranscriptContext,
    options: { readonly signal?: AbortSignal } | undefined,
    dispatch: (
      context: TranscriptContext,
      signal: AbortSignal
    ) => AssistantMessageEventStream
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const signal = AbortSignal.any([
      AbortSignal.timeout(Math.max(0, deadline() - Date.now())),
      ...(options?.signal ? [options.signal] : []),
    ]);
    let source: AssistantMessageEventStream | undefined;
    const fail = () => {
      const error: AssistantMessage = {
        api: model.api,
        content: [],
        errorMessage: "Controlled model request failed or was denied",
        model: model.id,
        provider: model.provider,
        role: "assistant",
        stopReason: signal.aborted ? "aborted" : "error",
        timestamp: Date.now(),
        usage: {
          cacheRead: 0,
          cacheWrite: 0,
          cost: {
            cacheRead: 0,
            cacheWrite: 0,
            input: 0,
            output: 0,
            total: 0,
          },
          input: 0,
          output: 0,
          totalTokens: 0,
        },
      };
      source?.end(error);
      stream.push({
        error,
        reason: signal.aborted ? "aborted" : "error",
        type: "error",
      });
      stream.end(error);
    };
    const onAbort = () => fail();
    signal.addEventListener("abort", onAbort, { once: true });
    const pump = async () => {
      try {
        requireDispatch(signal);
        if (
          model.id !== configuration.model.id ||
          model.provider !== configuration.model.provider
        ) {
          throw new Denied({
            code: "unauthorized",
            reason: "Model is not pinned",
          });
        }
        await Effect.runPromise(
          configuration.authorize({
            deadlineAt: deadline(),
            signal,
          }),
          { signal }
        );
        const prepared = configuration.prepareContext
          ? await Effect.runPromise(
              configuration.prepareContext(context, {
                deadlineAt: deadline(),
                signal,
              }),
              { signal }
            )
          : context;
        signal.throwIfAborted();
        requireDispatch(signal);
        source = dispatch(prepared, signal);
        for await (const event of source) {
          stream.push(event);
        }
        stream.end(await source.result());
      } catch {
        fail();
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    };
    // Vendor streaming returns synchronously; the pump contains all rejection paths.
    if (signal.aborted) {
      fail();
      signal.removeEventListener("abort", onAbort);
    } else {
      void pump();
    }
    return stream;
  };
  const guardedOptions = <Options extends { readonly signal?: AbortSignal }>(
    options: Options | undefined,
    signal: AbortSignal
  ) => ({
    ...options,
    fetch: physicalFetch,
    maxRetries: 0,
    signal,
    timeoutMs: configuration.deadlineMs,
    transport: "sse" as const,
  });
  return {
    auth: configuration.provider.auth,
    getModels: () => [configuration.model],
    id: configuration.provider.id,
    name: configuration.provider.name,
    stream: <A extends Api>(
      model: Model<A>,
      context: TranscriptContext,
      options?: ApiStreamOptions<A>
    ) =>
      controlledStream(model, context, options, (prepared, signal) =>
        configuration.provider.stream(
          model,
          prepared,
          guardedOptions(options, signal) as ApiStreamOptions<A>
        )
      ),
    streamSimple: (model, context, options) =>
      controlledStream(model, context, options, (prepared, signal) =>
        configuration.provider.streamSimple(
          model,
          prepared,
          guardedOptions(options, signal)
        )
      ),
  };
};
