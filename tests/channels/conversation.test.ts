import { afterEach, beforeEach, mock, test } from "bun:test";
import assert from "node:assert/strict";

import { Schema } from "effect";

import { JSDOM } from "../../apps/web/node_modules/jsdom";
import { createElement } from "../../apps/web/node_modules/react";
import { renderToString } from "../../apps/web/node_modules/react-dom/server";
import { decodeObservation } from "../../apps/web/src/features/product/observation";
import { ChatSnapshot } from "../../packages/contracts/src/session-service.ts";

mock.module("../../apps/web/src/env.public", () => ({
  ENV: { VITE_SERVER_URL: "http://fixture.invalid" },
}));
const send = (
  controller: ReadableStreamDefaultController<Uint8Array>,
  input: unknown
) => {
  controller.enqueue(
    new TextEncoder().encode(`${JSON.stringify(decodeObservation(input))}\n`)
  );
};
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
const { cacheKey, clearProductCache } =
  await import("../../apps/web/src/features/product/api");
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
    ...overrides,
  });
const renderConversation = () =>
  render(
    createElement(ConversationPanel, {
      agentId: "agent",
      agentName: "Agent",
      conversationId: "conversation",
      userId: "user",
    })
  );

test("saved pending messages do not change the server and initial browser markup", () => {
  sessionStorage.setItem(
    cacheKey("user", "conversation", "pending"),
    JSON.stringify({ operationId: "saved-operation", text: "Saved message" })
  );
  const element = createElement(ConversationPanel, {
    agentId: "agent",
    agentName: "Agent",
    conversationId: "conversation",
    userId: "user",
  });
  const browserMarkup = renderToString(element);
  const windowDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "window"
  );
  const storageDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "sessionStorage"
  );
  assert.ok(windowDescriptor && storageDescriptor);
  Reflect.deleteProperty(globalThis, "window");
  Reflect.deleteProperty(globalThis, "sessionStorage");
  let serverMarkup;
  try {
    serverMarkup = renderToString(element);
  } finally {
    Object.defineProperty(globalThis, "window", windowDescriptor);
    Object.defineProperty(globalThis, "sessionStorage", storageDescriptor);
  }
  assert.equal(browserMarkup, serverMarkup);
  assert.ok(!serverMarkup.includes("Retry message"));
});
const installConversation = (
  initial: ChatSnapshot,
  mutate?: (url: string, body: unknown) => Response | Promise<Response>
) => {
  let latest = initial;
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const requests: { url: string; body: unknown }[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ body, url });
      if (init?.method === "POST") {
        if (!mutate) {
          throw new Error("Unexpected mutation");
        }
        return await mutate(url, body);
      }
      if (url.endsWith("/observations")) {
        let open = true;
        return new Response(
          new ReadableStream({
            cancel: () => {
              open = false;
            },
            start: (controller) => {
              controllers.push(controller);
              send(controller, { snapshot: latest, type: "snapshot" });
              init?.signal?.addEventListener(
                "abort",
                () => {
                  if (open) {
                    open = false;
                    controller.close();
                  }
                },
                { once: true }
              );
            },
          }),
          { headers: { "Content-Type": "application/x-ndjson" } }
        );
      }
      return Response.json({
        ...latest.address,
        mode: "local",
        snapshot: latest,
      });
    },
    writable: true,
  });
  return {
    controllers,
    reconnectWith: (value: ChatSnapshot) => {
      latest = value;
    },
    replace: (value: ChatSnapshot) => {
      latest = value;
      const controller = controllers.at(-1);
      assert.ok(controller);
      send(controller, { snapshot: value, type: "snapshot" });
    },
    requests,
  };
};

test("native snapshots preserve transcript order and stable thinking panels", async () => {
  const first = snapshot({
    busy: true,
    messages: [
      { id: "native-user", role: "user", state: "complete", text: "Question" },
      {
        id: "partial:native-task",
        role: "assistant",
        state: "streaming",
        text: "Answer",
        thinking: "First thought",
      },
    ],
  });
  const server = installConversation(first);
  const view = renderConversation();
  await waitFor(() =>
    assert.ok(
      server.controllers.length > 0 &&
        view.container.textContent?.includes("First thought")
    )
  );
  const details = view.getByText("Thinking").closest("details");
  assert.ok(details);
  details.open = true;
  await act(() =>
    server.replace(
      snapshot({
        ...first,
        messages: [
          first.messages[0],
          { ...first.messages[1], thinking: "First thought continued" },
        ],
      })
    )
  );
  await waitFor(() =>
    assert.ok(details.textContent?.includes("First thought continued"))
  );
  assert.equal(view.getByText("Thinking").closest("details"), details);
  assert.equal(details.open, true);
  assert.deepEqual(
    [...view.container.querySelectorAll(".chat-message > p:last-child")].map(
      (element) => element.textContent
    ),
    ["Question", "Answer"]
  );
  await act(() =>
    server.replace(
      snapshot({
        messages: [
          {
            id: "native-answer",
            role: "assistant",
            state: "complete",
            text: "Completed answer",
          },
          {
            id: "native-user",
            role: "user",
            state: "complete",
            text: "Question",
          },
        ],
      })
    )
  );
  assert.deepEqual(
    [...view.container.querySelectorAll(".chat-message > p:last-child")].map(
      (element) => element.textContent
    ),
    ["Completed answer", "Question"]
  );
  assert.equal(view.container.textContent?.includes("First thought"), false);
});

test("Send remains available during native work and retry preserves the pending operation ID", async () => {
  const key = cacheKey("user", "conversation", "pending");
  sessionStorage.setItem(
    key,
    JSON.stringify({ operationId: "native-operation", text: "Queued question" })
  );
  let submissions = 0;
  const server = installConversation(snapshot({ busy: true }), (_url, body) => {
    submissions += 1;
    assert.deepEqual(body, {
      operationId: "native-operation",
      text: "Queued question",
    });
    if (submissions === 1) {
      return Response.json({ message: "Retry the request" }, { status: 503 });
    }
    return Response.json({
      receipt: {
        accepted: false,
        operationId: "native-operation",
        session: "native-pi-session",
      },
    });
  });
  const view = renderConversation();
  const retry = view.getByRole("button", { name: "Retry message" });
  await waitFor(() => assert.equal(retry.disabled, false));
  await act(() => retry.click());
  await waitFor(() => assert.equal(retry.disabled, false));
  assert.deepEqual(JSON.parse(sessionStorage.getItem(key) ?? "null"), {
    operationId: "native-operation",
    text: "Queued question",
  });
  await act(() => retry.click());
  await waitFor(() => assert.equal(sessionStorage.getItem(key), null));
  assert.equal(submissions, 2);
  assert.equal(view.container.querySelector("textarea")?.disabled, false);
  assert.equal(view.container.querySelector("select"), null);
  assert.deepEqual(
    server.requests
      .filter((item) => item.url.endsWith("/messages"))
      .map((item) => item.body),
    [
      { operationId: "native-operation", text: "Queued question" },
      { operationId: "native-operation", text: "Queued question" },
    ]
  );
});

test("the composer sends a new message while the native session is busy", async () => {
  const server = installConversation(snapshot({ busy: true }), (_url, body) => {
    assert.ok(body && typeof body === "object" && "operationId" in body);
    return Response.json({
      receipt: {
        accepted: true,
        operationId: body.operationId,
        session: "native-pi-session",
      },
    });
  });
  const view = renderConversation();
  const input = view.getByRole("textbox", { name: "Message" });
  await waitFor(() => assert.equal(input.disabled, false));
  await act(() =>
    fireEvent.change(input, { target: { value: "Next question" } })
  );
  await act(() => fireEvent.submit(input.closest("form")));
  await waitFor(() =>
    assert.equal(
      server.requests.filter((item) => item.url.endsWith("/messages")).length,
      1
    )
  );
  const submitted = server.requests.find((item) =>
    item.url.endsWith("/messages")
  );
  assert.ok(
    submitted?.body &&
      typeof submitted.body === "object" &&
      "operationId" in submitted.body
  );
  assert.ok("text" in submitted.body);
  assert.equal(submitted.body.text, "Next question");
  assert.equal(typeof submitted.body.operationId, "string");
});

test("Stop controls the native session and approvals send only the decision", async () => {
  const approval = {
    approvalId: "native-approval",
    arguments: { title: "Ticket" },
    callId: "native-call",
    expiresAt: Date.now() + 60_000,
    operationId: "tool-operation",
    state: "pending",
    taskId: "native-task",
    toolId: "write-ticket",
  };
  const first = Schema.decodeUnknownSync(ChatSnapshot)({
    ...snapshot(),
    approvals: [approval],
    busy: true,
  });
  const server = installConversation(first, (url, body) =>
    url.endsWith("/stop")
      ? Response.json({ stopped: true })
      : Response.json({
          approval: {
            ...approval,
            state:
              body &&
              typeof body === "object" &&
              "decision" in body &&
              body.decision === "allow"
                ? "allowed"
                : "denied",
          },
        })
  );
  const view = renderConversation();
  const stop = await view.findByRole("button", { name: "Stop" });
  await waitFor(() => assert.equal(stop.disabled, false));
  assert.ok(view.container.textContent?.includes('"title": "Ticket"'));
  await act(() =>
    view.getByRole("button", { name: "Approve request" }).click()
  );
  await act(() =>
    server.replace(
      Schema.decodeUnknownSync(ChatSnapshot)({
        ...first,
        approvals: [{ ...approval, approvalId: "native-denial" }],
      })
    )
  );
  await waitFor(() =>
    assert.equal(
      view.getByRole("button", { name: "Deny request" }).disabled,
      false
    )
  );
  await act(() => view.getByRole("button", { name: "Deny request" }).click());
  await waitFor(() => assert.equal(stop.disabled, false));
  await act(() => stop.click());
  assert.deepEqual(
    server.requests.filter((item) => item.body !== null),
    [
      {
        body: { decision: "allow" },
        url: "http://fixture.invalid/api/product/conversations/conversation/approvals/native-approval",
      },
      {
        body: { decision: "deny" },
        url: "http://fixture.invalid/api/product/conversations/conversation/approvals/native-denial",
      },
      {
        body: {},
        url: "http://fixture.invalid/api/product/conversations/conversation/stop",
      },
    ]
  );
  assert.ok(
    server.requests.some((item) =>
      item.url.endsWith("/approvals/native-approval")
    )
  );
  assert.ok(server.requests.some((item) => item.url.endsWith("/stop")));
  await act(() =>
    server.replace(
      Schema.decodeUnknownSync(ChatSnapshot)({
        ...first,
        approvals: [{ ...approval, state: "allowed" }],
        busy: false,
      })
    )
  );
  assert.equal(view.queryByRole("button", { name: "Approve request" }), null);
  assert.equal(view.queryByRole("button", { name: "Stop" }), null);
});

test("Reconnect replaces the entire transcript from a fresh native snapshot", async () => {
  const server = installConversation(
    snapshot({
      messages: [
        {
          id: "native-old",
          role: "assistant",
          state: "complete",
          text: "Old answer",
        },
      ],
    })
  );
  const view = renderConversation();
  await waitFor(() =>
    assert.ok(view.container.textContent?.includes("Old answer"))
  );
  await act(() => view.getByRole("button", { name: "Disconnect" }).click());
  server.reconnectWith(
    snapshot({
      messages: [
        {
          id: "native-new",
          role: "assistant",
          state: "complete",
          text: "Fresh answer",
        },
      ],
    })
  );
  await act(() => view.getByRole("button", { name: "Reconnect" }).click());
  await waitFor(() =>
    assert.ok(view.container.textContent?.includes("Fresh answer"))
  );
  assert.equal(view.container.textContent?.includes("Old answer"), false);
  assert.equal(
    server.requests.filter((item) => item.url.endsWith("/observations")).length,
    2
  );
  assert.equal(
    server.requests.some((item) => item.body !== null),
    false
  );
});

test("signout clears visible private content, pending retry, and the observation attachment", async () => {
  const key = cacheKey("user", "conversation", "pending");
  sessionStorage.setItem(
    key,
    JSON.stringify({
      operationId: "pending-operation",
      text: "Private pending message",
    })
  );
  const server = installConversation(
    snapshot({
      messages: [
        {
          id: "native-private",
          role: "assistant",
          state: "complete",
          text: "Private answer",
        },
      ],
    })
  );
  const view = renderConversation();
  await waitFor(() =>
    assert.ok(view.container.textContent?.includes("Private answer"))
  );
  await act(() => clearProductCache());
  assert.equal(sessionStorage.getItem(key), null);
  assert.equal(view.container.textContent?.includes("Private answer"), false);
  assert.equal(view.queryByRole("button", { name: "Retry message" }), null);
  assert.equal(view.queryByRole("textbox", { name: "Message" }), null);
  assert.equal(
    view.getByRole("alert").textContent,
    "Conversation access is no longer available."
  );
  assert.equal(
    server.requests.filter((item) => item.url.endsWith("/observations")).length,
    1
  );
});
