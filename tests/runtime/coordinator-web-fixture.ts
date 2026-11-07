/* oxlint-disable unicorn/no-await-expression-member -- Assertions read one field of freshly awaited durable state. */
import { registerHooks } from "node:module";

import type { PiHarness } from "agents/harness/pi";
import { Effect } from "effect";

import { Denied, InvalidInput } from "../../packages/contracts/src/failures.ts";
import type { Trigger } from "../../packages/contracts/src/triggers.ts";
import { configure } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { Bindings } from "../../packages/runtime/src/conversation-bindings.ts";
import { createReplies } from "../../packages/runtime/src/replies.ts";
import type { SessionHostConfiguration } from "../../packages/runtime/src/session-agent.ts";
import { createTriggers } from "../../packages/runtime/src/triggers.ts";
import { actor, context, setup } from "./coordinator-fixture.ts";
import { waitFor } from "./helpers.ts";

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

export { actor } from "./coordinator-fixture.ts";

export const setupWeb = async (
  team = false,
  refresh = false,
  customize: (
    configuration: SessionHostConfiguration
  ) => SessionHostConfiguration = (configuration) => configuration
) => {
  const fixture = await setup();
  try {
    const source = fixture.source("a");
    const ready =
      Promise.withResolvers<InstanceType<typeof ConversationScope>>();
    fixture.registry().uninstall({ name: "source-a" });
    let modelEnabled = true;
    let read = true;
    let content = true;
    let deliveryAuthorization:
      | ((trigger: Trigger) => Promise<void>)
      | undefined;
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
    const configuration: SessionHostConfiguration = customize({
      address: source.address,
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
          (request.action === "execute" && request.model && !modelEnabled)
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
    });
    let latest = configuration;
    const definitions = new Map([[1, configuration]]);
    const waitUntil = (promise: Promise<unknown>) => {
      progress.push(settleProgress(promise));
    };
    const replies = createReplies({
      pi: fixture.pi(),
      persist: () => storage.sync(),
      resolve: async () => (await ready.promise).replyScope(),
      waitUntil,
    });
    const triggers = createTriggers({
      pi: fixture.pi(),
      targetIn: async (tx) => {
        if (!refresh) {
          return { nativeId: source.native.id };
        }
        const bindings = await tx.doc(Bindings);
        const binding = bindings.conversations[source.address.sessionId];
        if (!binding) {
          throw new Error("Missing fixture binding.");
        }
        return binding;
      },
      resolve: async () => {
        const current = await (await ready.promise).triggerScope();
        return {
          ...current,
          authorize: async (trigger, caller, action, signal) => {
            await current.authorize(trigger, caller, action, signal);
            if (action === "deliver") {
              await deliveryAuthorization?.(trigger);
            }
          },
        };
      },
      scan: () => Promise.resolve({ keys: [] }),
      waitUntil,
    });
    fixture.registry().install({
      name: "fixture.replies",
      tasks: [replies.definition],
    });
    let aborts = 0;
    const harness = {
      abort: async () => {
        aborts += 1;
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
    const recoveries: string[] = [];
    const scope = await ConversationScope.open(
      configuration,
      {
        ...(refresh
          ? {
              publication: {
                identity: { agentVersion: 1 },
                resolve: (version: number | "latest") => {
                  if (
                    version === "latest" ||
                    version === latest.agent.version
                  ) {
                    return Promise.resolve(latest);
                  }
                  const saved = definitions.get(version);
                  if (saved) {
                    return Promise.resolve(saved);
                  }
                  throw new Error("The fixture definition does not exist.");
                },
                reconcile: () => Promise.resolve(),
                recover: () => {
                  recoveries.push("requested");
                },
                setProvider: (
                  value: Parameters<
                    ReturnType<typeof fixture.models>["setProvider"]
                  >[0]
                ) => fixture.models().setProvider(value),
                deleteProvider: (value: string) =>
                  fixture.models().deleteProvider(value),
                uninstall: (value: { name: string }) =>
                  fixture.registry().uninstall(value),
              },
            }
          : {}),
        triggers,
        replies,
        scanWorkKeys: () => Promise.resolve({ keys: [] }),
        install: (extension) => fixture.registry().install(extension),
        metadata: (operation) => fixture.pi().commit(operation, context),
        pi: fixture.pi(),
        storage,
        harness,
        jobs: fixture.lifecycleJobs,
        waitUntil,
      },
      async (registration) => {
        for (const extension of registration.extensions) {
          fixture.registry().install(extension);
        }
        fixture.models().setProvider(registration.provider);
        if (!refresh) {
          await source.native.configure(registration.agent, context);
          return source.native;
        }
        await fixture.pi().commit(async (tx) => {
          await configure(tx, source.native.id, registration.agent);
          const bindings = await tx.doc(Bindings);
          bindings.conversations[source.address.sessionId] = {
            address: { ...source.address },
            agentVersion: 1,
            nativeId: source.native.id,
            refresh: null,
          };
        }, context);
        return source.native;
      }
    );
    ready.resolve(scope);
    await scope.restore();
    const placement = async (triggerId: string) =>
      triggers.placement(await fixture.receipt(triggerId));
    return {
      fixture,
      configuration,
      recoveries,
      nativeAborts: () => aborts,
      publish: (value: SessionHostConfiguration) => {
        latest = value;
        definitions.set(value.agent.version, value);
      },
      source,
      scope,
      triggers,
      replies,
      placement,
      // The coordination job's drain, run until the gate opens and the backlog is empty.
      drain: () =>
        waitFor(
          () => triggers.drain(source.native.id),
          (state) => state === "idle",
          10_000,
          20
        ),
      settled: (triggerId: string) =>
        waitFor(
          () => placement(triggerId),
          (value) =>
            ["done", "unanswered", "withdrawn", "local-answer"].includes(
              value.kind
            ),
          10_000,
          10
        ),
      setModelEnabled: (value: boolean) => {
        modelEnabled = value;
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
