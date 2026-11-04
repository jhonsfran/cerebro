import { Unavailable } from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type { ReadOptions } from "@cerebro/contracts/port";
import { Effect, Result } from "effect";

import { createApprovalStore } from "./approval-store.ts";
import { createControlledProvider } from "./pi-provider.ts";
import { createPiTools } from "./pi-tools.ts";
import type {
  MetadataTransaction,
  SessionHostConfiguration,
} from "./session-agent.ts";

const options = (signal?: AbortSignal): ReadOptions => ({
  deadlineAt: Date.now() + 30_000,
  signal,
});
const run = async <A>(
  program: Effect.Effect<A, ContractFailure>
): Promise<A> => {
  const result = await Effect.runPromise(Effect.result(program));
  if (Result.isFailure(result)) {
    throw result.failure;
  }
  return result.success;
};
type ChatOperation =
  | "read"
  | "send"
  | "stop"
  | "allow"
  | "deny"
  | "coordinate"
  | "transfer";
const operationAction = {
  allow: "approve",
  deny: "approve",
  read: "read",
  send: "execute",
  stop: "execute",
  coordinate: "execute",
  transfer: "execute",
} as const;

export const createConversationResources = (
  configuration: SessionHostConfiguration,
  storage: DurableObjectStorage,
  metadata: MetadataTransaction
) => {
  const approvals = createApprovalStore(
    storage,
    configuration.address.sessionId
  );
  const authorize = async (
    context: ExecutionContext,
    operation: ChatOperation,
    signal?: AbortSignal,
    toolIds: readonly string[] = []
  ): Promise<void> => {
    await run(
      configuration.authority.require(
        {
          action: operationAction[operation],
          address: configuration.address,
          context,
          model: operation === "send" ? configuration.agent.model : undefined,
          pinnedAgent: configuration.agent,
          resource: {
            id: configuration.agent.agentId,
            kind: "agent",
            organizationId: configuration.address.organizationId,
          },
        },
        options(signal)
      )
    );
    if (operation === "coordinate" || operation === "transfer") {
      await run(
        configuration.authority.require(
          {
            action: "read",
            address: configuration.address,
            context,
            pinnedAgent: configuration.agent,
            resource: {
              id: configuration.agent.agentId,
              kind: "agent",
              organizationId: configuration.address.organizationId,
            },
          },
          options(signal)
        )
      );
    }
    if (
      operation === "read" ||
      operation === "send" ||
      operation === "allow" ||
      operation === "transfer"
    ) {
      await run(
        configuration.checkDependencies(
          context,
          { sourceIds: [], toolIds },
          options(signal)
        )
      );
    }
  };
  const provider = createControlledProvider({
    ...configuration.provider,
    ...(configuration.prepareInput
      ? {
          prepareContext: (context, readOptions) =>
            Effect.gen(function* prepareCurrentContext() {
              const { prepareInput } = configuration;
              if (!prepareInput) {
                return context;
              }
              const index = context.messages.findLastIndex(
                (message) => message.role === "user"
              );
              const message = context.messages[index];
              if (message?.role !== "user") {
                return context;
              }
              const inputText =
                typeof message.content === "string"
                  ? message.content
                  : message.content
                      .filter((block) => block.type === "text")
                      .map((block) => block.text)
                      .join("");
              if (!inputText) {
                return context;
              }
              const owner = yield* configuration.ownerContext();
              const text = yield* prepareInput(inputText, owner);
              if (readOptions.signal?.aborted) {
                return yield* Effect.fail(
                  new Unavailable({
                    reason: "Model context preparation was interrupted.",
                  })
                );
              }
              return {
                ...context,
                messages: context.messages.map((value, position) =>
                  position === index ? { ...message, content: text } : value
                ),
              };
            }),
        }
      : {}),
    authorize: (readOptions) =>
      Effect.gen(function* currentModelAuthority() {
        const context = yield* configuration.ownerContext();
        yield* configuration.authority.require(
          {
            action: "execute",
            address: configuration.address,
            context,
            model: configuration.agent.model,
            pinnedAgent: configuration.agent,
            resource: {
              id: configuration.agent.agentId,
              kind: "agent",
              organizationId: configuration.address.organizationId,
            },
          },
          readOptions
        );
        yield* configuration.checkDependencies(
          context,
          { sourceIds: [], toolIds: [] },
          readOptions
        );
      }),
  });
  const tools = createPiTools({
    address: configuration.address,
    agent: configuration.agent,
    approvals,
    audit: configuration.audit,
    authority: configuration.authority,
    checkDependencies: configuration.checkDependencies,
    deadlineMs: configuration.provider.deadlineMs,
    deadlineAt: configuration.provider.deadlineAt,
    dependencies: configuration.toolDependencies,
    executor: configuration.executor,
    metadata,
    ownerContext: configuration.ownerContext,
    persist: () =>
      Effect.tryPromise({
        catch: () =>
          new Unavailable({ reason: "Native tool dispatch flush failed." }),
        try: () => storage.sync(),
      }),
    tools: configuration.tools,
  });
  return { approvals, authorize, configuration, provider, tools };
};
