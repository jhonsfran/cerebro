import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hydrateChatHistory,
  normalizeChatRequest,
  projectSessionItem,
  reconcileChatHistory,
} from "../../apps/server/src/chat-protocol.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import type { StoredRun } from "../../packages/runtime/src/ledger.ts";

const identity = {
  authSessionId: "auth-session-a",
  conversationId: "conversation-a",
  userId: "user-a",
};
const request = (body: unknown) => ({
  id: "request-a",
  init: { body: JSON.stringify(body), method: "POST" },
  type: "chat-request" as const,
});
const user = {
  id: "message-a",
  parts: [{ text: "Hello", type: "text" as const }],
  role: "user" as const,
};

test("chat submission replaces forged history and identity with server values", () => {
  const history = [
    {
      id: "prior",
      parts: [{ text: "Saved", type: "text" as const }],
      role: "assistant" as const,
    },
  ];
  const normalized = normalizeChatRequest(
    request({
      authSessionId: "forged-session",
      conversationId: "other-company",
      messages: [
        {
          id: "prior",
          parts: [{ text: "Forged", type: "text" }],
          role: "system",
        },
        user,
      ],
      runId: "forged-run",
      userId: "other-user",
    }),
    history,
    identity
  );
  assert.deepEqual(normalized, {
    body: { ...identity, eventId: "message-a", text: "Hello" },
    messages: [...history, user],
  });
  assert.equal(history.length, 1);
});

test("message retries preserve saved history and reject changed content", () => {
  const history = [user];
  assert.deepEqual(
    normalizeChatRequest(request({ messages: [user] }), history, identity)
      .messages,
    [user]
  );
  assert.throws(
    () =>
      normalizeChatRequest(
        request({
          messages: [{ ...user, parts: [{ text: "Changed", type: "text" }] }],
        }),
        history,
        identity
      ),
    { code: "digest-mismatch", status: 409 }
  );
});

test("chat submission rejects regeneration, client tools, metadata and nontext edits", () => {
  for (const body of [
    { messages: [user], trigger: "regenerate-message" },
    { clientTools: [{ name: "execute" }], messages: [user] },
    { messages: [{ ...user, metadata: { userId: "forged" } }] },
    {
      messages: [
        { ...user, parts: [{ input: "forged", type: "tool-execute" }] },
      ],
    },
    { messages: [{ ...user, role: "assistant" }] },
    { messages: [{ ...user, id: "" }] },
    { messages: [{ ...user, id: " message-a " }] },
    { messages: [{ ...user, parts: [{ text: " ", type: "text" }] }] },
    {
      messages: [
        { ...user, parts: [{ text: "a".repeat(16_001), type: "text" }] },
      ],
    },
  ]) {
    assert.throws(() => normalizeChatRequest(request(body), [], identity), {
      status: 422,
    });
  }
  assert.throws(
    () =>
      normalizeChatRequest(
        { ...request({ messages: [user] }), id: "" },
        [],
        identity
      ),
    { status: 422 }
  );
});

test("chat submission joins text parts and removes surrounding whitespace", () => {
  const normalized = normalizeChatRequest(
    request({
      messages: [
        {
          ...user,
          parts: [
            { text: " Hello", type: "text" },
            { text: " there ", type: "text" },
          ],
        },
      ],
    }),
    [],
    identity
  );
  assert.deepEqual(normalized.messages, [
    { ...user, parts: [{ text: "Hello there", type: "text" }] },
  ]);
  assert.equal(normalized.body.text, "Hello there");
});

const legacyRun: StoredRun = {
  agent: {
    agentId: id.agent("agent-a"),
    enabledToolIds: [],
    instructions: "Answer the message.",
    model: "opencode/free",
    organizationId: id.organization("company-a"),
    version: 1,
  },
  context: {
    actor: {
      id: id.principal("user-a"),
      kind: "human",
      organizationId: id.organization("company-a"),
      state: "active",
    },
  },
  createdAt: 1,
  eventId: id.event("event-a"),
  operationId: id.operation("operation-a"),
  output: "Saved answer",
  prompt: "Saved question",
  requestDigest: id.digest("digest-a"),
  runId: id.run("run-a"),
  state: "completed",
};

test("legacy history keeps user prompts, assistant IDs and projected run details", () => {
  const item = projectSessionItem(
    {
      cursor: "1",
      run: { completedAt: 2, runId: id.run("run-a"), state: "completed" },
      type: "run",
    },
    "conversation-a"
  );
  assert.deepEqual(hydrateChatHistory([legacyRun], [item]), [
    {
      id: "event-a",
      parts: [{ text: "Saved question", type: "text" }],
      role: "user",
    },
    {
      id: "assistant:run-a",
      parts: [
        { text: "Saved answer", type: "text" },
        { data: item, id: "session:1", type: "data-conversation-item" },
      ],
      role: "assistant",
    },
  ]);
});

test("legacy history follows admission time and retains failed run details", () => {
  const failed = {
    ...legacyRun,
    createdAt: 3,
    eventId: id.event("event-b"),
    output: undefined,
    runId: id.run("run-b"),
    state: "failed" as const,
  };
  const item = projectSessionItem(
    {
      cursor: "4",
      run: { endedAt: 4, runId: failed.runId, state: "failed" },
      type: "run",
    },
    "conversation-a"
  );
  const runs = [failed, legacyRun];
  const messages = hydrateChatHistory(runs, [item]);
  assert.deepEqual(
    messages.map((message) => message.id),
    ["event-a", "assistant:run-a", "event-b", "assistant:run-b"]
  );
  assert.deepEqual(messages.at(-1)?.parts, [
    { data: item, id: "session:4", type: "data-conversation-item" },
  ]);
  assert.equal(runs[0], failed);
});

test("chat history restores a missing completed run after existing SDK history", () => {
  const history = [
    {
      id: "earlier-user",
      parts: [{ text: "Earlier question", type: "text" as const }],
      role: "user" as const,
    },
    {
      id: "assistant:earlier-run",
      parts: [{ text: "Earlier answer", type: "text" as const }],
      role: "assistant" as const,
    },
  ];
  const earlier = {
    ...legacyRun,
    createdAt: 0,
    eventId: id.event("earlier-user"),
    output: "Earlier answer",
    prompt: "Earlier question",
    runId: id.run("earlier-run"),
  };
  const messages = reconcileChatHistory(history, [earlier, legacyRun], []);
  assert.deepEqual(messages, [
    {
      id: "earlier-user",
      parts: [{ text: "Earlier question", type: "text" }],
      role: "user",
    },
    {
      id: "assistant:earlier-run",
      parts: [{ text: "Earlier answer", type: "text" }],
      role: "assistant",
    },
    {
      id: "event-a",
      parts: [{ text: "Saved question", type: "text" }],
      role: "user",
    },
    {
      id: "assistant:run-a",
      parts: [{ text: "Saved answer", type: "text" }],
      role: "assistant",
    },
  ]);
  assert.deepEqual(
    reconcileChatHistory(messages, [earlier, legacyRun], []),
    messages
  );
  assert.equal(messages[1], history[1]);
});

test("chat history preserves active SDK parts and does not add an active placeholder", () => {
  const active = { ...legacyRun, output: undefined, state: "running" as const };
  const history = [
    {
      id: "event-a",
      parts: [{ text: "Saved question", type: "text" as const }],
      role: "user" as const,
    },
    {
      id: "assistant:run-a",
      parts: [
        { text: "An answer in progress", type: "text" as const },
        { text: "Reasoning in progress", type: "reasoning" as const },
      ],
      role: "assistant" as const,
    },
  ];
  const item = projectSessionItem(
    {
      cursor: "1",
      run: { runId: active.runId, state: "running" },
      type: "run",
    },
    "conversation-a"
  );
  const messages = reconcileChatHistory(history, [active], []);
  assert.deepEqual(messages, [
    {
      id: "event-a",
      parts: [{ text: "Saved question", type: "text" }],
      role: "user",
    },
    {
      id: "assistant:run-a",
      parts: [
        { text: "An answer in progress", type: "text" },
        { text: "Reasoning in progress", type: "reasoning" },
      ],
      role: "assistant",
    },
  ]);
  assert.equal(messages[1], history[1]);
  assert.deepEqual(
    reconcileChatHistory(history.slice(0, 1), [active], [item]),
    [
      {
        id: "event-a",
        parts: [{ text: "Saved question", type: "text" }],
        role: "user",
      },
    ]
  );
});

test("terminal ledger output repairs a partial SDK assistant without deleting its parts", () => {
  const history = [
    {
      id: "event-a",
      parts: [{ text: "Saved question", type: "text" as const }],
      role: "user" as const,
    },
    {
      id: "assistant:run-a",
      parts: [{ text: "Partial answer", type: "text" as const }],
      role: "assistant" as const,
    },
  ];
  const items = [
    projectSessionItem(
      {
        cursor: "2",
        dependencies: { sourceIds: [], toolIds: [] },
        runId: legacyRun.runId,
        text: "Saved answer",
        type: "output",
      },
      "conversation-a"
    ),
    projectSessionItem(
      {
        cursor: "3",
        run: { completedAt: 2, runId: legacyRun.runId, state: "completed" },
        type: "run",
      },
      "conversation-a"
    ),
  ];
  const messages = reconcileChatHistory(history, [legacyRun], items);
  assert.deepEqual(messages[1], {
    id: "assistant:run-a",
    parts: [
      { text: "Partial answer", type: "text" },
      {
        data: {
          cursor: "session:2",
          dependencies: { sourceIds: [], toolIds: [] },
          runId: "run-a",
          text: "Saved answer",
          type: "output",
        },
        id: "session:2",
        type: "data-conversation-item",
      },
      {
        data: {
          cursor: "session:3",
          run: { completedAt: 2, runId: "run-a", state: "completed" },
          runId: "run-a",
          type: "run",
        },
        id: "session:3",
        type: "data-conversation-item",
      },
    ],
    role: "assistant",
  });
  assert.deepEqual(
    reconcileChatHistory(messages, [legacyRun], items),
    messages
  );
  assert.deepEqual(history[1].parts, [
    { text: "Partial answer", type: "text" },
  ]);
});

test("chat history maps hashed admission IDs to durable client message IDs", () => {
  const run = { ...legacyRun, eventId: id.event("event:admission-hash") };
  const admitted = new Map([[run.runId, "client-uuid"]]);
  const messages = reconcileChatHistory([], [run], [], admitted);
  assert.equal(messages[0]?.id, "client-uuid");
  assert.equal(messages.filter((message) => message.role === "user").length, 1);
  assert.deepEqual(
    reconcileChatHistory(messages, [run], [], admitted),
    messages
  );
});

test("chat history uses saved acknowledgements to remove hashed user duplicates", () => {
  const run = { ...legacyRun, eventId: id.event("event:admission-hash") };
  const clientMessage = {
    id: "client-uuid",
    parts: [{ text: run.prompt, type: "text" as const }],
    role: "user" as const,
  };
  const assistant = {
    id: `assistant:${run.runId}`,
    parts: [
      { text: run.output ?? "", type: "text" as const },
      {
        data: {
          cursor: "chat:client-uuid",
          eventId: "client-uuid",
          runId: run.runId,
          text: run.prompt,
          type: "user" as const,
        },
        id: "user:client-uuid",
        type: "data-conversation-item" as const,
      },
    ],
    role: "assistant" as const,
  };
  const duplicate = { ...clientMessage, id: run.eventId };
  const messages = reconcileChatHistory(
    [clientMessage, duplicate, assistant],
    [run],
    []
  );
  assert.deepEqual(messages, [clientMessage, assistant]);
  assert.deepEqual(reconcileChatHistory(messages, [run], []), messages);
});

test("session citations and tool results retain dependencies with distinct cursors", () => {
  const dependencies = {
    sourceIds: [id.source("source/a")],
    toolIds: ["lookup"],
  };
  assert.deepEqual(
    projectSessionItem(
      {
        citation: {
          observedAt: 2,
          sourceId: id.source("source/a"),
          sourceUri: "company://policy",
          sourceVersion: "v1",
        },
        cursor: "2",
        dependencies,
        runId: id.run("run-a"),
        type: "citation",
      },
      "conversation:a"
    ),
    {
      cursor: "session:2",
      dependencies,
      href: "/api/product/conversations/conversation%3Aa/sources/source%2Fa",
      runId: "run-a",
      sourceId: "source/a",
      sourceVersion: "v1",
      title: "company://policy",
      type: "citation",
    }
  );
  assert.deepEqual(
    projectSessionItem(
      {
        cursor: "3",
        dependencies,
        operationId: id.operation("lookup-a"),
        output: { found: true },
        runId: id.run("run-a"),
        toolId: "lookup",
        type: "tool",
      },
      "conversation-a"
    ),
    {
      cursor: "session:3",
      dependencies,
      name: "lookup",
      operationId: "lookup-a",
      output: { found: true },
      runId: "run-a",
      state: "succeeded",
      toolId: "lookup",
      type: "tool",
    }
  );
});
