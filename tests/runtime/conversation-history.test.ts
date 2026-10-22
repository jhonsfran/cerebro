/* oxlint-disable unicorn/no-await-expression-member -- Assertions inspect completed policy and native transcript results. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect } from "effect";
import { z } from "zod";

import { createAgentAuthority } from "../../packages/authorization/src/agent-authority.ts";
import { Denied } from "../../packages/contracts/src/failures.ts";
import type { ContractFailure } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import type { ExecutionContext } from "../../packages/contracts/src/identity.ts";
import type { AgentDefinition } from "../../packages/contracts/src/session.ts";
import {
  Type,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  Harness,
  MemoryStorage,
  createRegistry,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import type { Conversation } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { searchConversationHistory } from "../../packages/runtime/src/conversation-history.ts";
import type { HistoryScope } from "../../packages/runtime/src/conversation-history.ts";
import {
  chatSnapshot,
  piContext,
  snapshotToolIds,
} from "../../packages/runtime/src/pi-harness.ts";
import {
  bindRegisteredTool,
  createToolRegistry,
} from "../../packages/tools/src/registry.ts";
import { createAuthorityFake } from "../support/effect-fakes.ts";

const context = piContext();
const organizationId = id.organization("history-organization");
const owner: ExecutionContext = {
  actor: {
    id: id.principal("history-owner"),
    kind: "human",
    organizationId,
    state: "active",
  },
};
const run = async <A>(
  program: Effect.Effect<A, ContractFailure>
): Promise<A> => {
  const result = await Effect.runPromise(Effect.result(program));
  if (result._tag === "Failure") {
    throw result.failure;
  }
  return result.success;
};

const fixture = async () => {
  const models = createModels();
  const registry = createRegistry();
  const pi = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      settings: {
        compaction: { enabled: false, keepRecentTokens: 20 },
        extensions: [],
        retry: { enabled: false },
      },
    },
    context
  );
  const toolRegistry = createToolRegistry(
    [
      {
        definition: {
          connectorId: "privileged-connector",
          effect: "read",
          id: id.tool("privileged_lookup"),
          version: "1",
        },
        description: "Read restricted company data.",
        input: z.object({ query: z.string() }),
        maxInputBytes: 1024,
        maxOutputBytes: 1024,
        output: z.string(),
        requiresApproval: false,
        retryMode: "idempotent",
        target: {
          kind: "mcp",
          method: "lookup",
          url: "https://fixture.invalid/mcp",
        },
      },
    ],
    "local"
  );
  const [entry] = toolRegistry.list();
  assert.ok(entry);
  const tool = await run(bindRegisteredTool(entry));
  const scopes = new Map<string, HistoryScope>();
  const scope = async (
    name: string,
    options: {
      enabled?: boolean;
      readGrant?: boolean;
      configured?: boolean;
      native?: Conversation;
      agentId?: string;
    } = {}
  ) => {
    const address = {
      agentId: id.agent(options.agentId ?? `agent:${name}`),
      conversationId: id.conversation(`conversation:${name}`),
      organizationId,
      sessionId: id.session(`session:${name}`),
    };
    const agent: AgentDefinition = {
      agentId: address.agentId,
      enabledToolIds: options.enabled === false ? [] : [tool.id],
      grants: [
        {
          action: "execute",
          resource: { id: tool.id, kind: "tool", organizationId },
        },
        {
          action: "execute",
          resource: { id: tool.connectorId, kind: "tool", organizationId },
        },
        ...(options.readGrant === false
          ? []
          : [
              {
                action: "read" as const,
                resource: {
                  id: tool.id,
                  kind: "tool" as const,
                  organizationId,
                },
              },
            ]),
      ],
      instructions: "Use permitted company evidence.",
      model: "fixture/model",
      organizationId,
      version: 1,
    };
    const current = createAuthorityFake(Date.now);
    const authority = createAgentAuthority({
      checkSession: (request) =>
        request.address.sessionId === address.sessionId &&
        request.context.actor.id === owner.actor.id
          ? Effect.void
          : Effect.fail(
              new Denied({
                code: "unauthorized",
                reason: "Foreign history owner.",
              })
            ),
      current: current.service,
      enabledModels: [agent.model],
      entitlements: {
        check: () =>
          Promise.resolve({
            status: "ok",
            value: { decision: "allow", policyVersion: "entitlements-v1" },
          }),
      },
      tools: [tool],
    });
    const native =
      options.native ??
      (await pi.createConversation(
        { ownership: { kind: "ownerless" } },
        context
      ));
    const usedTools = new Set<string>();
    const inherited: {
      sessionId: string;
      toolIds: readonly string[];
      history: boolean;
    }[] = [];
    const registered = {
      definition: tool,
      description: entry.description,
      parameters: Type.Object({ query: Type.String() }),
    };
    const authorize = async (
      caller: ExecutionContext,
      operation: "read" | "send",
      signal?: AbortSignal
    ): Promise<void> => {
      await run(
        authority.require(
          {
            action: operation === "send" ? "execute" : "read",
            address,
            context: caller,
            pinnedAgent: agent,
            resource: { id: agent.agentId, kind: "agent", organizationId },
          },
          { deadlineAt: Date.now() + 10_000, signal }
        )
      );
    };
    const historyScope: HistoryScope = {
      native,
      read: async (caller, signal) => {
        await authorize(caller, "read", signal);
        const watch = await native.watch(piContext(signal));
        try {
          const snapshot = chatSnapshot({
            address,
            agentVersion: agent.version,
            approvals: [],
            view: watch.value,
          });
          for (const toolId of new Set([
            ...snapshotToolIds(snapshot),
            ...usedTools,
          ])) {
            // oxlint-disable-next-line no-await-in-loop -- Recheck each recorded source tool with the real agent policy.
            await run(
              authority.require(
                {
                  action: "read",
                  address,
                  context: caller,
                  pinnedAgent: agent,
                  resource: { id: toolId, kind: "tool", organizationId },
                  tool,
                },
                { deadlineAt: Date.now() + 10_000, signal }
              )
            );
          }
          return snapshot;
        } finally {
          await watch.stop();
        }
      },
      runtime: {
        authorize,
        configuration: {
          address,
          agent,
          authority,
          contentDependencies: () =>
            Promise.resolve({ sourceIds: [], toolIds: [...usedTools] }),
          inheritDependencies: (source, toolIds, history) => {
            inherited.push({ sessionId: source.sessionId, toolIds, history });
            for (const toolId of toolIds) {
              usedTools.add(toolId);
            }
          },
          ownerContext: () => Effect.succeed(owner),
          tools: options.configured === false ? [] : [registered],
        },
      },
    };
    scopes.set(address.sessionId, historyScope);
    return {
      address,
      agent,
      current,
      inherited,
      native,
      scope: historyScope,
      usedTools,
    };
  };
  const source = await scope("privileged-source");
  const faux = fauxProvider({ provider: "history-source-provider" });
  models.setProvider(faux.provider);
  const extension = {
    name: "history-source-tools",
    tools: [
      {
        description: "Read a privileged record.",
        execute: () => {
          source.usedTools.add(tool.id);
          return Promise.resolve({
            output: [{ text: "CFO_ONLY_VALUE", type: "text" as const }],
          });
        },
        name: tool.id,
        parameters: Type.Object({ query: Type.String() }),
        replay: "safe" as const,
      },
      {
        description: "Return earlier evidence.",
        execute: () =>
          Promise.resolve({
            output: [{ text: "Earlier evidence", type: "text" as const }],
          }),
        name: "search_history",
        parameters: Type.Object({ question: Type.String() }),
        replay: "safe" as const,
      },
    ],
  };
  registry.install(extension);
  const model = faux.getModel();
  await source.native.configure(
    {
      extensions: [extension],
      model: { modelId: model.id, provider: model.provider },
    },
    context
  );
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(tool.id, { query: "payroll" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("payroll-token CFO_ONLY_VALUE"),
  ]);
  const input = await source.native.submit(
    { content: "Read the payroll record.", type: "input" },
    context
  );
  assert.equal((await input.wait(context)).status, "done");
  const answerEntry = (await source.native.context(context)).entries.find(
    (record) =>
      record.model?.some(
        (message) =>
          message.role === "assistant" &&
          message.content.some(
            (part) =>
              part.type === "text" &&
              part.text === "payroll-token CFO_ONLY_VALUE"
          )
      )
  );
  assert.ok(answerEntry);
  const search = (
    target: HistoryScope,
    term = "payroll-token",
    addresses = [source.address]
  ) =>
    searchConversationHistory(
      {
        addresses,
        metadata: (operation) => pi.commit(operation, context),
        open: (address) => {
          const found = scopes.get(address.sessionId);
          assert.ok(found);
          return Promise.resolve(found);
        },
        persist: () => Promise.resolve(),
        target,
      },
      term
    );
  return { answerEntry, faux, pi, scope, search, source, tool };
};

test("history tool evidence requires the receiving agent's enabled tool, read grant and trusted registration", async () => {
  const f = await fixture();
  try {
    const missingEnabled = await f.scope("no-enabled-tool", { enabled: false });
    const missingRead = await f.scope("no-read-grant", { readGrant: false });
    const missingRegistration = await f.scope("no-trusted-registration", {
      configured: false,
    });
    const permitted = await f.scope("permitted-receiver");
    const result = await f.search(permitted.scope);
    assert.deepEqual(result, {
      matches: [
        {
          conversationId: "conversation:privileged-source",
          entryId: String(f.answerEntry.id),
          role: "assistant",
          snippet: "payroll-token CFO_ONLY_VALUE",
        },
      ],
      truncated: false,
    });
    assert.deepEqual(permitted.inherited, [
      {
        history: true,
        sessionId: "session:privileged-source",
        toolIds: ["privileged_lookup"],
      },
    ]);
    for (const denied of [missingEnabled, missingRead, missingRegistration]) {
      // oxlint-disable-next-line no-await-in-loop -- Each receiving agent has a distinct real policy configuration.
      assert.deepEqual(await f.search(denied.scope), {
        matches: [],
        truncated: false,
      });
      assert.deepEqual(denied.inherited, []);
    }
  } finally {
    await f.pi.close(context);
  }
});

test("history skips a revoked source agent but propagates transient authority failure", async () => {
  const f = await fixture();
  try {
    const target = await f.scope("source-access-receiver");
    f.source.current.setDecision({
      decision: "deny",
      policyVersion: "revoked",
      reason: "Source agent revoked.",
    });
    assert.deepEqual(await f.search(target.scope), {
      matches: [],
      truncated: false,
    });
    f.source.current.setDecision({
      decision: "allow",
      policyVersion: "restored",
    });
    f.source.current.setAvailable(false);
    await assert.rejects(f.search(target.scope), { _tag: "Unavailable" });
    f.source.current.setAvailable(true);
    assert.deepEqual(
      (await f.search(target.scope)).matches.map((match) => match.snippet),
      ["payroll-token CFO_ONLY_VALUE"]
    );
  } finally {
    await f.pi.close(context);
  }
});

test("native compaction keeps stored history searchable and preserves the receiving tool restriction", async () => {
  const f = await fixture();
  try {
    f.faux.appendResponses([fauxAssistantMessage("Recent note.")]);
    const recent = await f.source.native.submit(
      { content: "recent ".repeat(100), type: "input" },
      context
    );
    assert.equal((await recent.wait(context)).status, "done");
    f.faux.appendResponses([
      fauxAssistantMessage("A short summary without private values."),
    ]);
    const task = await f.source.native.compact(undefined, context);
    assert.equal(
      (await f.pi.waitForTask(task, context)).state.outcome.status,
      "completed"
    );
    const compacted = await f.source.scope.read(owner);
    assert.equal(
      compacted.messages.some((message) =>
        message.text.includes("CFO_ONLY_VALUE")
      ),
      false
    );
    const permitted = await f.scope("compacted-permitted");
    const denied = await f.scope("compacted-denied", { readGrant: false });
    assert.deepEqual((await f.search(permitted.scope)).matches, [
      {
        conversationId: "conversation:privileged-source",
        entryId: String(f.answerEntry.id),
        role: "assistant",
        snippet: "payroll-token CFO_ONLY_VALUE",
      },
    ]);
    assert.deepEqual(await f.search(denied.scope), {
      matches: [],
      truncated: false,
    });
  } finally {
    await f.pi.close(context);
  }
});

test("search-derived turns are excluded while ordinary original evidence remains searchable", async () => {
  const f = await fixture();
  try {
    f.faux.appendResponses([
      fauxAssistantMessage(
        fauxToolCall("search_history", { question: "Earlier discussion" }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("search-token DERIVED_VALUE"),
      fauxAssistantMessage("Noted."),
    ]);
    const derived = await f.source.native.submit(
      { content: "Search earlier discussions.", type: "input" },
      context
    );
    assert.equal((await derived.wait(context)).status, "done");
    const original = await f.source.native.submit(
      { content: "search-token ORIGINAL_VALUE", type: "input" },
      context
    );
    assert.equal((await original.wait(context)).status, "done");
    const target = await f.scope("derived-receiver");
    const result = await f.search(target.scope, "search-token");
    assert.deepEqual(
      result.matches.map((match) => ({
        role: match.role,
        snippet: match.snippet,
      })),
      [{ role: "user", snippet: "search-token ORIGINAL_VALUE" }]
    );
    assert.equal(JSON.stringify(result).includes("DERIVED_VALUE"), false);
  } finally {
    await f.pi.close(context);
  }
});

test("fork scans count inherited evidence only in the conversation that wrote it", async () => {
  const f = await fixture();
  try {
    const branchNative = await f.source.native.fork(
      f.answerEntry.id,
      { ownership: { kind: "ownerless" } },
      context
    );
    const branch = await f.scope("fork-source", {
      agentId: f.source.address.agentId,
      native: branchNative,
    });
    const target = await f.scope("fork-search-receiver");
    const result = await f.search(target.scope, "payroll-token", [
      f.source.address,
      branch.address,
    ]);
    assert.deepEqual(
      result.matches.map((match) => ({
        conversationId: match.conversationId,
        snippet: match.snippet,
      })),
      [
        {
          conversationId: "conversation:privileged-source",
          snippet: "payroll-token CFO_ONLY_VALUE",
        },
      ]
    );
    assert.equal(target.inherited.length, 1);
  } finally {
    await f.pi.close(context);
  }
});
