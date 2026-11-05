import { registerHooks } from "node:module";

import type { PiHarness } from "agents/harness/pi";
import { Effect } from "effect";

import type { BotEvent } from "../../packages/contracts/src/bot-events.ts";
import { Denied, InvalidInput } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import { createCoordinatorEvents } from "../../packages/runtime/src/coordinator-events.ts";
import type { SessionHostConfiguration } from "../../packages/runtime/src/session-agent.ts";
import { context, setup } from "./coordinator-fixture.ts";

const hooks = registerHooks({
  resolve(specifier, importContext, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return { shortCircuit: true, url: "data:text/javascript,export {};" };
    }
    try {
      return nextResolve(specifier, importContext);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ERR_MODULE_NOT_FOUND" &&
        specifier.startsWith(".")
      ) {
        return nextResolve(`${specifier}.ts`, importContext);
      }
      throw error;
    }
  },
});
const { ConversationScope } =
  await import("../../packages/runtime/src/conversation-scope.ts");
hooks.deregister();

const settleProgress = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    return await promise;
  } catch (error) {
    return error;
  }
};

export const actor = {
  actor: {
    id: id.principal("owner-A"),
    organizationId: id.organization("org-A"),
    kind: "human" as const,
    state: "active" as const,
  },
};

export const setupWeb = async (
  team = false,
  conversationKind: "web" | "slack" = "web"
) => {
  const fixture = await setup();
  try {
    const source = fixture.source("a");
    const ready =
      Promise.withResolvers<InstanceType<typeof ConversationScope>>();
    fixture.registry().uninstall({ name: "source-a" });
    let execute = true;
    let read = true;
    let content = true;
    let deliveryAuthorization: ((event: BotEvent) => Promise<void>) | undefined;
    const progress: Promise<unknown>[] = [];
    const storage = {
      sql: {
        exec: (query: string, ...bindings: (string | number | null)[]) => {
          const rows = fixture
            .database()
            .prepare(query)
            .all(...bindings);
          return { toArray: () => rows };
        },
      },
      sync: () => Promise.resolve(),
    } as unknown as DurableObjectStorage;
    const configuration: SessionHostConfiguration = {
      address: source.address,
      conversationKind,
      ...(team ? { coordination: source.coordinator.services } : {}),
      agent: {
        organizationId: source.address.organizationId,
        agentId: source.address.agentId,
        version: 1,
        instructions: "Handle the conversation.",
        model: "fixture/test",
        enabledToolIds: [],
        grants: [],
      },
      ownerContext: () => Effect.succeed(actor),
      authority: {
        require: (request) =>
          (request.action === "read" && !read) ||
          (request.action === "execute" && request.model && !execute)
            ? Effect.fail(
                new Denied({
                  code: "revoked",
                  reason: "Fixture access revoked.",
                })
              )
            : Effect.void,
      },
      checkDependencies: (_caller, dependencies) =>
        content || dependencies.sourceIds.length === 0
          ? Effect.void
          : Effect.fail(
              new Denied({
                code: "revoked",
                reason: "Fixture content revoked.",
              })
            ),
      executor: {
        execute: () =>
          Effect.fail(
            new InvalidInput({ reason: "No connector is configured." })
          ),
      },
      audit: () => Effect.void,
      toolDependencies: () => Effect.succeed({ sourceIds: [], toolIds: [] }),
      tools: [],
      provider: {
        model: source.faux.getModel(),
        provider: source.faux.provider,
        deadlineMs: 30_000,
        maxInputBytes: 1_048_576,
        maxResponseBytes: 1_048_576,
      },
    };
    const events = createCoordinatorEvents({
      pi: fixture.pi(),
      targetIn: () =>
        Promise.resolve({ nativeId: source.native.id, agentVersion: 1 }),
      resolve: async () => {
        const scope = await ready.promise;
        const current = await scope.eventScope();
        return {
          ...current,
          authorize: async (...args) => {
            await current.authorize(...args);
            if (args[1] === undefined) {
              await deliveryAuthorization?.(args[0]);
            }
          },
        };
      },
      scan: () => Promise.resolve({ keys: [] }),
      waitUntil: (promise) => {
        progress.push(settleProgress(promise));
      },
    });
    fixture
      .registry()
      .install({ name: "fixture.bot-events", tasks: [events.definition] });
    const harness = {
      abort: async () => {
        await source.native.abort(context);
        return true;
      },
      submit: async (text: string, options: { operationId: string }) => {
        await source.native.submit(
          { type: "input", content: text, requestId: options.operationId },
          context
        );
        return {
          accepted: true,
          operationId: options.operationId,
          session: String(source.native.id),
        };
      },
    } as unknown as PiHarness;
    const scope = await ConversationScope.open(
      configuration,
      {
        events,
        scanWorkKeys: () => Promise.resolve({ keys: [] }),
        install: (extension) => fixture.registry().install(extension),
        metadata: (operation) => fixture.pi().commit(operation, context),
        pi: fixture.pi(),
        storage,
        harness,
        jobs: fixture.lifecycleJobs,
        waitUntil: (promise) => {
          progress.push(settleProgress(promise));
        },
        scheduleNotify: () => Promise.resolve(),
        search: () =>
          Promise.reject(new Error("History search was not requested.")),
      },
      async (registration) => {
        for (const extension of registration.extensions) {
          fixture.registry().install(extension);
        }
        fixture.models().setProvider(registration.provider);
        await source.native.configure(registration.agent, context);
        return source.native;
      }
    );
    ready.resolve(scope);
    await scope.restore();
    return {
      fixture,
      source,
      scope,
      events,
      setExecute: (value: boolean) => {
        execute = value;
      },
      setRead: (value: boolean) => {
        read = value;
      },
      setContent: (value: boolean) => {
        content = value;
      },
      setDeliveryAuthorization: (handler: typeof deliveryAuthorization) => {
        deliveryAuthorization = handler;
      },
      send: (operationId: string, text: string) =>
        scope.handle(
          new Request("https://session.internal/send", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ operationId, text }),
          }),
          actor
        ),
      stop: () =>
        scope.handle(
          new Request("https://session.internal/stop", { method: "POST" }),
          actor
        ),
      close: async () => {
        await fixture.close();
        await Promise.allSettled(progress);
      },
    };
  } catch (error) {
    await fixture.close();
    throw error;
  }
};
