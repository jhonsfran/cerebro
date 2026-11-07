import assert from "node:assert/strict";
import { test } from "node:test";

import { Schema } from "effect";

import { InvalidInput } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import type { AgentDefinition } from "../../packages/contracts/src/session.ts";
import { WorkAdmissionSchema } from "../../packages/contracts/src/work.ts";
import {
  LEAD_ROLE_INSTRUCTIONS,
  WORKER_ROLE_INSTRUCTIONS,
  requireRoleConfigurations,
  teamRoleDefinition,
  teamRoleKind,
  teamRoleSlots,
} from "../../packages/runtime/src/team-composition.ts";

const work = Schema.decodeUnknownSync(WorkAdmissionSchema)({
  version: 3,
  admittedAt: 1_800_000_000_000,
  agent: { agentId: "coordinator", agentVersion: 4 },
  contentDependencies: { sourceIds: [], toolIds: [] },
  deadlineAt: 1_800_000_600_000,
  goal: "Compose roles from one agent.",
  key: { organizationId: "org", ownerPrincipalId: "owner", workId: "work" },
  limits: { maxTeams: 2, maxTurns: 8, maxWorkers: 2, timeoutMs: 600_000 },
  sourceEventAddress: {
    agentId: "coordinator",
    conversationId: "primary",
    organizationId: "org",
    sessionId: "primary",
  },
});
const agent: AgentDefinition = {
  organizationId: id.organization("org"),
  agentId: id.agent("coordinator"),
  version: 4,
  instructions: "Answer with the company sources.",
  model: "company/strong",
  enabledToolIds: ["read-record"],
  grants: [
    {
      action: "read",
      resource: {
        kind: "memory",
        id: "source-A",
        organizationId: id.organization("org"),
      },
    },
  ],
};
const configuration = (
  index: number,
  overrides: Partial<AgentDefinition> = {}
) => ({
  agent: { ...agent, ...overrides },
  address: {
    organizationId: id.organization("org"),
    agentId: id.agent("coordinator"),
    conversationId: id.conversation(`role:${index}`),
    sessionId: id.session(`role:${index}`),
  },
});

test("slots are positional: one lead followed by maxWorkers workers", () => {
  assert.deepEqual(teamRoleSlots(work), [
    { index: 0, role: "lead" },
    { index: 1, role: "worker" },
    { index: 2, role: "worker" },
  ]);
  assert.equal(teamRoleKind(work, 0), "lead");
  assert.equal(teamRoleKind(work, 2), "worker");
  for (const index of [-1, 3, 1.5, Number.NaN]) {
    assert.throws(() => teamRoleKind(work, index), InvalidInput);
  }
});

test("a role definition is the agent plus a system overlay and nothing more", () => {
  const lead = teamRoleDefinition(agent, "lead");
  const worker = teamRoleDefinition(agent, "worker");
  assert.equal(
    lead.instructions,
    `${LEAD_ROLE_INSTRUCTIONS}\n\nAnswer with the company sources.`
  );
  assert.equal(
    worker.instructions,
    `${WORKER_ROLE_INSTRUCTIONS}\n\nAnswer with the company sources.`
  );
  for (const role of [lead, worker]) {
    assert.equal(role.model, "company/strong");
    assert.equal(role.agentId, agent.agentId);
    assert.equal(role.version, 4);
    assert.equal(role.organizationId, agent.organizationId);
    assert.deepEqual(role.enabledToolIds, ["read-record"]);
    assert.deepEqual(role.grants, agent.grants);
  }
  assert.deepEqual(Object.keys(lead).toSorted(), Object.keys(agent).toSorted());
});

const invalid = (reason: string) => (error: unknown) =>
  error instanceof InvalidInput && error.reason.includes(reason);

test("role configurations must match the pinned agent, one per slot, with distinct sessions", () => {
  const valid = [configuration(0), configuration(1), configuration(2)];
  assert.doesNotThrow(() => requireRoleConfigurations(work, valid));
  assert.throws(
    () => requireRoleConfigurations(work, valid.slice(0, 2)),
    invalid("count changed")
  );
  assert.throws(
    () =>
      requireRoleConfigurations(work, [
        configuration(0),
        configuration(1, { version: 5 }),
        configuration(2),
      ]),
    invalid("differs from its saved pin")
  );
  assert.throws(
    () =>
      requireRoleConfigurations(work, [
        configuration(0),
        configuration(1, { agentId: id.agent("other") }),
        configuration(2),
      ]),
    invalid("differs from its saved pin")
  );
  assert.throws(
    () =>
      requireRoleConfigurations(work, [
        configuration(0),
        configuration(1),
        configuration(1),
      ]),
    invalid("differs from its saved pin")
  );
});
