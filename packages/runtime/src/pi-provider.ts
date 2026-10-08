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

export interface ControlledProviderConfiguration {
  readonly model: Model<Api>;
  readonly provider: Provider;
  readonly authorize: (
    options: ReadOptions
  ) => Effect.Effect<void, ContractFailure>;
  readonly deadlineMs: number;
  readonly maxInputBytes: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly beforeFetch?: (
    options: ReadOptions
  ) => Effect.Effect<void, ContractFailure>;
}

export const createControlledProvider = (
  configuration: ControlledProviderConfiguration
): Provider => {
  if (
    !Number.isSafeInteger(configuration.maxInputBytes) ||
    configuration.maxInputBytes < 1
  ) {
    throw new RangeError("A positive model input byte limit is required");
  }
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
      deadlineAt: Date.now() + configuration.deadlineMs,
      signal: signal ?? undefined,
    };
    if (configuration.beforeFetch) {
      await Effect.runPromise(configuration.beforeFetch(options), {
        signal: signal ?? undefined,
      });
    }
    await Effect.runPromise(
      configuration.authorize({
        deadlineAt: Date.now() + configuration.deadlineMs,
        signal: signal ?? undefined,
      }),
      { signal: signal ?? undefined }
    );
    return await (configuration.fetch ?? globalThis.fetch)(input, init);
  };
  const controlledStream = (
    model: Model<Api>,
    options: { readonly signal?: AbortSignal } | undefined,
    dispatch: (signal: AbortSignal) => AssistantMessageEventStream
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const signal = AbortSignal.any([
      AbortSignal.timeout(configuration.deadlineMs),
      ...(options?.signal ? [options.signal] : []),
    ]);
    const pump = async () => {
      try {
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
            deadlineAt: Date.now() + configuration.deadlineMs,
            signal,
          }),
          { signal }
        );
        const source = dispatch(signal);
        for await (const event of source) {
          stream.push(event);
        }
        stream.end(await source.result());
      } catch {
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
        stream.push({
          error,
          reason: signal.aborted ? "aborted" : "error",
          type: "error",
        });
        stream.end(error);
      }
    };
    // Vendor streaming returns synchronously; the pump contains all rejection paths.
    void pump();
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
      controlledStream(model, options, (signal) =>
        configuration.provider.stream(
          model,
          context,
          guardedOptions(options, signal) as ApiStreamOptions<A>
        )
      ),
    streamSimple: (model, context, options) =>
      controlledStream(model, options, (signal) =>
        configuration.provider.streamSimple(
          model,
          context,
          guardedOptions(options, signal)
        )
      ),
  };
};
