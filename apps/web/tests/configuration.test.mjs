import { test } from "bun:test";
import assert from "node:assert/strict";

import { agentExecutionGrants } from "../src/features/product/configuration";

test("connector grants preserve selection order and exclude unselected or explicit connectors", () => {
  const tools = ["tool-a", "connector-a", "tool-b"];
  const choices = [
    { connectorId: "connector-a", id: "tool-a" },
    { connectorId: "connector-b", id: "tool-b" },
    { connectorId: "connector-b", id: "tool-b" },
    { connectorId: "unselected-connector", id: "unselected-tool" },
  ];
  assert.deepEqual(
    agentExecutionGrants("company", tools, ["source"], [], choices),
    [
      {
        action: "read",
        resource: { id: "tool-a", kind: "tool", organizationId: "company" },
      },
      {
        action: "execute",
        resource: { id: "tool-a", kind: "tool", organizationId: "company" },
      },
      {
        action: "read",
        resource: {
          id: "connector-a",
          kind: "tool",
          organizationId: "company",
        },
      },
      {
        action: "execute",
        resource: {
          id: "connector-a",
          kind: "tool",
          organizationId: "company",
        },
      },
      {
        action: "read",
        resource: { id: "tool-b", kind: "tool", organizationId: "company" },
      },
      {
        action: "execute",
        resource: { id: "tool-b", kind: "tool", organizationId: "company" },
      },
      {
        action: "execute",
        resource: {
          id: "connector-b",
          kind: "tool",
          organizationId: "company",
        },
      },
      {
        action: "read",
        resource: { id: "source", kind: "memory", organizationId: "company" },
      },
    ]
  );
  assert.deepEqual(tools, ["tool-a", "connector-a", "tool-b"]);
  assert.equal(choices.length, 4);
});

test("empty selections publish no catalog connector grants", () => {
  assert.deepEqual(
    agentExecutionGrants(
      "company",
      [],
      [],
      [],
      [{ connectorId: "connector", id: "tool" }]
    ),
    []
  );
});
