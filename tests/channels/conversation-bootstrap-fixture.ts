import assert from "node:assert/strict";

import { createElement, useState } from "../../apps/web/node_modules/react";
import { conversationSchema } from "../../apps/web/src/features/product/types";
import { ProductWorkspace } from "../../apps/web/src/features/product/workspace";
import { id } from "../../packages/contracts/src/identity.ts";
import type { ChatSnapshot } from "../../packages/contracts/src/session-service.ts";
import { inspectionSnapshot } from "./inspection-ui-data.ts";
import { act, fireEvent, render, waitFor } from "./inspection-ui-fixture.ts";

export const conversationPayload = (
  conversationId: string,
  text = conversationId
) => {
  const agentId = conversationId === "chat-b" ? "agent-b" : "agent-a";
  const snapshot = inspectionSnapshot({
    address: {
      agentId: id.agent(agentId),
      conversationId: id.conversation(conversationId),
      organizationId: id.organization("company"),
      sessionId: id.session(`session:${conversationId}`),
    },
    messages: [
      { id: `answer:${text}`, role: "assistant", state: "complete", text },
    ],
  });
  return conversationSchema.parse({
    ...snapshot.address,
    mode: "local",
    snapshot,
  });
};

interface BootstrapRequest {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
  readonly signal: AbortSignal | null | undefined;
}

const Workspace = ({
  userId,
  initialConversationId,
}: {
  userId: string;
  initialConversationId: string | undefined;
}) => {
  const [conversationId, setConversationId] = useState(initialConversationId);
  return createElement(
    "main",
    null,
    createElement(
      "button",
      { onClick: () => setConversationId("chat-a") },
      "Navigate A"
    ),
    createElement(
      "button",
      { onClick: () => setConversationId("chat-b") },
      "Navigate B"
    ),
    createElement(ProductWorkspace, {
      userId,
      userName: userId,
      conversationId,
      onConversation: setConversationId,
    })
  );
};

const workspaceElement = (userId = "user", initialConversationId?: string) =>
  createElement(Workspace, { userId, initialConversationId });
const mountWorkspace = (conversationId?: string) =>
  render(workspaceElement("user", conversationId));

export const bootstrapFixture = ({
  read = (conversationId) => Response.json(conversationPayload(conversationId)),
  open = (body) => {
    assert.ok(typeof body === "object" && body !== null && "agentId" in body);
    const payload = conversationPayload(
      body.agentId === "agent-b" ? "chat-b" : "chat-a"
    );
    return Response.json(payload);
  },
  canManage = false,
  savedConversation,
}: {
  canManage?: boolean;
  savedConversation?: string;
  read?: (
    conversationId: string,
    call: BootstrapRequest
  ) => Response | Promise<Response>;
  open?: (
    body: unknown,
    call: BootstrapRequest
  ) => Response | Promise<Response>;
} = {}) => {
  const calls: BootstrapRequest[] = [];
  const observations: BootstrapRequest[] = [];
  const streams = new Map<
    string,
    ReadableStreamDefaultController<Uint8Array>
  >();
  const snapshots = new Map<string, ChatSnapshot>();
  const painted: string[] = [];
  const observer = new window.MutationObserver((records) => {
    for (const record of records) {
      painted.push(record.target.textContent ?? "");
      for (const node of record.addedNodes) {
        painted.push(node.textContent ?? "");
      }
    }
  });
  observer.observe(document.body, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  const send = (conversationId: string, text: string) => {
    const stream = streams.get(conversationId);
    assert.ok(stream);
    stream.enqueue(
      new TextEncoder().encode(
        `${JSON.stringify({
          type: "snapshot",
          snapshot: conversationPayload(conversationId, text).snapshot,
        })}\n`
      )
    );
  };
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const call = {
        path,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
        signal: init?.signal,
      };
      calls.push(call);
      if (path.endsWith("/setup")) {
        return Response.json({
          mode: "local",
          organizationId: "company",
          owner: false,
          principalId: "principal",
          setupRequired: false,
        });
      }
      if (path.endsWith("/agents")) {
        return Response.json({
          agents: ["a", "b"].map((suffix) => ({
            agentId: `agent-${suffix}`,
            name: `Agent ${suffix.toUpperCase()}`,
            model: "cheap",
            version: 1,
            canManage,
            ...(savedConversation === `chat-${suffix}`
              ? { primaryConversationId: savedConversation }
              : {}),
          })),
        });
      }
      if (path.includes("/agents/")) {
        const agentId = path.split("/").at(-1);
        return Response.json({
          agentId,
          name: agentId,
          access: canManage
            ? [
                {
                  actions: ["read"],
                  email: null,
                  name: "Team Member",
                  principalId: "member",
                },
              ]
            : [],
          connectorChoices: [],
          modelChoices: [],
          sourceChoices: [],
          definition: {
            agentId,
            organizationId: "company",
            enabledToolIds: [],
            grants: [],
            instructions: "Test agent",
            model: "cheap",
            version: 1,
          },
        });
      }
      if (path.endsWith("/conversations") && call.method === "POST") {
        return await open(call.body, call);
      }
      const conversationId = path.split("/").at(4);
      assert.ok(conversationId);
      if (path.endsWith("/observations")) {
        observations.push(call);
        let closed = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              streams.set(conversationId, controller);
              const snapshot = snapshots.get(conversationId);
              assert.ok(snapshot);
              controller.enqueue(
                new TextEncoder().encode(
                  `${JSON.stringify({ type: "snapshot", snapshot })}\n`
                )
              );
              init?.signal?.addEventListener(
                "abort",
                () => {
                  if (!closed) {
                    closed = true;
                    controller.close();
                  }
                },
                { once: true }
              );
            },
            cancel: () => {
              closed = true;
            },
          }),
          { headers: { "Content-Type": "application/x-ndjson" } }
        );
      }
      assert.equal(path, `/api/product/conversations/${conversationId}`);
      const response = await read(conversationId, call);
      if (response.ok && !call.signal?.aborted) {
        const parsed = conversationSchema.safeParse(
          await response.clone().json()
        );
        if (parsed.success) {
          snapshots.set(conversationId, parsed.data.snapshot);
        }
      }
      return response;
    },
  });
  return {
    calls,
    observations,
    painted,
    send,
    mount: mountWorkspace,
    element: workspaceElement,
    disconnect: () => observer.disconnect(),
    reads: (conversationId: string) =>
      calls.filter(
        (call) =>
          call.method === "GET" &&
          call.path === `/api/product/conversations/${conversationId}`
      ),
  };
};

export const openConversation = async (view: ReturnType<typeof render>) => {
  const button = await waitFor(() => {
    const current = view
      .getAllByRole("button", { name: "Open conversation", exact: true })
      .find((element) => !element.hasAttribute("disabled"));
    assert.ok(current);
    return current;
  });
  await act(() => fireEvent.click(button));
};

export const navigateConversation = async (
  view: ReturnType<typeof render>,
  name: "A" | "B"
) => {
  await act(() =>
    fireEvent.click(view.getByRole("button", { name: `Navigate ${name}` }))
  );
};
