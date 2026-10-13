import assert from "node:assert/strict";
import { test } from "node:test";

import { id } from "../../packages/contracts/src/identity.ts";
import { fauxAssistantMessage } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  MemoryStorage,
  ROOT_CONVERSATION_ID,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import type {
  EntryId,
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
      id: `${entryId}:0`,
      role: "assistant",
      state: "complete",
      text: "Visible answer.",
    },
    {
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
