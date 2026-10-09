import { afterEach, beforeEach, mock, test } from "bun:test";
import assert from "node:assert/strict";

import { JSDOM } from "../../apps/web/node_modules/jsdom";
import { createElement } from "../../apps/web/node_modules/react";
import {
  createProtocolProjection,
  decodeObservation,
  observationIdentity,
} from "../../packages/ag-ui/src/protocol.ts";

mock.module("../../apps/web/src/env.public", () => ({
  ENV: { VITE_SERVER_URL: "http://fixture.invalid" },
}));
const { act, cleanup, render, waitFor } =
  await import("../../apps/web/node_modules/@testing-library/react");
const { ConversationPanel } =
  await import("../../apps/web/src/features/product/conversation");
const { cacheKey, currentAccessGeneration } =
  await import("../../apps/web/src/features/product/api");
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
beforeEach(() => {
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
});
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

test("retired UI renders all authorized transcript pages and run history without observation or commands", async () => {
  const requests: string[] = [];
  let starts = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/history")) {
        return Promise.resolve(
          Response.json({
            projectionStatus: "retired",
            runs: [
              {
                auditHref: "/audit/old-run",
                runId: "old-run",
                state: "completed",
              },
            ],
          })
        );
      }
      if (url.includes("observations")) {
        throw new Error("Retired history must not open observations.");
      }
      const items = url.includes("?cursor=200")
        ? [
            {
              cursor: "201",
              runId: "old-run",
              text: "Retained historical answer",
              type: "output",
            },
            {
              cursor: "202",
              run: { runId: "old-run", state: "completed" },
              type: "run",
            },
          ]
        : Array.from({ length: 200 }, (_, index) => ({
            cursor: String(index + 1),
            eventId: `old-${index}`,
            text: `Historical question ${index}`,
            type: "user",
          }));
      return Promise.resolve(
        Response.json({
          agentId: "agent",
          conversationId: "conversation",
          cursor: url.includes("?cursor=") ? "202" : "200",
          items,
          mode: "retired",
          sessionId: "old-session",
          snapshot: { runs: [{ runId: "old-run", state: "completed" }] },
        })
      );
    },
    writable: true,
  });
  const view = render(
    createElement(ConversationPanel, {
      agentId: "agent",
      agentName: "Agent",
      conversationId: "conversation",
      fixture: false,
      onStartConversation: () => {
        starts += 1;
      },
      userId: "user",
    })
  );
  await waitFor(() =>
    assert.ok(
      view.container.textContent?.includes("Retained historical answer")
    )
  );
  assert.ok(view.container.textContent?.includes("Historical question 0"));
  assert.ok(view.container.textContent?.includes("1 runs"));
  assert.equal(
    view.container.textContent?.includes("Recovering response"),
    false
  );
  assert.equal(requests.length, 3);
  assert.equal(view.container.querySelector("textarea")?.disabled, true);
  assert.equal(view.getByRole("button", { name: "Disconnect" }).disabled, true);
  assert.equal(
    view.getByRole("button", { name: "Send message" }).disabled,
    true
  );
  view.getByRole("button", { name: "Start new conversation" }).click();
  assert.equal(starts, 1);
});

test("an open thinking panel stays open when the next delta arrives", async () => {
  const address = {
    agentId: "agent",
    conversationId: "conversation",
    organizationId: "company",
    sessionId: "session",
  };
  const snapshot = {
    address,
    agentVersion: 1,
    approvals: [],
    executions: [{ executionId: "execution", runIds: ["run"] }],
    outputs: [],
    revision: 0,
    runs: [{ runId: "run", state: "running" }],
    tools: [],
    userMessages: [],
  };
  const project = createProtocolProjection();
  const pending =
    Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
  const send = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    input: unknown
  ) => {
    const observation = decodeObservation(input);
    controller.enqueue(
      new TextEncoder().encode(
        `${project(observation)
          .map((event) =>
            JSON.stringify({
              ...event,
              metadata: { cerebro: observationIdentity(observation) },
            })
          )
          .join("\n")}\n`
      )
    );
  };
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/observations")) {
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start: (controller) => {
                pending.resolve(controller);
                send(controller, {
                  accessGeneration: currentAccessGeneration(),
                  address,
                  epoch: "epoch",
                  partial: [
                    {
                      executionId: "execution",
                      runId: "run",
                      text: "Answer",
                      thinking: "First thought",
                    },
                  ],
                  reason: "attach",
                  schemaVersion: 1,
                  sequence: 0,
                  snapshot,
                  type: "snapshot",
                });
              },
            }),
            { headers: { "Content-Type": "application/x-ag-ui+ndjson" } }
          )
        );
      }
      return Promise.resolve(
        Response.json(
          url.endsWith("/history")
            ? { projectionStatus: "running", runs: [] }
            : { ...address, cursor: "0", items: [], mode: "fixture", snapshot }
        )
      );
    },
    writable: true,
  });
  const view = render(
    createElement(ConversationPanel, {
      agentId: "agent",
      agentName: "Agent",
      conversationId: "conversation",
      fixture: true,
      userId: "user",
    })
  );
  await waitFor(() =>
    assert.ok(view.container.textContent?.includes("First thought"))
  );
  const details = view.getByText("Thinking").closest("details");
  assert.ok(details);
  details.open = true;
  const controller = await pending.promise;
  await act(() =>
    send(controller, {
      accessGeneration: currentAccessGeneration(),
      address,
      epoch: "epoch",
      revision: 0,
      schemaVersion: 1,
      sequence: 1,
      type: "update",
      update: {
        executionId: "execution",
        runId: "run",
        text: " continued",
        type: "provisional-thinking",
      },
    })
  );
  await waitFor(() =>
    assert.ok(details.textContent?.includes("First thought continued"))
  );
  assert.equal(view.getByText("Thinking").closest("details"), details);
  assert.equal(details.open, true);
});

test("a confirmed retry clears its client intent when the accepted domain event has a different ID", async () => {
  const key = cacheKey("user", "conversation", "pending");
  sessionStorage.setItem(
    key,
    JSON.stringify({
      eventId: "client-event",
      mode: "follow-up",
      text: "Question",
    })
  );
  const address = {
    agentId: "agent",
    conversationId: "conversation",
    organizationId: "company",
    sessionId: "session",
  };
  const snapshot = {
    address,
    agentVersion: 1,
    approvals: [],
    executions: [],
    outputs: [],
    revision: 0,
    runs: [],
    tools: [],
    userMessages: [],
  };
  let submissions = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/messages")) {
        submissions += 1;
        assert.equal(JSON.parse(String(init?.body)).eventId, "client-event");
        return Promise.resolve(
          Response.json({
            cursor: "0",
            receipt: {
              acceptedEventId: "domain-company-event",
              replayed: true,
              runId: "run",
              sessionId: "session",
            },
          })
        );
      }
      if (url.includes("/observations")) {
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start: (controller) => {
                controller.enqueue(
                  new TextEncoder().encode(
                    `${createProtocolProjection()(
                      decodeObservation({
                        accessGeneration: currentAccessGeneration(),
                        address,
                        epoch: "epoch",
                        reason: "attach",
                        schemaVersion: 1,
                        sequence: 0,
                        snapshot,
                        type: "snapshot",
                      })
                    )
                      .map((event) =>
                        JSON.stringify({
                          ...event,
                          metadata: {
                            cerebro: observationIdentity(
                              decodeObservation({
                                accessGeneration: currentAccessGeneration(),
                                address,
                                epoch: "epoch",
                                reason: "attach",
                                schemaVersion: 1,
                                sequence: 0,
                                snapshot,
                                type: "snapshot",
                              })
                            ),
                          },
                        })
                      )
                      .join("\n")}\n`
                  )
                );
              },
            }),
            { headers: { "Content-Type": "application/x-ag-ui+ndjson" } }
          )
        );
      }
      return Promise.resolve(
        Response.json(
          url.endsWith("/history")
            ? { projectionStatus: "idle", runs: [] }
            : { ...address, cursor: "0", items: [], mode: "fixture", snapshot }
        )
      );
    },
    writable: true,
  });
  const view = render(
    createElement(ConversationPanel, {
      agentId: "agent",
      agentName: "Agent",
      conversationId: "conversation",
      fixture: true,
      userId: "user",
    })
  );
  const retry = view.getByRole("button", { name: "Retry message" });
  await waitFor(() => assert.equal(retry.disabled, false));
  await act(() => retry.click());
  await waitFor(() => assert.equal(sessionStorage.getItem(key), null));
  assert.equal(submissions, 1);
  assert.equal(
    view.container.textContent?.includes("awaits confirmation"),
    false
  );
  assert.equal(view.container.querySelector("textarea")?.disabled, false);
});
