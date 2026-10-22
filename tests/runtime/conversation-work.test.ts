/* oxlint-disable unicorn/no-await-expression-member -- Assertions read the native result at each observation boundary. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { id } from "../../packages/contracts/src/identity.ts";
import {
  Type,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import type {
  FauxResponseFactory,
  TranscriptContext,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  Harness,
  MemoryStorage,
  createRegistry,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import type { ToolRegistration } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { createConversationWork } from "../../packages/runtime/src/conversation-work.ts";
import { piContext } from "../../packages/runtime/src/pi-harness.ts";

const context = piContext();
const lastInput = (transcript: TranscriptContext): string => {
  const input = transcript.messages.findLast(
    (message) => message.role === "user"
  );
  return typeof input?.content === "string" ? input.content : "";
};
const hasResult = (transcript: TranscriptContext): boolean =>
  transcript.messages.some((message) => message.role === "toolResult");
const waitFor = async (ready: () => boolean | Promise<boolean>) => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- Each read observes progress from the native scheduler.
    if (await ready()) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- Yield to the native scheduler between observations.
    await delay(5);
  }
  throw new Error("Native child execution did not reach the expected state.");
};

const fixture = async (storage = new MemoryStorage()) => {
  const models = createModels();
  const registry = createRegistry();
  const pi = await Harness.open(
    storage,
    {
      models,
      registry,
      settings: {
        compaction: { enabled: false },
        extensions: [],
        progress: { outputIntervalMs: 0, partialIntervalMs: 0 },
        retry: { enabled: false },
      },
    },
    context
  );
  const addScope = async (
    name: string,
    response: FauxResponseFactory,
    companyTools: readonly ToolRegistration[] = []
  ) => {
    const faux = fauxProvider({ provider: name });
    faux.setResponses(Array.from({ length: 40 }, () => response));
    models.setProvider(faux.provider);
    const native = await pi.createConversation(
      { ownership: { kind: "ownerless" } },
      context
    );
    const address = {
      agentId: id.agent(`agent:${name}`),
      conversationId: id.conversation(`conversation:${name}`),
      organizationId: id.organization("work-organization"),
      sessionId: id.session(`session:${name}`),
    };
    const deadlines: { childId: string; deadlineAt: number }[] = [];
    let allowed = true;
    const work = createConversationWork({
      address,
      authorize: () => {
        if (!allowed) {
          return Promise.reject(new Error("The parent scope was revoked."));
        }
        return Promise.resolve();
      },
      ensureDeadline: (childId, deadlineAt) => {
        deadlines.push({ childId, deadlineAt });
        return Promise.resolve();
      },
      nativeId: native.id,
      pi,
      search: () =>
        Promise.resolve({
          matches: [
            {
              conversationId: `conversation:earlier-${name}`,
              entryId: "42",
              role: "assistant",
              snippet: "Use Postgres for company metadata.",
            },
          ],
          truncated: false,
        }),
    });
    const extension = {
      hooks: work.hooks,
      name: `work:${name}`,
      tools: [...work.tools, ...companyTools],
    };
    registry.install(extension);
    const model = faux.getModel();
    await native.configure(
      {
        extensions: [extension],
        instructions: `${name} policy instructions`,
        model: { modelId: model.id, provider: model.provider },
      },
      context
    );
    return {
      address,
      deadlines,
      faux,
      native,
      revoke: () => {
        allowed = false;
      },
      work,
    };
  };
  return { addScope, models, pi, registry };
};

const delegateResponse: FauxResponseFactory = (transcript) => {
  if (lastInput(transcript) === "Child request") {
    return fauxAssistantMessage("Child answer");
  }
  return hasResult(transcript)
    ? fauxAssistantMessage("Parent answer")
    : fauxAssistantMessage(
        fauxToolCall("subagent", { task: "Child request" }),
        {
          stopReason: "toolUse",
        }
      );
};

test("delegation has a fresh transcript, retained parent policy, durable lineage and deadline", async () => {
  const { addScope, pi } = await fixture();
  try {
    const scope = await addScope("sales", delegateResponse);
    await scope.native.submit(
      {
        entry: {
          kind: "test.previous-answer",
          model: [
            { content: "Private earlier context", role: "user", timestamp: 0 },
          ],
        },
        type: "write",
      },
      context
    );
    const submission = await scope.native.submit(
      { content: "Delegate", requestId: "input", type: "input" },
      context
    );
    assert.equal((await submission.wait(context)).status, "done");
    const children = await scope.work.children();
    assert.equal(children.length, 1);
    assert.equal(children[0]?.state, "succeeded");
    assert.deepEqual(
      children[0]?.messages.map((message) => message.text),
      ["Child request", "Child answer"]
    );
    const [known] = await scope.work.known();
    assert.ok(known);
    const native = await pi.conversation(known.nativeId, context);
    assert.ok(native);
    const agent = await native.agent(context);
    assert.equal(agent.model?.provider, "sales");
    assert.match(agent.instructions ?? "", /sales policy instructions/u);
    assert.equal(
      agent.tools.some((tool) => tool.name === "subagent"),
      false
    );
    assert.equal(
      agent.tools.some((tool) => tool.name === "schedule"),
      false
    );
    assert.equal(scope.deadlines[0]?.childId, children[0]?.id);
    assert.equal(scope.deadlines[0]?.deadlineAt, known.deadlineAt);
    assert.ok(known.deadlineAt > Date.now() + 590_000);
    const nativeRecord = await pi.commit(
      (tx) => tx.conversation(known.nativeId),
      context
    );
    assert.equal(nativeRecord?.owner?.taskId, known.ownerTaskId);
    assert.equal(nativeRecord?.owner?.conversationId, scope.native.id);
    assert.equal(nativeRecord?.parent, undefined);
    const retried = await scope.native.submit(
      { content: "Delegate", requestId: "input", type: "input" },
      context
    );
    assert.equal(retried.id, submission.id);
    assert.equal((await scope.work.known()).length, 1);
  } finally {
    await pi.close(context);
  }
});

test("history work has only the authorized search tool and returns cited evidence", async () => {
  const { addScope, pi } = await fixture();
  try {
    const scope = await addScope("history", (transcript) => {
      if (lastInput(transcript) === "Earlier decision") {
        const result = transcript.messages.findLast(
          (message) => message.role === "toolResult"
        );
        if (result) {
          assert.match(
            JSON.stringify(result.content),
            /conversation:earlier-history/u
          );
          return fauxAssistantMessage(
            "Use Postgres. Source conversation:earlier-history."
          );
        }
        return fauxAssistantMessage(
          fauxToolCall("search_conversations", { term: "Postgres" }),
          {
            stopReason: "toolUse",
          }
        );
      }
      return hasResult(transcript)
        ? fauxAssistantMessage("Found the decision")
        : fauxAssistantMessage(
            fauxToolCall("search_history", { question: "Earlier decision" }),
            {
              stopReason: "toolUse",
            }
          );
    });
    const submission = await scope.native.submit(
      { content: "Search earlier chats", type: "input" },
      context
    );
    assert.equal((await submission.wait(context)).status, "done");
    const [child] = await scope.work.children();
    assert.equal(child?.purpose, "history");
    assert.equal(child?.state, "succeeded");
    assert.equal(child?.tools[0]?.toolName, "search_conversations");
    assert.match(
      child?.messages.at(-1)?.text ?? "",
      /Source conversation:earlier-history/u
    );
    const [known] = await scope.work.known();
    assert.ok(known);
    const native = await pi.conversation(known.nativeId, context);
    assert.ok(native);
    assert.deepEqual(
      (await native.agent(context)).tools.map((tool) => tool.name),
      ["search_conversations"]
    );
  } finally {
    await pi.close(context);
  }
});

const blockedLookup = (scope: string) => {
  const release = Promise.withResolvers<boolean>();
  const approvals: { scope: string; taskId: string }[] = [];
  const cancelled: string[] = [];
  const tool: ToolRegistration = {
    description: "Requires this public scope's approval.",
    execute: async (_args, api, invocation) => {
      const retained = await api.memo("approval-scope", scope, invocation);
      approvals.push({ scope: retained, taskId: String(api.taskId) });
      const pending = Promise.withResolvers<boolean>();
      const abort = () => {
        cancelled.push(scope);
        pending.reject(new Error("Approval wait was interrupted."));
      };
      if (invocation.abortSignal?.aborted) {
        abort();
      } else {
        invocation.abortSignal?.addEventListener("abort", abort, {
          once: true,
        });
      }
      try {
        await Promise.race([pending.promise, release.promise]);
      } finally {
        invocation.abortSignal?.removeEventListener("abort", abort);
      }
      return { output: [{ text: `Approved ${scope}`, type: "text" }] };
    },
    name: "company_lookup",
    parameters: Type.Object({}),
    replay: "safe",
  };
  return { approvals, cancelled, release: () => release.resolve(true), tool };
};

const lookupResponse: FauxResponseFactory = (transcript) => {
  if (lastInput(transcript) === "Child request") {
    return hasResult(transcript)
      ? fauxAssistantMessage("Approved child answer")
      : fauxAssistantMessage(fauxToolCall("company_lookup", {}), {
          stopReason: "toolUse",
        });
  }
  return hasResult(transcript)
    ? fauxAssistantMessage("Parent answer")
    : fauxAssistantMessage(
        fauxToolCall("subagent", { task: "Child request" }),
        {
          stopReason: "toolUse",
        }
      );
};

test("child Stop validates root ownership and retains sibling scopes and approval closures", async () => {
  const { addScope, pi } = await fixture();
  const salesApproval = blockedLookup("sales");
  const supportApproval = blockedLookup("support");
  try {
    const sales = await addScope("sales", lookupResponse, [salesApproval.tool]);
    const support = await addScope("support", lookupResponse, [
      supportApproval.tool,
    ]);
    const [first, second] = await Promise.all([
      sales.native.submit({ content: "Delegate", type: "input" }, context),
      support.native.submit({ content: "Delegate", type: "input" }, context),
    ]);
    await waitFor(
      () =>
        salesApproval.approvals.length === 1 &&
        supportApproval.approvals.length === 1
    );
    const [salesChild] = await sales.work.known();
    const [supportChild] = await support.work.known();
    assert.ok(salesChild);
    assert.ok(supportChild);
    await assert.rejects(sales.work.stop(supportChild.id), {
      _tag: "NotFound",
      resource: "Child conversation",
    });
    assert.equal(await sales.work.stop(salesChild.id), true);
    assert.equal((await first.wait(context)).status, "done");
    assert.deepEqual(salesApproval.cancelled, ["sales"]);
    assert.equal((await sales.work.children())[0]?.state, "interrupted");
    assert.equal((await support.work.children())[0]?.state, "running");
    assert.deepEqual(
      supportApproval.approvals.map((approval) => approval.scope),
      ["support"]
    );
    supportApproval.release();
    assert.equal((await second.wait(context)).status, "done");
    assert.equal((await support.work.children())[0]?.state, "succeeded");
    assert.equal(await sales.work.stop(salesChild.id), false);
  } finally {
    salesApproval.release();
    supportApproval.release();
    await pi.close(context);
  }
});

test("one public scope admits only three concurrent children and root Stop cancels them", async () => {
  const { addScope, pi } = await fixture();
  const approval = blockedLookup("bounded");
  try {
    const scope = await addScope(
      "bounded",
      (transcript) => {
        if (lastInput(transcript).startsWith("Child ")) {
          return fauxAssistantMessage(fauxToolCall("company_lookup", {}), {
            stopReason: "toolUse",
          });
        }
        return fauxAssistantMessage(
          Array.from({ length: 4 }, (_, index) =>
            fauxToolCall(
              "subagent",
              { task: `Child ${index}` },
              { id: `delegate-${index}` }
            )
          ),
          { stopReason: "toolUse" }
        );
      },
      [approval.tool]
    );
    const submission = await scope.native.submit(
      { content: "Four requests", type: "input" },
      context
    );
    await waitFor(() => approval.approvals.length === 3);
    const children = await scope.work.known();
    assert.equal(children.length, 3);
    const transcript = await scope.native.context(context);
    const refused = transcript.messages.find(
      (message) =>
        message.role === "toolResult" && message.toolCallId === "delegate-3"
    );
    assert.equal(refused?.role, "toolResult");
    if (refused?.role === "toolResult") {
      assert.equal(refused.isError, true);
    }
    await scope.native.abort(context);
    assert.equal((await submission.wait(context)).status, "unanswered");
    assert.deepEqual(
      (await scope.work.children()).map((child) => child.state),
      ["interrupted", "interrupted", "interrupted"]
    );
    assert.deepEqual(approval.cancelled, ["bounded", "bounded", "bounded"]);
  } finally {
    approval.release();
    await pi.close(context);
  }
});

test("native child execution stops after eight model rounds", async () => {
  const { addScope, pi } = await fixture();
  let lookups = 0;
  const tool: ToolRegistration = {
    description: "Read one result.",
    execute: () => {
      lookups += 1;
      return Promise.resolve({ output: [{ text: "More data", type: "text" }] });
    },
    name: "company_lookup",
    parameters: Type.Object({}),
    replay: "safe",
  };
  try {
    const scope = await addScope(
      "rounds",
      (transcript) => {
        if (lastInput(transcript) === "Child request") {
          return fauxAssistantMessage(fauxToolCall("company_lookup", {}), {
            stopReason: "toolUse",
          });
        }
        return hasResult(transcript)
          ? fauxAssistantMessage("The bounded task ended")
          : fauxAssistantMessage(
              fauxToolCall("subagent", { task: "Child request" }),
              { stopReason: "toolUse" }
            );
      },
      [tool]
    );
    const submission = await scope.native.submit(
      { content: "Delegate", type: "input" },
      context
    );
    assert.equal((await submission.wait(context)).status, "done");
    assert.equal(lookups, 8);
    assert.equal(scope.faux.state.callCount, 10);
    assert.equal((await scope.work.children())[0]?.state, "interrupted");
  } finally {
    await pi.close(context);
  }
});

test("context resets retain historical tool dependencies after the child run ends", async () => {
  const { addScope, pi } = await fixture();
  let lookups = 0;
  const resetTool: ToolRegistration = {
    description: "Read data and replace the active context.",
    execute: async (_args, api, invocation) => {
      lookups += 1;
      const child = await pi.conversation(api.conversationId, invocation);
      assert.ok(child);
      await child.reset("Child request", invocation);
      return { output: [{ text: "Context reset", type: "text" }] };
    },
    name: "company_lookup",
    parameters: Type.Object({}),
    replay: "safe",
  };
  try {
    const scope = await addScope(
      "reset-rounds",
      (transcript) => {
        if (lastInput(transcript) === "Child request") {
          return fauxAssistantMessage(fauxToolCall("company_lookup", {}), {
            stopReason: "toolUse",
          });
        }
        return hasResult(transcript)
          ? fauxAssistantMessage("The bounded task ended")
          : fauxAssistantMessage(
              fauxToolCall("subagent", { task: "Child request" }),
              {
                stopReason: "toolUse",
              }
            );
      },
      [resetTool]
    );
    const submission = await scope.native.submit(
      { content: "Delegate", type: "input" },
      context
    );
    assert.equal((await submission.wait(context)).status, "done");
    assert.equal(lookups, 1);
    assert.equal(scope.faux.state.callCount, 3);
    assert.deepEqual(await scope.work.toolIds(), ["company_lookup"]);
    assert.deepEqual((await scope.work.children())[0]?.tools, []);
  } finally {
    await pi.close(context);
  }
});

test("child previews bound retained text while the parent receives a bounded tool answer", async () => {
  const { addScope, pi } = await fixture();
  try {
    const scope = await addScope("large-output", (transcript) => {
      if (lastInput(transcript) === "Child request") {
        return fauxAssistantMessage("x".repeat(40_000));
      }
      return hasResult(transcript)
        ? fauxAssistantMessage("Parent answer")
        : fauxAssistantMessage(
            fauxToolCall("subagent", { task: "Child request" }),
            {
              stopReason: "toolUse",
            }
          );
    });
    const submission = await scope.native.submit(
      { content: "Delegate", type: "input" },
      context
    );
    assert.equal((await submission.wait(context)).status, "done");
    const [child] = await scope.work.children();
    assert.equal(child?.messages.at(-1)?.text, "x".repeat(2000));
    const parent = await scope.native.context(context);
    const result = parent.messages.find(
      (message) => message.role === "toolResult"
    );
    assert.ok(result);
    assert.ok(JSON.stringify(result.content).length < 17_000);
  } finally {
    await pi.close(context);
  }
});

class ReopenableMemoryStorage extends MemoryStorage {
  closes = 0;

  override close(): Promise<void> {
    this.closes += 1;
    return Promise.resolve();
  }
}

test("reopening native tasks reuses the child, approval identity and submission", async () => {
  const storage = new ReopenableMemoryStorage();
  const first = await fixture(storage);
  const approval = blockedLookup("recovered-parent");
  const scope = await first.addScope("recovery", lookupResponse, [
    approval.tool,
  ]);
  const submission = await scope.native.submit(
    { content: "Delegate", requestId: "parent-input", type: "input" },
    context
  );
  await waitFor(() => approval.approvals.length === 1);
  const before = await scope.work.known();
  const [beforeChild] = before;
  assert.ok(beforeChild);
  const submittedChild = await first.pi.commit(
    (tx) =>
      tx.submissionByRequest(
        beforeChild.nativeId,
        `delegate:${beforeChild.ownerTaskId}`
      ),
    context
  );
  await first.pi.close(context);
  assert.equal(storage.closes, 1);

  const second = await fixture(storage);
  try {
    const work = createConversationWork({
      address: scope.address,
      authorize: () => Promise.resolve(),
      ensureDeadline: () => Promise.resolve(),
      nativeId: scope.native.id,
      pi: second.pi,
      search: () => Promise.resolve({ matches: [], truncated: false }),
    });
    const faux = fauxProvider({ provider: "recovery" });
    faux.setResponses(Array.from({ length: 10 }, () => lookupResponse));
    second.models.setProvider(faux.provider);
    second.registry.install({
      hooks: work.hooks,
      name: "work:recovery",
      tools: [...work.tools, approval.tool],
    });
    second.pi.resume();
    await waitFor(() => approval.approvals.length === 2);
    const after = await work.known();
    const [afterChild] = after;
    assert.ok(afterChild);
    assert.deepEqual(after, before);
    assert.deepEqual(approval.approvals, [
      { scope: "recovered-parent", taskId: approval.approvals[0]?.taskId },
      { scope: "recovered-parent", taskId: approval.approvals[0]?.taskId },
    ]);
    approval.release();
    const recoveredSubmission = await second.pi.submission(
      submission.id,
      context
    );
    assert.ok(recoveredSubmission);
    assert.equal((await recoveredSubmission.wait(context)).status, "done");
    const recoveredChild = await second.pi.commit(
      (tx) =>
        tx.submissionByRequest(
          afterChild.nativeId,
          `delegate:${afterChild.ownerTaskId}`
        ),
      context
    );
    assert.equal(recoveredChild?.id, submittedChild?.id);
    assert.equal((await work.children())[0]?.state, "succeeded");
  } finally {
    approval.release();
    await second.pi.close(context);
  }
});
