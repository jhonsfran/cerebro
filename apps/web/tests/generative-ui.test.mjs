import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";

import { parseUiRequest } from "@cerebro/generative-ui/presentation";
import { JSDOM } from "jsdom";
import { createElement } from "react";

import { verificationUiRequest } from "../../../tests/slice-1/provider.mjs";
import { ConversationTranscript } from "../src/features/product/conversation-transcript";

const globalNames = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Event",
  "IS_REACT_ACT_ENVIRONMENT",
];
const originalGlobals = globalNames.map((name) => ({
  descriptor: Object.getOwnPropertyDescriptor(globalThis, name),
  name,
}));
const scrollTo = function scrollTo({ top }) {
  this.scrollTop = top;
};
let dom;
const installDom = () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>");
  dom.window.HTMLElement.prototype.scrollTo = scrollTo;
  for (const name of globalNames) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: name === "IS_REACT_ACT_ENVIRONMENT" ? true : dom.window[name],
      writable: true,
    });
  }
};
installDom();
const { cleanup, fireEvent, render } = await import("@testing-library/react");
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

const snapshot = (presentation) => ({
  approvals: [],
  queuedInputs: [],
  messages: [
    { id: "input", role: "user", state: "complete", text: "Show the report." },
    { id: "assistant", role: "assistant", state: "complete", text: "" },
    {
      id: "result",
      role: "tool",
      toolName: "render_ui",
      state: "complete",
      text: "Two checks passed.",
    },
  ],
  tools: [
    {
      id: "assistant:0:0",
      callId: "ui-call",
      messageId: "assistant",
      resultMessageId: "result",
      arguments: {},
      output: "Two checks passed.",
      state: "succeeded",
      toolName: "render_ui",
      ...(presentation ? { presentation } : {}),
    },
  ],
});
const props = (value) => ({
  snapshot: value,
  agentName: "Assistant",
  connecting: false,
  disabled: false,
  decide: () => Promise.resolve(),
});

test("an accepted report renders a card, metric and semantic table without exposing raw arguments", () => {
  const request = verificationUiRequest();
  request.spec.elements.report.props.title = "<script>alert(1)</script>";
  const accepted = parseUiRequest(request);
  assert.equal(accepted.kind, "valid");
  const view = render(
    createElement(
      ConversationTranscript,
      props(snapshot(accepted.presentation))
    )
  );
  assert.ok(view.getByRole("heading", { name: "<script>alert(1)</script>" }));
  assert.equal(view.container.querySelector("script"), null);
  const table = view.getByRole("table", { name: "Verification checks" });
  assert.equal(table.querySelectorAll('th[scope="col"]').length, 2);
  assert.equal(table.querySelectorAll("tbody tr").length, 2);
  assert.equal(table.querySelector("tbody td").textContent, "Runtime");
  assert.ok(view.getByText("Passed checks"));
  assert.ok(view.getByText("2"));
  assert.ok(view.getByText("Text summary"));
  assert.equal(view.queryByText("Arguments"), null);
  assert.equal(view.queryByText("Output"), null);
  assert.equal(view.queryByText("render_ui"), null);
});

test("repeated snapshots preserve the report node and its text summary disclosure", () => {
  const accepted = parseUiRequest(verificationUiRequest());
  assert.equal(accepted.kind, "valid");
  const first = snapshot(accepted.presentation);
  const view = render(createElement(ConversationTranscript, props(first)));
  const report = view.getByRole("region", { name: "Agent report" });
  const summary = view.getByText("Text summary").closest("details");
  fireEvent.click(view.getByText("Text summary"));
  summary.open = true;
  view.rerender(
    createElement(ConversationTranscript, props(structuredClone(first)))
  );
  assert.equal(view.getByRole("region", { name: "Agent report" }), report);
  assert.equal(view.getByText("Text summary").closest("details").open, true);
});

test("an omitted or unsupported report keeps its ordinary text output visible", () => {
  const view = render(createElement(ConversationTranscript, props(snapshot())));
  assert.equal(view.queryByRole("table"), null);
  const fallback = view.getByText("Two checks passed.");
  assert.equal(fallback.closest("details"), null);
  assert.ok(view.getByText("Agent report"));
  assert.equal(view.queryByText("Arguments"), null);
});
