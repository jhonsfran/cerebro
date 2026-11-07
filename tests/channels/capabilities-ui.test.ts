import { afterEach, beforeEach, mock, test } from "bun:test";
import assert from "node:assert/strict";

import { Schema } from "effect";

import { JSDOM } from "../../apps/web/node_modules/jsdom";
import { createElement } from "../../apps/web/node_modules/react";
import type { LoadedConversation } from "../../apps/web/src/features/product/types";
import {
  ChatControl,
  ChatSnapshot,
} from "../../packages/contracts/src/session-service.ts";
import { loadedConversation } from "./conversation-ui-data.ts";
import { inspectionOverview } from "./inspection-ui-data.ts";

mock.module("../../apps/web/src/env.public", () => ({
  ENV: { VITE_SERVER_URL: "http://fixture.invalid" },
}));

const globalNames = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "getComputedStyle",
  "sessionStorage",
  "Event",
  "requestAnimationFrame",
  "cancelAnimationFrame",
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
    pretendToBeVisual: true,
    url: "http://fixture.invalid",
  });
  for (const name of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "getComputedStyle",
    "sessionStorage",
    "Event",
    "requestAnimationFrame",
    "cancelAnimationFrame",
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
    activity: { compactions: [], reminders: [], tasks: [] },
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
      if (url.endsWith("/inspection")) {
        return Response.json({
          ...inspectionOverview(),
          address: initial.address,
        });
      }
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
  return { replace: send, requests, loaded: loadedConversation(initial) };
};
const renderConversation = (loaded: LoadedConversation) =>
  render(
    createElement(ConversationPanel, {
      agentId: "agent",
      agentName: "Agent",
      conversationId: "conversation",
      userId: "user",
      loaded,
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

test("scheduled follow-ups preserve retry intent, recurrence timezone and explicit future cancellation", async () => {
  let attempts = 0;
  const commands: ChatControl[] = [];
  const server = installConversation(
    snapshot({
      activity: {
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
  const view = renderConversation(server.loaded);
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
    fireEvent.click(view.getByRole("combobox", { name: "Repeat" }));
  });
  const monthly = await view.findByRole("option", { name: "Every month" });
  await act(() => {
    fireEvent.pointerDown(monthly);
    fireEvent.click(monthly);
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
  const view = renderConversation(server.loaded);
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
