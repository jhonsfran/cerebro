import { afterEach, beforeEach, mock, test } from "bun:test";
import assert from "node:assert/strict";

import { Schema } from "effect";

import { JSDOM } from "../../apps/web/node_modules/jsdom";
import { createElement } from "../../apps/web/node_modules/react";
import {
  ChatControl,
  ChatSnapshot,
} from "../../packages/contracts/src/session-service.ts";

mock.module("../../apps/web/src/env.public", () => ({
  ENV: { VITE_SERVER_URL: "http://fixture.invalid" },
}));

const globalNames = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "sessionStorage",
  "Event",
  "fetch",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
const originalGlobals = globalNames.map((name) => ({
  descriptor: Object.getOwnPropertyDescriptor(globalThis, name),
  name,
}));
let dom: JSDOM;
const installDom = () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://fixture.invalid",
  });
  for (const name of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "sessionStorage",
    "Event",
  ] as const) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: dom.window[name],
      writable: true,
    });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
    writable: true,
  });
  dom.window.HTMLElement.prototype.scrollTo = () => {};
};
installDom();
const { act, cleanup, fireEvent, render, waitFor } =
  await import("../../apps/web/node_modules/@testing-library/react");
const { ConversationPanel } =
  await import("../../apps/web/src/features/product/conversation");
dom.window.close();
beforeEach(installDom);
afterEach(() => {
  cleanup();
  dom.window.close();
  for (const { descriptor, name } of originalGlobals) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, name);
    }
  }
});

const snapshot = (overrides: Partial<ChatSnapshot> = {}): ChatSnapshot =>
  Schema.decodeUnknownSync(ChatSnapshot)({
    activity: { children: [], compactions: [], reminders: [], tasks: [] },
    address: {
      agentId: "agent",
      conversationId: "conversation",
      organizationId: "company",
      sessionId: "session",
    },
    agentVersion: 1,
    approvals: [],
    busy: false,
    messages: [],
    queuedInputs: [],
    tools: [],
    ...overrides,
  });

const installConversation = (
  initial: ChatSnapshot,
  mutation: (url: string, body: unknown) => Response
) => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const send = (value: ChatSnapshot) => {
    assert.ok(controller);
    controller.enqueue(
      new TextEncoder().encode(
        `${JSON.stringify({ snapshot: value, type: "snapshot" })}\n`
      )
    );
  };
  const requests: { url: string; body: unknown }[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        const body: unknown = JSON.parse(String(init.body));
        requests.push({ body, url });
        return mutation(url, body);
      }
      if (url.endsWith("/observations")) {
        return new Response(
          new ReadableStream({
            start: (stream) => {
              controller = stream;
              send(initial);
            },
          }),
          { headers: { "Content-Type": "application/x-ndjson" } }
        );
      }
      return Response.json({
        ...initial.address,
        mode: "local",
        snapshot: initial,
      });
    },
  });
  return { replace: send, requests };
};
const renderConversation = (
  onConversation?: (conversationId: string) => void
) =>
  render(
    createElement(ConversationPanel, {
      agentId: "agent",
      agentName: "Agent",
      conversationId: "conversation",
      onConversation,
      userId: "user",
    })
  );
const openActivity = (container: HTMLElement) => {
  for (const details of container.querySelectorAll(
    ".conversation-activity details"
  )) {
    assert.ok(details instanceof dom.window.HTMLDetailsElement);
    details.open = true;
  }
};

test("fork controls use native completed entries, keep the retry ID and navigate to the result", async () => {
  let attempts = 0;
  const server = installConversation(
    snapshot({
      messages: [
        {
          entryId: "entry-user",
          id: "user",
          role: "user",
          state: "complete",
          text: "Question",
        },
        {
          id: "answer",
          role: "assistant",
          state: "complete",
          text: "No native entry",
        },
        {
          entryId: "partial",
          id: "stream",
          role: "assistant",
          state: "streaming",
          text: "Streaming",
        },
        {
          entryId: "tool",
          id: "result",
          role: "tool",
          state: "complete",
          text: "Tool output",
        },
      ],
    }),
    () => {
      attempts += 1;
      return attempts === 1
        ? Response.json({ message: "Response lost. Retry." }, { status: 503 })
        : Response.json({
            agentId: "agent",
            conversationId: "fork",
            sessionId: "fork-session",
          });
    }
  );
  const navigated: string[] = [];
  const view = renderConversation((value) => navigated.push(value));
  await waitFor(() =>
    assert.equal(
      view.getByRole<HTMLButtonElement>("button", {
        name: "Fork from this message",
      }).disabled,
      false
    )
  );
  assert.equal(
    view.getAllByRole("button", { name: "Fork from this message" }).length,
    1
  );
  await act(() =>
    view.getByRole("button", { name: "Fork from this message" }).click()
  );
  await waitFor(() =>
    assert.match(view.getByRole("alert").textContent ?? "", /Response lost/u)
  );
  await act(() =>
    view.getByRole("button", { name: "Fork from this message" }).click()
  );
  await waitFor(() => assert.deepEqual(navigated, ["fork"]));
  assert.equal(server.requests.length, 2);
  assert.deepEqual(server.requests[0], server.requests[1]);
  assert.ok(server.requests[0]?.url.endsWith("/conversation/fork"));
  assert.ok(
    server.requests[0]?.body &&
      typeof server.requests[0].body === "object" &&
      "entryId" in server.requests[0].body
  );
  assert.equal(server.requests[0].body.entryId, "entry-user");
});

test("subagent work and ownership are visible and child approval stays on the parent route", async () => {
  const initial = snapshot({
    activity: {
      children: [
        {
          callId: "delegate-call",
          id: "child",
          ownerTaskId: "delegate-task",
          purpose: "delegate",
          state: "running",
          title: "Check imports",
          messages: [
            {
              id: "child-message",
              role: "assistant",
              state: "complete",
              text: "I will check the imports.",
            },
          ],
          tools: [
            {
              arguments: { query: "imports" },
              callId: "child-call",
              id: "child-tool",
              messageId: "child-message",
              output: "Waiting for approval",
              state: "pending",
              toolName: "write-ticket",
            },
          ],
        },
      ],
      compactions: [],
      reminders: [],
      tasks: [
        {
          background: false,
          conversationId: "child",
          id: "child-task",
          kind: "Tool",
          ownerTaskId: "delegate-task",
          state: "waiting",
        },
      ],
      origin: { conversationId: "parent", entryId: "parent-entry" },
    },
    approvals: [
      {
        approvalId: "child-approval",
        arguments: { title: "Import ticket" },
        callId: "child-call",
        expiresAt: Date.now() + 60_000,
        operationId: "child-operation",
        state: "pending",
        taskId: "child-task",
        toolId: "write-ticket",
      },
    ],
    messages: [
      {
        id: "parent-message",
        role: "assistant",
        state: "complete",
        text: "Parent work",
      },
    ],
    tools: [
      {
        arguments: { title: "Different parent ticket" },
        callId: "child-call",
        id: "parent-tool",
        messageId: "parent-message",
        output: "Parent running",
        state: "running",
        toolName: "write-ticket",
      },
    ],
  });
  const server = installConversation(initial, (url, body) =>
    url.endsWith("/control")
      ? Response.json({
          id: "child",
          kind: Schema.decodeUnknownSync(ChatControl)(body).kind,
        })
      : Response.json({
          approval: { approvalId: "child-approval", state: "allowed" },
        })
  );
  const navigated: string[] = [];
  const view = renderConversation((value) => navigated.push(value));
  await waitFor(() =>
    assert.equal(
      view.getByRole<HTMLButtonElement>("button", { name: "Approve request" })
        .disabled,
      false
    )
  );
  await act(() => openActivity(view.container));
  assert.equal(
    view.getByText("I will check the imports.").textContent,
    "I will check the imports."
  );
  assert.ok(
    view
      .getByRole("article", { name: "write-ticket Waiting" })
      .textContent?.includes("Waiting for approval")
  );
  assert.ok(view.getByText("Task child-task · Owned by task delegate-task"));
  assert.equal(
    view
      .getByRole("article", { name: "write-ticket Running" })
      .querySelectorAll(".approval-card").length,
    0
  );
  await act(() =>
    view.getByRole("button", { name: "Approve request" }).click()
  );
  await waitFor(() =>
    assert.equal(
      view.getByRole<HTMLButtonElement>("button", { name: "Stop subagent" })
        .disabled,
      false
    )
  );
  await act(() => view.getByRole("button", { name: "Stop subagent" }).click());
  await waitFor(() => assert.equal(server.requests.length, 2));
  assert.deepEqual(
    server.requests.map((item) => item.body),
    [{ decision: "allow" }, { childId: "child", kind: "stop-child" }]
  );
  assert.ok(
    server.requests[0]?.url.endsWith("/conversation/approvals/child-approval")
  );
  await act(() =>
    view.getByRole("button", { name: "parent conversation" }).click()
  );
  assert.deepEqual(navigated, ["parent"]);
});

test("scheduled follow-ups preserve retry intent, recurrence timezone and explicit future cancellation", async () => {
  let attempts = 0;
  const commands: ChatControl[] = [];
  installConversation(
    snapshot({
      activity: {
        children: [],
        compactions: [],
        tasks: [],
        reminders: [
          {
            id: "existing",
            instruction: "Check the import",
            runAt: Date.now() + 60_000,
            state: "scheduled",
          },
        ],
      },
    }),
    (_url, body) => {
      const command = Schema.decodeUnknownSync(ChatControl)(body);
      commands.push(command);
      attempts += 1;
      return attempts === 1
        ? Response.json(
            { message: "Try the same schedule again." },
            { status: 503 }
          )
        : Response.json({ id: "schedule", kind: command.kind });
    }
  );
  const view = renderConversation();
  await waitFor(() =>
    assert.ok(view.queryByRole("region", { name: "Conversation activity" }))
  );
  await act(() => openActivity(view.container));
  const instruction = view.getByRole("textbox", { name: "Instruction" });
  const firstRun = view.getByLabelText("First run (your local time)");
  const date = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  const future = date.toISOString().slice(0, 16);
  await act(() => {
    fireEvent.change(instruction, {
      target: { value: "Inspect the next import" },
    });
    fireEvent.change(firstRun, { target: { value: future } });
    fireEvent.change(view.getByRole("combobox", { name: "Repeat" }), {
      target: { value: "month" },
    });
  });
  await act(() => {
    fireEvent.change(view.getByLabelText("Repeat interval"), {
      target: { value: "2" },
    });
    fireEvent.change(view.getByRole("textbox", { name: "Repeat timezone" }), {
      target: { value: "America/Bogota" },
    });
  });
  await act(() => fireEvent.submit(instruction.closest("form")));
  await waitFor(() =>
    assert.ok(
      view
        .getByRole("alert")
        .textContent?.includes("Try the same schedule again.")
    )
  );
  await act(() => fireEvent.submit(instruction.closest("form")));
  await waitFor(() => assert.equal(commands.length, 2));
  assert.deepEqual(commands[0], commands[1]);
  assert.ok(commands[0]?.kind === "schedule");
  assert.deepEqual(commands[0].recurrence, {
    interval: 2,
    timezone: "America/Bogota",
    unit: "month",
  });
  assert.equal(commands[0].runAt, new Date(future).getTime());
  await waitFor(() =>
    assert.equal(
      view.getByRole<HTMLTextAreaElement>("textbox", { name: "Instruction" })
        .value,
      ""
    )
  );
  await act(() =>
    view.getByRole("button", { name: "Cancel future runs" }).click()
  );
  await waitFor(() => assert.equal(commands.length, 3));
  assert.deepEqual(commands[2], {
    kind: "cancel-schedule",
    scheduleId: "existing",
  });
  assert.ok(view.getByText(/Future follow-ups remain scheduled/u));
});

test("compaction status and failures render and a failed command retries with the same ID", async () => {
  const initial = snapshot({
    activity: {
      children: [],
      reminders: [],
      tasks: [],
      compactions: [
        {
          attempt: 2,
          blocking: true,
          id: "compact-task",
          reason: "overflow",
          retryAt: Date.now() + 1000,
        },
      ],
    },
  });
  let attempts = 0;
  const server = installConversation(initial, (_url, body) => {
    attempts += 1;
    return attempts === 1
      ? Response.json({ message: "Compaction response lost." }, { status: 503 })
      : Response.json({
          id: "new-compact",
          kind: Schema.decodeUnknownSync(ChatControl)(body).kind,
        });
  });
  const view = renderConversation();
  await waitFor(() =>
    assert.ok(view.queryByRole("region", { name: "Conversation activity" }))
  );
  await act(() => openActivity(view.container));
  assert.match(
    view.getByText(/Compacting \(overflow\)/u).textContent ?? "",
    /Attempt 2 · Generation waits/u
  );
  assert.equal(
    view.getByRole<HTMLButtonElement>("button", { name: "Compact context" })
      .disabled,
    true
  );
  await act(() =>
    server.replace(
      snapshot({
        activity: {
          children: [],
          reminders: [],
          tasks: [],
          compactions: [],
          compactionFailure: "Summary provider unavailable",
        },
      })
    )
  );
  await waitFor(() =>
    assert.equal(
      view.getByRole<HTMLButtonElement>("button", { name: "Compact context" })
        .disabled,
      false
    )
  );
  assert.ok(view.getByText("Summary provider unavailable"));
  await act(() =>
    view.getByRole("button", { name: "Compact context" }).click()
  );
  await waitFor(() => assert.ok(view.getByText("Compaction response lost.")));
  await act(() =>
    view.getByRole("button", { name: "Compact context" }).click()
  );
  await waitFor(() => assert.equal(server.requests.length, 2));
  assert.deepEqual(server.requests[0], server.requests[1]);
});
