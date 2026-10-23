import assert from "node:assert/strict";
import { test } from "node:test";

import { id } from "../../packages/contracts/src/identity.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import type { Message } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import type {
  EntryId,
  EntryRecord,
  ConversationView,
  TaskId,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import {
  chatSnapshot,
  snapshotToolIds,
} from "../../packages/runtime/src/pi-harness.ts";

const address = {
  agentId: id.agent("presentation-agent"),
  conversationId: id.conversation("presentation-conversation"),
  organizationId: id.organization("presentation-organization"),
  sessionId: id.session("presentation-session"),
};
const redacted = {
  redacted: true,
  thinking: "Opaque provider payload.",
  thinkingSignature: "Private provider signature.",
  type: "thinking" as const,
};
const presentationIds = new MemoryStorage();
const presentationEntry = async (message: Message): Promise<EntryRecord> => ({
  conversationId: ROOT_CONVERSATION_ID,
  id: await presentationIds.mintId<EntryId>(),
  kind: message.role === "assistant" ? "pi.assistant" : "pi.tool",
  model: [message],
});
const present = (
  entries: readonly EntryRecord[],
  docs: ConversationView["docs"] = {}
) =>
  chatSnapshot({
    address,
    agentVersion: 1,
    approvals: [],
    view: { conversation: { id: ROOT_CONVERSATION_ID }, docs, entries },
  });
const toolResult = (
  callId: string,
  text: string,
  isError = false
): Message => ({
  content: [{ text, type: "text" }],
  isError,
  role: "toolResult",
  timestamp: 0,
  toolCallId: callId,
  toolName: "company_lookup",
});

test("committed snapshots hide redacted thinking and retain visible thinking", async () => {
  const storage = new MemoryStorage();
  const entryId = await storage.mintId<EntryId>();
  const snapshot = chatSnapshot({
    address,
    agentVersion: 1,
    approvals: [],
    view: {
      conversation: { id: ROOT_CONVERSATION_ID },
      docs: {},
      entries: [
        {
          conversationId: ROOT_CONVERSATION_ID,
          id: entryId,
          kind: "pi.assistant",
          model: [
            {
              ...fauxAssistantMessage("Visible answer."),
              content: [redacted, { text: "Visible answer.", type: "text" }],
            },
            {
              ...fauxAssistantMessage("Another answer."),
              content: [
                redacted,
                {
                  thinking: "Visible explanation.",
                  type: "thinking",
                },
                { text: "Another answer.", type: "text" },
              ],
            },
          ],
        },
      ],
    },
  });
  assert.deepEqual(snapshot.messages, [
    {
      entryId: String(entryId),
      id: `${entryId}:0`,
      role: "assistant",
      state: "complete",
      text: "Visible answer.",
    },
    {
      entryId: String(entryId),
      id: `${entryId}:1`,
      role: "assistant",
      state: "complete",
      text: "Another answer.",
      thinking: "Visible explanation.",
    },
  ]);
});

test("streaming snapshots hide redacted thinking and retain visible thinking", async () => {
  const storage = new MemoryStorage();
  const taskId = await storage.mintId<TaskId>();
  const view = {
    conversation: { id: ROOT_CONVERSATION_ID },
    docs: {
      "pi.live": {
        generation: {
          message: {
            content: [redacted, { text: "Partial answer.", type: "text" }],
          },
        },
        run: { taskId },
      },
    },
    entries: [],
  };
  const snapshot = chatSnapshot({
    address,
    agentVersion: 1,
    approvals: [],
    view,
  });
  assert.equal(snapshot.busy, true);
  assert.deepEqual(snapshot.messages, [
    {
      id: `partial:${taskId}`,
      role: "assistant",
      state: "streaming",
      text: "Partial answer.",
    },
  ]);
  view.docs["pi.live"].generation.message.content.push({
    redacted: false,
    thinking: "Visible explanation.",
    thinkingSignature: "Public block signature.",
    type: "thinking",
  });
  assert.deepEqual(
    chatSnapshot({ address, agentVersion: 1, approvals: [], view }).messages,
    [
      {
        id: `partial:${taskId}`,
        role: "assistant",
        state: "streaming",
        text: "Partial answer.",
        thinking: "Visible explanation.",
      },
    ]
  );
});

test("internal skill results do not require connector grants", () => {
  const snapshot = chatSnapshot({
    address,
    agentVersion: 1,
    approvals: [],
    view: {
      conversation: { id: ROOT_CONVERSATION_ID },
      docs: {},
      entries: [
        {
          id: 1,
          conversationId: ROOT_CONVERSATION_ID,
          kind: "pi.tool",
          model: [
            {
              role: "toolResult",
              toolName: "activate_skill",
              toolCallId: "skill",
              timestamp: 0,
              content: [{ type: "text", text: "Company instructions" }],
              isError: false,
            },
            {
              role: "toolResult",
              toolName: "company_lookup",
              toolCallId: "connector",
              timestamp: 0,
              content: [{ type: "text", text: "Company result" }],
              isError: false,
            },
          ],
        },
      ],
    },
  });
  assert.deepEqual(snapshotToolIds(snapshot), ["company_lookup"]);
  assert.equal(snapshot.messages[0].text, "Company instructions");
});

test("queued inputs retain submission identity and mode while passive writes stay hidden", () => {
  const snapshot = present([], {
    "pi.inbox": {
      items: [
        { content: "Next question.", id: 31, mode: "followUp" },
        {
          content: [
            { text: "Use this image.", type: "text" },
            { data: "private-image", mimeType: "image/png", type: "image" },
          ],
          id: 32,
          mode: "steer",
        },
        { entry: { data: "Hidden write." }, id: 33, mode: "write" },
      ],
    },
  });
  assert.equal(snapshot.busy, true);
  assert.deepEqual(snapshot.queuedInputs, [
    { mode: "followUp", submissionId: "31", text: "Next question." },
    { mode: "steer", submissionId: "32", text: "Use this image.\n[Image]" },
  ]);
  assert.deepEqual(present([]).queuedInputs, []);
});

test("repeated provider call IDs retain distinct tool executions and their ordered results", async () => {
  const first = await presentationEntry(
    fauxAssistantMessage([
      fauxToolCall("company_lookup", { query: "first" }, { id: "reused" }),
      fauxToolCall("company_lookup", { query: "second" }, { id: "reused" }),
    ])
  );
  const firstResult = await presentationEntry(
    toolResult("reused", "First result.")
  );
  const secondResult = await presentationEntry(
    toolResult("reused", "Second call failed.", true)
  );
  const later = await presentationEntry(
    fauxAssistantMessage(
      fauxToolCall("company_lookup", { query: "later" }, { id: "reused" })
    )
  );
  const laterResult = await presentationEntry(
    toolResult("reused", "Later result.")
  );
  const snapshot = present([
    first,
    firstResult,
    secondResult,
    later,
    laterResult,
  ]);
  assert.deepEqual(snapshot.tools, [
    {
      arguments: { query: "first" },
      callId: "reused",
      id: `${first.id}:0:0`,
      messageId: String(first.id),
      output: "First result.",
      resultMessageId: String(firstResult.id),
      state: "succeeded",
      toolName: "company_lookup",
    },
    {
      arguments: { query: "second" },
      callId: "reused",
      id: `${first.id}:0:1`,
      messageId: String(first.id),
      output: "Second call failed.",
      resultMessageId: String(secondResult.id),
      state: "failed",
      toolName: "company_lookup",
    },
    {
      arguments: { query: "later" },
      callId: "reused",
      id: `${later.id}:0:0`,
      messageId: String(later.id),
      output: "Later result.",
      resultMessageId: String(laterResult.id),
      state: "succeeded",
      toolName: "company_lookup",
    },
  ]);
  assert.deepEqual(snapshot.messages[0], {
    entryId: String(first.id),
    id: String(first.id),
    role: "assistant",
    state: "complete",
    text: "",
  });
});

test("compaction entries are context summaries and cannot become fork targets", async () => {
  const entry = await presentationEntry({
    role: "user",
    content: "The durable context summary.",
    timestamp: 0,
  });
  const snapshot = present([{ ...entry, kind: "pi.compaction" }]);
  assert.deepEqual(snapshot.messages, [
    {
      id: String(entry.id),
      kind: "summary",
      role: "assistant",
      state: "complete",
      text: "The durable context summary.",
    },
  ]);
});

test("live slots apply only to the latest unresolved call and never make missing results successful", async () => {
  const old = await presentationEntry(
    fauxAssistantMessage(
      fauxToolCall("company_lookup", { query: "old" }, { id: "reused" })
    )
  );
  const current = await presentationEntry(
    fauxAssistantMessage([
      fauxToolCall("company_lookup", { query: "current" }, { id: "reused" }),
      fauxToolCall("company_lookup", { query: "pending" }, { id: "pending" }),
      fauxToolCall("company_lookup", { query: "faulted" }, { id: "faulted" }),
    ])
  );
  const snapshot = present([old, current], {
    "pi.live": {
      run: { inputs: [], taskId: 41 },
      tools: [
        {
          callId: "reused",
          name: "company_lookup",
          output: "Reading.",
          status: "running",
        },
        { callId: "pending", name: "company_lookup", status: "pending" },
        { callId: "faulted", name: "company_lookup", status: "done" },
      ],
    },
  });
  assert.deepEqual(
    snapshot.tools.map(({ id: toolId, output, state }) => ({
      id: toolId,
      output,
      state,
    })),
    [
      { id: `${old.id}:0:0`, output: "", state: "interrupted" },
      { id: `${current.id}:0:0`, output: "Reading.", state: "running" },
      { id: `${current.id}:0:1`, output: "", state: "pending" },
      { id: `${current.id}:0:2`, output: "", state: "interrupted" },
    ]
  );
  assert.deepEqual(
    present([old]).tools.map((tool) => tool.state),
    ["interrupted"]
  );
});

test("a reused call ID result belongs to its current assistant round after an interrupted request", async () => {
  const old = await presentationEntry(
    fauxAssistantMessage(
      fauxToolCall("company_lookup", { query: "old" }, { id: "reused" })
    )
  );
  const current = await presentationEntry(
    fauxAssistantMessage(
      fauxToolCall("company_lookup", { query: "current" }, { id: "reused" })
    )
  );
  const result = await presentationEntry(toolResult("reused", "Found."));
  const snapshot = present([old, current, result], {
    "pi.live": {
      tools: [
        {
          callId: "reused",
          entry: result.id,
          name: "company_lookup",
          status: "done",
        },
      ],
    },
  });
  assert.deepEqual(snapshot.tools, [
    {
      arguments: { query: "old" },
      callId: "reused",
      id: `${old.id}:0:0`,
      messageId: String(old.id),
      output: "",
      state: "interrupted",
      toolName: "company_lookup",
    },
    {
      arguments: { query: "current" },
      callId: "reused",
      id: `${current.id}:0:0`,
      messageId: String(current.id),
      output: "Found.",
      resultMessageId: String(result.id),
      state: "succeeded",
      toolName: "company_lookup",
    },
  ]);
});

test("tool authorization includes pending and running requests before results exist", async () => {
  const request = await presentationEntry(
    fauxAssistantMessage([
      fauxToolCall("company_pending", { query: "private" }, { id: "pending" }),
      fauxToolCall("company_running", { query: "secret" }, { id: "running" }),
      fauxToolCall("activate_skill", { name: "company" }, { id: "skill" }),
    ])
  );
  const snapshot = present([request], {
    "pi.live": {
      tools: [
        { callId: "pending", name: "company_pending", status: "pending" },
        { callId: "running", name: "company_running", status: "running" },
        { callId: "skill", name: "activate_skill", status: "running" },
      ],
    },
  });
  assert.deepEqual(snapshotToolIds(snapshot), [
    "company_pending",
    "company_running",
  ]);
  assert.deepEqual(
    snapshot.tools.map((tool) => tool.state),
    ["pending", "running", "running"]
  );
});
