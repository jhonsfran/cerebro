import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

import { Effect, Schema } from "effect";

import { ChannelError } from "../../packages/channels/src/types.ts";
import { Denied, tryAdapter } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import type { ContentDependencies } from "../../packages/contracts/src/session.ts";
import { WorkAdmissionSchema } from "../../packages/contracts/src/work.ts";
import {
  createAssistantMessageEventStream,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  Harness,
  createRegistry,
  defineTask,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import type {
  TaskId,
  ToolExecutionApi,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { NodeSqliteDatabase } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js";
import { SqliteStorage } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/storage.js";
import { createSourceDependencyStore } from "../../packages/runtime/src/content-dependency-store.ts";
import { piContext } from "../../packages/runtime/src/pi-harness.ts";
import type { MetadataTransaction } from "../../packages/runtime/src/session-agent.ts";
import { readTeamRoleImports } from "../../packages/runtime/src/team-content.ts";
import type { TeamRoleConfiguration } from "../../packages/runtime/src/team-role.ts";
import { createTeamRuntime } from "../../packages/runtime/src/team-runtime.ts";
import type { TeamRuntime } from "../../packages/runtime/src/team-runtime.ts";
import { TeamState } from "../../packages/runtime/src/team-state.ts";
import { createTeamWorkerTool } from "../../packages/runtime/src/team-workers.ts";

export const context = piContext();
export const empty = (): ContentDependencies => ({
  sourceIds: [],
  toolIds: [],
});
export const dependencies = (name: string): ContentDependencies => ({
  sourceIds: [id.source(`${name}-source`)],
  toolIds: [id.tool(`${name}-tool`)],
});

export const teamProvenanceFixture = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "team-provenance-"));
  const filename = path.join(directory, "native.sqlite");
  const admittedAt = Date.now();
  const work = Schema.decodeUnknownSync(WorkAdmissionSchema)({
    version: 2,
    admittedAt,
    deadlineAt: admittedAt + 600_000,
    goal: "Answer a bounded private question.",
    key: { organizationId: "org", ownerPrincipalId: "owner", workId: "work" },
    lead: { agentId: "lead", agentVersion: 1 },
    worker: { agentId: "worker", agentVersion: 1 },
    limits: { maxTeams: 2, maxTurns: 8, maxWorkers: 1, timeoutMs: 600_000 },
    sourceEventAddress: {
      organizationId: "org",
      agentId: "coordinator",
      conversationId: "primary",
      sessionId: "primary",
    },
    contentDependencies: empty(),
  });
  const actor = {
    actor: {
      id: work.key.ownerPrincipalId,
      organizationId: work.key.organizationId,
      kind: "human" as const,
      state: "active" as const,
    },
  };
  let pi: Harness;
  let database: DatabaseSync;
  let runtime: TeamRuntime;
  let stores: ReturnType<typeof createSourceDependencyStore>[];
  let configurations: TeamRoleConfiguration[];
  let failAdmission = false;
  let mirrorFailure: number | null = null;
  let deniedSource: string | null = null;
  let deniedTool: string | null = null;
  let deniedRole: number | null = null;
  let deniedModel: number | null = null;
  let deniedOwner = false;
  let workerTaskId: TaskId | undefined;
  const calls: number[] = [];
  const errors: unknown[] = [];
  const held = new Set<Promise<unknown>>();
  const metadata: MetadataTransaction = (operation) =>
    pi.commit(operation, context);
  const platform = {
    sync: () => Promise.resolve(),
    sql: {
      exec: (query: string, ...bindings: SQLInputValue[]) => {
        if (
          mirrorFailure !== null &&
          query.startsWith("INSERT OR IGNORE INTO cerebro_content_tool") &&
          bindings[0] === `role:${mirrorFailure}`
        ) {
          throw new Error("Injected raw mirror failure.");
        }
        const rows = database.prepare(query).all(...bindings);
        return { toArray: () => rows };
      },
    },
  };
  const storage = platform as unknown as DurableObjectStorage;
  const workerCaller = defineTask({
    name: "test.worker-caller",
    version: 1,
    initial: () => ({ phase: "finish" as const }),
    phases: {
      finish: (_task, runner, taskContext) =>
        runner.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: {} },
          }),
          taskContext
        ),
    },
  });
  const open = async () => {
    database = new DatabaseSync(filename);
    const models = createModels();
    const registry = createRegistry();
    registry.install({ name: "test.worker-caller", tasks: [workerCaller] });
    pi = await Harness.open(
      await SqliteStorage.open(new NodeSqliteDatabase(database)),
      {
        models,
        registry,
        onReport: (error) => errors.push(error),
        settings: {
          extensions: [],
          compaction: { enabled: false },
          retry: { enabled: false },
        },
      },
      context
    );
    stores = await Promise.all(
      [0, 1].map(
        async (index) =>
          await metadata(() =>
            createSourceDependencyStore(
              storage,
              id.session(`role:${index}`),
              metadata,
              true
            )
          )
      )
    );
    configurations = stores.map((store, index): TeamRoleConfiguration => {
      const pin = index === 0 ? work.lead : work.worker;
      const faux = fauxProvider({
        provider: `provider:${index}`,
        models: [{ id: `model:${index}` }],
      });
      const physical = faux.provider;
      const provider = {
        ...physical,
        streamSimple: (
          model: Parameters<typeof physical.streamSimple>[0],
          transcript: Parameters<typeof physical.streamSimple>[1],
          options?: Parameters<typeof physical.streamSimple>[2]
        ) => {
          const stream = createAssistantMessageEventStream();
          const run = async () => {
            try {
              assert.ok(options?.fetch);
              await options.fetch("https://fixture.invalid/model", {
                method: "POST",
                body: "{}",
                signal: options.signal,
              });
              faux.setResponses([
                fauxAssistantMessage(`Answer from role ${index}.`),
              ]);
              const result = physical.streamSimple(model, transcript, options);
              for await (const event of result) {
                stream.push(event);
              }
              stream.end(await result.result());
            } catch {
              const error = fauxAssistantMessage("", { stopReason: "error" });
              stream.push({ type: "error", reason: "error", error });
              stream.end(error);
            }
          };
          void run();
          return stream;
        },
      };
      const contentDependencies = async () => {
        const imported = await readTeamRoleImports(pi, work, index);
        return {
          sourceIds: [
            ...new Set([...(await store.all()), ...imported.sourceIds]),
          ],
          toolIds: [
            ...new Set([...(await store.tools()), ...imported.toolIds]),
          ],
        };
      };
      return {
        address: {
          organizationId: work.key.organizationId,
          agentId: pin.agentId,
          conversationId: id.conversation(`role:${index}`),
          sessionId: id.session(`role:${index}`),
        },
        agent: {
          organizationId: work.key.organizationId,
          agentId: pin.agentId,
          version: pin.agentVersion,
          model: faux.getModel().id,
          instructions: "Answer briefly.",
        },
        audit: () => Effect.void,
        authority: {
          require: (request) =>
            deniedRole === index ||
            (deniedModel === index && request.model !== undefined)
              ? Effect.fail(
                  new Denied({
                    code: "revoked",
                    reason: "Current role or model access denied.",
                  })
                )
              : Effect.void,
        },
        ownerContext: () =>
          deniedOwner
            ? tryAdapter(() =>
                Promise.reject(
                  new ChannelError(
                    403,
                    "forbidden",
                    "The principal is no longer active."
                  )
                )
              )
            : Effect.succeed(actor),
        contentDependencies,
        importDependencies: store.importDependencies,
        checkDependencies: (_owner, requested) =>
          Effect.tryPromise({
            try: async () => {
              const recorded = await contentDependencies();
              if (
                (deniedSource !== null &&
                  [...recorded.sourceIds, ...requested.sourceIds].includes(
                    deniedSource
                  )) ||
                (deniedTool !== null &&
                  [...recorded.toolIds, ...requested.toolIds].includes(
                    deniedTool
                  ))
              ) {
                throw new Denied({
                  code: "revoked",
                  reason: "Current content access denied.",
                });
              }
            },
            catch: (error) =>
              error instanceof Denied
                ? error
                : new Denied({
                    code: "revoked",
                    reason: "Fixture dependency check failed.",
                  }),
          }),
        tools: [],
        executor: {
          execute: () => Effect.succeed({ output: "Unused fixture tool." }),
        },
        toolDependencies: () => Effect.succeed(empty()),
        provider: {
          model: faux.getModel(),
          provider,
          fetch: () => {
            calls.push(index);
            return Promise.resolve(new Response("fixture"));
          },
          deadlineMs: 30_000,
          maxInputBytes: 100_000,
          maxResponseBytes: 100_000,
        },
      };
    });
    const proxy = new Proxy(pi, {
      get(target, key) {
        if (key === "commit") {
          return (
            change: Parameters<Harness["commit"]>[0],
            options: Parameters<Harness["commit"]>[1]
          ) =>
            target.commit(async (tx) => {
              const value = await change(tx);
              if (
                failAdmission &&
                value &&
                typeof value === "object" &&
                "accepted" in value
              ) {
                failAdmission = false;
                throw new Error("Injected admission callback failure.");
              }
              return value;
            }, options);
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    runtime = await createTeamRuntime({
      pi: proxy,
      work,
      configurations,
      storage,
      metadata,
      models,
      registry,
      ensureWake: () => Promise.resolve(),
      waitUntil: (promise) => {
        held.add(promise);
      },
      submit: async (nativeId, text, requestId) => {
        const native = await pi.conversation(nativeId, context);
        assert.ok(native);
        await native.submit(
          { type: "input", content: text, requestId, whenBusy: "followUp" },
          context
        );
      },
      persistReportIn: () => Promise.resolve(),
    });
    pi.resume();
  };
  await open();
  const read = async () => {
    const state = await pi.snapshot(TeamState, context);
    return {
      state,
      canonical: await Promise.all(
        [0, 1].map((index) => readTeamRoleImports(pi, work, index))
      ),
      raw: await Promise.all(
        stores.map(async (store) => ({
          sourceIds: await store.all(),
          toolIds: await store.tools(),
        }))
      ),
    };
  };
  return {
    work,
    calls,
    errors,
    pi: () => pi,
    runtime: () => runtime,
    configuration: (index: number) => configurations[index],
    store: (index: number) => stores[index],
    read,
    failAdmission: () => {
      failAdmission = true;
    },
    failMirror: (index: number | null) => {
      mirrorFailure = index;
    },
    denySource: (source: string | null) => {
      deniedSource = source;
    },
    denyTool: (tool: string | null) => {
      deniedTool = tool;
    },
    denyRole: (index: number | null) => {
      deniedRole = index;
    },
    denyModel: (index: number | null) => {
      deniedModel = index;
    },
    denyOwner: (value: boolean) => {
      deniedOwner = value;
    },
    invokeWorker: async (failCommit = 0) => {
      const state = await pi.snapshot(TeamState, context);
      assert.ok(state?.lead);
      const [lead, worker] = runtime.roles;
      assert.ok(lead && worker);
      workerTaskId ??= await pi.commit(
        (tx) =>
          tx.createTask(
            workerCaller,
            {},
            {
              background: true,
              conversationId: state.lead ?? undefined,
              ownership: { kind: "conversation" },
            }
          ),
        context
      );
      let count = 0;
      const api = {
        conversationId: state.lead,
        taskId: workerTaskId,
        commit: (change, taskContext) =>
          pi.commit(async (tx) => {
            const value = await change(tx);
            count += 1;
            if (count === failCommit) {
              throw new Error(`Injected worker callback failure ${count}.`);
            }
            return value;
          }, taskContext),
        conversation: (nativeId, options) => pi.conversation(nativeId, options),
      } satisfies Pick<
        ToolExecutionApi,
        "conversationId" | "taskId" | "commit" | "conversation"
      >;
      const tool = createTeamWorkerTool({
        pi,
        lead,
        workers: [worker],
        now: Date.now,
      });
      return await tool.execute(
        { text: "A bounded worker question." },
        api,
        context
      );
    },
    reopen: async () => {
      await pi.close(context);
      await open();
    },
    close: async () => {
      await pi.close(context);
      await Promise.allSettled(held);
      await rm(directory, { recursive: true });
    },
  };
};
