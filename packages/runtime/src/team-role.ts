import { Denied, toContractFailure } from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import type { ContentDependencies } from "@cerebro/contracts/session";
import { BoundedContentDependenciesSchema } from "@cerebro/contracts/work";
import type { WorkAdmission } from "@cerebro/contracts/work";
import { isInternalToolName } from "@cerebro/tools/tool-names";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import type {
  Harness,
  Registry,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { Effect, Result, Schema } from "effect";

import { conversationProvider } from "./conversation-provider.ts";
import { createConversationResources } from "./conversation-resources.ts";
import { piContext } from "./pi-harness.ts";
import { createRunLimits } from "./run-limits.ts";
import type {
  MetadataTransaction,
  SessionHostConfiguration,
} from "./session-agent.ts";
import { TeamState, requireTeamRunning } from "./team-state.ts";

const run = async <A>(
  program: Effect.Effect<A, ContractFailure>
): Promise<A> => {
  const result = await Effect.runPromise(Effect.result(program));
  if (Result.isFailure(result)) {
    throw result.failure;
  }
  return result.success;
};

export interface TeamRoleConfiguration extends SessionHostConfiguration {
  readonly contentDependencies: () => Promise<ContentDependencies>;
  readonly importDependencies: (dependencies: ContentDependencies) => void;
}

export const createTeamRole = (options: {
  readonly work: WorkAdmission;
  readonly configuration: TeamRoleConfiguration;
  readonly pi: Harness;
  readonly storage: DurableObjectStorage;
  readonly metadata: MetadataTransaction;
  readonly models: MutableModels;
  readonly registry: Registry;
  readonly now: () => number;
}) => {
  const { pi, configuration, now } = options;
  const checkRunning = () =>
    Effect.tryPromise({
      catch: (error) => toContractFailure(error, "The team is unavailable."),
      try: async () => {
        const state = await pi.snapshot(TeamState, piContext());
        if (!state) {
          throw new Denied({
            code: "revoked",
            reason: "The team has no admission.",
          });
        }
        requireTeamRunning(state, now());
      },
    });
  const reserveModelCall = () =>
    Effect.tryPromise({
      catch: (error) =>
        toContractFailure(error, "The team model budget is unavailable."),
      try: async () => {
        await pi.commit(async (tx) => {
          const state = await tx.doc(TeamState);
          const work = requireTeamRunning(state, now());
          if (state.modelCalls >= work.limits.maxTurns) {
            throw new Denied({
              code: "revoked",
              reason: "The team model call limit was reached.",
            });
          }
          state.modelCalls += 1;
        }, piContext());
        await options.storage.sync();
      },
    });
  const configured: TeamRoleConfiguration = {
    ...configuration,
    tools: configuration.tools.filter(
      (tool) =>
        tool.definition.effect === "read" &&
        !tool.requiresApproval &&
        !isInternalToolName(tool.definition.id)
    ),
    provider: {
      ...configuration.provider,
      deadlineAt: options.work.deadlineAt,
      beforeFetch: (readOptions) =>
        Effect.gen(function* teamDispatch() {
          if (configuration.provider.beforeFetch) {
            yield* configuration.provider.beforeFetch(readOptions);
          }
          yield* reserveModelCall();
        }),
    },
    checkDependencies: (context, dependencies, readOptions) =>
      Effect.gen(function* teamDependencies() {
        yield* checkRunning();
        yield* configuration.checkDependencies(
          context,
          dependencies,
          readOptions
        );
      }),
  };
  const resources = createConversationResources(
    configured,
    options.storage,
    options.metadata
  );
  const provider = conversationProvider(
    configuration.address.sessionId,
    configuration.provider.model,
    resources.provider
  );
  options.models.setProvider(provider);
  const extensionName = `cerebro-team-tools:${configuration.address.sessionId}`;
  const install = (extraTools: readonly ToolRegistration[] = []) => {
    const extension = {
      name: extensionName,
      tools: [...resources.tools, ...extraTools],
      hooks: createRunLimits({ pi }),
    };
    options.registry.install(extension);
    return {
      extensions: [extension],
      instructions: configuration.agent.instructions,
      model: {
        modelId: configuration.provider.model.id,
        provider: provider.id,
      },
    };
  };
  return {
    configuration: configured,
    resources,
    install,
    dependencies: async () =>
      Schema.decodeUnknownSync(BoundedContentDependenciesSchema)(
        await configured.contentDependencies()
      ),
    admitDependencies: async (
      dependencies: Parameters<
        SessionHostConfiguration["checkDependencies"]
      >[1],
      signal?: AbortSignal
    ) => {
      const context = await run(configuration.ownerContext());
      const readOptions = {
        deadlineAt: Math.min(now() + 30_000, options.work.deadlineAt),
        signal,
      };
      await run(
        configuration.authority.require(
          {
            action: "execute",
            address: configuration.address,
            context,
            model: configuration.agent.model,
            pinnedAgent: configuration.agent,
            resource: {
              kind: "agent",
              id: configuration.agent.agentId,
              organizationId: configuration.address.organizationId,
            },
          },
          readOptions
        )
      );
      await run(
        configuration.checkDependencies(context, dependencies, readOptions)
      );
    },
    permit: async (
      dependencies: Parameters<
        SessionHostConfiguration["checkDependencies"]
      >[1],
      signal?: AbortSignal
    ) => {
      const context = await run(configured.ownerContext());
      await resources.authorize(context, "send", signal);
      await run(
        configured.checkDependencies(context, dependencies, {
          deadlineAt: Math.min(now() + 30_000, options.work.deadlineAt),
          signal,
        })
      );
    },
  };
};
export type TeamRole = ReturnType<typeof createTeamRole>;
