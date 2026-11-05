import { mock } from "bun:test";
import assert from "node:assert/strict";

import { Schema } from "effect";

import { JSDOM } from "../../apps/web/node_modules/jsdom";
import { createElement } from "../../apps/web/node_modules/react";
import { InspectionQuery } from "../../packages/contracts/src/inspection.ts";
import type { ChatSnapshot } from "../../packages/contracts/src/session-service.ts";
import {
  inspectionOverview,
  inspectionSnapshot,
} from "./inspection-ui-data.ts";

mock.module("../../apps/web/src/env.public", () => ({
  ENV: { VITE_SERVER_URL: "http://fixture.invalid" },
}));
const globals = [
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
const original = globals.map((name) => ({
  name,
  descriptor: Object.getOwnPropertyDescriptor(globalThis, name),
}));
let dom: JSDOM;
const scrollInspectionElement = function scrollInspectionElement(
  this: HTMLElement,
  options?: ScrollToOptions | number,
  y?: number
): void {
  this.scrollTop = typeof options === "number" ? (y ?? 0) : (options?.top ?? 0);
  this.scrollLeft =
    typeof options === "number" ? options : (options?.left ?? 0);
};
export const installInspectionDom = () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://fixture.invalid",
    pretendToBeVisual: true,
  });
  for (const name of globals) {
    if (name === "fetch" || name === "IS_REACT_ACT_ENVIRONMENT") {
      continue;
    }
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: dom.window[name],
    });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true,
  });
  dom.window.HTMLElement.prototype.scrollTo = scrollInspectionElement;
};
installInspectionDom();
export const { act, cleanup, render, waitFor } =
  await import("../../apps/web/node_modules/@testing-library/react");
const { ConversationPanel } =
  await import("../../apps/web/src/features/product/conversation");
export const { clearProductCache, currentAccessGeneration } =
  await import("../../apps/web/src/features/product/api");
dom.window.close();
export const cleanupInspectionDom = () => {
  cleanup();
  dom.window.close();
  for (const { name, descriptor } of original) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, name);
    }
  }
};
interface InspectionCall {
  readonly query: InspectionQuery;
  readonly signal: AbortSignal | null | undefined;
}
export const inspectorFixture = ({
  snapshot = inspectionSnapshot(),
  mode = "local",
  respond = () => Response.json(inspectionOverview()),
}: {
  readonly snapshot?: ChatSnapshot;
  readonly mode?: "local" | "production";
  readonly respond?: (
    call: InspectionCall,
    index: number
  ) => Response | Promise<Response>;
} = {}) => {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const calls: InspectionCall[] = [];
  const send = (value: ChatSnapshot) => {
    assert.ok(stream);
    stream.enqueue(
      new TextEncoder().encode(
        `${JSON.stringify({ type: "snapshot", snapshot: value })}\n`
      )
    );
  };
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/inspection")) {
        assert.equal(init?.method, "POST");
        const body: unknown = JSON.parse(String(init.body));
        const parsed = Schema.decodeUnknownSync(
          Schema.Struct({ query: InspectionQuery })
        )(body);
        const call = { query: parsed.query, signal: init.signal };
        calls.push(call);
        return await respond(call, calls.length);
      }
      if (url.endsWith("/observations")) {
        let open = true;
        return new Response(
          new ReadableStream({
            cancel: () => {
              open = false;
            },
            start: (value) => {
              stream = value;
              send(snapshot);
              init?.signal?.addEventListener(
                "abort",
                () => {
                  if (open) {
                    open = false;
                    value.close();
                  }
                },
                { once: true }
              );
            },
          }),
          { headers: { "Content-Type": "application/x-ndjson" } }
        );
      }
      return Response.json({ ...snapshot.address, mode, snapshot });
    },
  });
  const props = {
    agentId: snapshot.address.agentId,
    agentName: "Agent",
    conversationId: snapshot.address.conversationId,
    userId: "user",
  };
  return {
    calls,
    send,
    mount: () => render(createElement(ConversationPanel, props)),
    element: (changes: Partial<typeof props> = {}) =>
      createElement(ConversationPanel, { ...props, ...changes }),
  };
};
