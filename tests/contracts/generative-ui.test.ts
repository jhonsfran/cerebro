/* oxlint-disable unicorn/prefer-structured-clone -- These tests exercise JSON wire transport. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Schema } from "effect";

import { ChatObservation } from "../../packages/contracts/src/session-service.ts";
import type { UiSpec } from "../../packages/generative-ui/src/catalog.ts";
import {
  parseUiPresentation,
  parseUiRequest,
} from "../../packages/generative-ui/src/presentation.ts";
import { verificationUiRequest } from "../slice-1/provider.mjs";

const invalid = (value: unknown) =>
  assert.equal(parseUiRequest(value).kind, "invalid");
const requestFor = (spec: UiSpec) => ({
  spec,
  fallbackText: "Read the report.",
});
const tree = (count: number, chain = false): UiSpec => ({
  root: "n0",
  elements: Object.fromEntries(
    Array.from({ length: count }, (_, index) => {
      let children: string[] = [];
      if (chain && index < count - 1) {
        children = [`n${index + 1}`];
      } else if (!chain && index === 0) {
        children = Array.from(
          { length: count - 1 },
          (_item, child) => `n${child + 1}`
        );
      }
      return [
        `n${index}`,
        { type: "Stack", props: { direction: "vertical" }, children },
      ];
    })
  ),
});

test("the catalog accepts a complete card and table with a versioned text fallback", () => {
  const result = parseUiRequest(verificationUiRequest());
  assert.equal(result.kind, "valid");
  if (result.kind !== "valid") {
    assert.fail(result.reason);
  }
  assert.equal(result.presentation.kind, "generative-ui");
  assert.equal(result.presentation.version, 1);
  assert.deepEqual(result.presentation.spec.elements.checks, {
    type: "Table",
    props: {
      caption: "Verification checks",
      columns: ["Check", "Status"],
      rows: [
        ["Runtime", "Passed"],
        ["Reconnect", "Passed"],
      ],
    },
    children: [],
  });
  assert.equal(
    result.presentation.fallbackText,
    "Verification report. Two checks passed. Runtime and reconnect are ready."
  );
  assert.deepEqual(
    parseUiPresentation(JSON.parse(JSON.stringify(result.presentation))),
    result
  );
});

test("unregistered components and nonliteral features cannot enter a report", () => {
  for (const props of [
    { text: { $state: "/secret" }, tone: "default" },
    { text: "value", tone: "default", style: "position:fixed" },
    { text: "value", tone: "default", url: "https://example.com" },
  ]) {
    invalid(
      requestFor({
        root: "text",
        elements: { text: { type: "Text", props, children: [] } },
      })
    );
  }
  for (const addition of [
    { on: { press: { action: "delete" } } },
    { visible: true },
    { watch: [] },
    { repeat: {} },
  ]) {
    const request = verificationUiRequest();
    Object.assign(request.spec.elements.report, addition);
    invalid(request);
  }
  const unknown = verificationUiRequest();
  unknown.spec.elements.metric.type = "Button";
  invalid(unknown);
  invalid({ ...verificationUiRequest(), version: 1 });
  invalid({ ...verificationUiRequest(), state: {} });
  invalid({ ...verificationUiRequest(), fallbackText: " " });
});

test("the graph is one rooted tree with layout children only", () => {
  const missingRoot = verificationUiRequest();
  missingRoot.spec.root = "missing";
  invalid(missingRoot);
  const missingChild = verificationUiRequest();
  missingChild.spec.elements.report.children.push("missing");
  invalid(missingChild);
  const shared = verificationUiRequest();
  shared.spec.elements.report.children.push("checks");
  invalid(shared);
  const cycle = verificationUiRequest();
  cycle.spec.elements.report.children.push("report");
  invalid(cycle);
  const leaf = verificationUiRequest();
  leaf.spec.elements.metric.children.push("checks");
  invalid(leaf);
  const orphan = verificationUiRequest();
  orphan.spec.elements.report.children = ["checks"];
  invalid(orphan);
  assert.equal(parseUiRequest(requestFor(tree(64))).kind, "valid");
  invalid(requestFor(tree(65)));
  assert.equal(parseUiRequest(requestFor(tree(8, true))).kind, "valid");
  invalid(requestFor(tree(9, true)));
});

test("table widths, rows, strings and UTF-8 envelope size have fixed limits", () => {
  const rows = verificationUiRequest();
  rows.spec.elements.checks.props.rows = [["Missing status"]];
  invalid(rows);
  const large = verificationUiRequest();
  large.spec.elements.checks.props.rows = Array.from({ length: 50 }, () => [
    "Runtime",
    "Passed",
  ]);
  assert.equal(parseUiRequest(large).kind, "valid");
  large.spec.elements.checks.props.rows.push(["Runtime", "Passed"]);
  invalid(large);
  const columns = verificationUiRequest();
  columns.spec.elements.checks.props.columns = Array.from(
    { length: 8 },
    () => "Column"
  );
  columns.spec.elements.checks.props.rows = [];
  assert.equal(parseUiRequest(columns).kind, "valid");
  columns.spec.elements.checks.props.columns.push("Ninth");
  invalid(columns);
  const string = verificationUiRequest();
  string.spec.elements.metric.props.value = "a".repeat(4097);
  invalid(string);
  const unicode = tree(5);
  for (const node of Object.values(unicode.elements)) {
    node.type = "Card";
    node.props = { title: "Title", description: "é".repeat(4096) };
  }
  invalid(requestFor(unicode));
  const ascii = tree(5);
  for (const node of Object.values(ascii.elements)) {
    node.type = "Card";
    node.props = { title: "Title", description: "a".repeat(4096) };
  }
  assert.equal(parseUiRequest(requestFor(ascii)).kind, "valid");
});

test("malformed and unknown UI versions do not reject an otherwise valid JSON observation", () => {
  const result = parseUiRequest(verificationUiRequest());
  if (result.kind !== "valid") {
    assert.fail(result.reason);
  }
  const tool = {
    arguments: {},
    callId: "call",
    id: "tool",
    messageId: "assistant",
    output: "Useful plain text.",
    resultMessageId: "result",
    state: "succeeded",
    toolName: "render_ui",
  };
  const snapshot = {
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
    tools: [tool],
  };
  for (const presentation of [
    result.presentation,
    { ...result.presentation, version: 2 },
    { kind: "other" },
    null,
    { ...result.presentation, spec: { root: "missing", elements: {} } },
  ]) {
    const decoded = Schema.decodeUnknownSync(ChatObservation)(
      JSON.parse(
        JSON.stringify({
          type: "snapshot",
          snapshot: { ...snapshot, tools: [{ ...tool, presentation }] },
        })
      )
    );
    assert.equal(decoded.type, "snapshot");
    if (decoded.type !== "snapshot") {
      assert.fail("Expected snapshot.");
    }
    assert.equal(decoded.snapshot.tools[0]?.output, "Useful plain text.");
    assert.deepEqual(
      decoded.snapshot.tools[0]?.presentation,
      presentation === result.presentation ? result.presentation : undefined
    );
  }
});
