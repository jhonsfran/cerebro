import { test } from "bun:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

import { and, eq } from "drizzle-orm";

import { createCurrentAuthorization } from "../../apps/server/src/access";
import type { WorkerEnv } from "../../apps/server/src/bindings";
import { createInspectionClient } from "../../apps/server/src/session/inspection-client";
import { authenticateSessionRequest } from "../../apps/server/src/session/proof";
import { authorizeTeamInspection } from "../../apps/server/src/session/team-inspection";
import { createApiHandler } from "../../packages/api/src/handler";
import { Denied } from "../../packages/contracts/src/failures";
import { id } from "../../packages/contracts/src/identity";
import { channelConversation } from "../../packages/db/src/schema/agents";
import { identityGrant } from "../../packages/db/src/schema/identity";
import { createModels } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  Harness,
  createRegistry,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { NodeSqliteDatabase } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js";
import { SqliteStorage } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/storage.js";
import {
  createSourceDependencyStore,
  initializeContentSchema,
} from "../../packages/runtime/src/content-dependency-store";
import { ImportedContent } from "../../packages/runtime/src/imported-content";
import { piContext } from "../../packages/runtime/src/pi-harness";
import { teamRoleAddress } from "../../packages/runtime/src/team-content";
import { readTeamInspection } from "../../packages/runtime/src/team-inspection";
import { TeamState } from "../../packages/runtime/src/team-state";
import { createTestProduct, string } from "./helpers";
import {
  inspectionConfiguration,
  inspectionSecret,
  inspectionWork,
} from "./inspection-support";

test("the real Inspector gateway permits current READ without execute or a published source model", async () => {
  const app = await createTestProduct();
  const installed = await app.install();
  const ownerPrincipalId = id.principal(string(installed.principalId));
  const address = {
    organizationId: id.organization(app.options.organizationId),
    agentId: id.agent("unavailable-source"),
    conversationId: id.conversation("inspection-source"),
    sessionId: id.session("inspection-source"),
  };
  await app.options.withDatabase(async (database) => {
    await database.insert(channelConversation).values({
      ...address,
      bindingKey: "inspection-owned-source",
      ownerPrincipalId,
    });
    await database
      .delete(identityGrant)
      .where(
        and(
          eq(identityGrant.principalId, ownerPrincipalId),
          eq(identityGrant.action, "execute")
        )
      );
    await database.insert(identityGrant).values({
      organizationId: address.organizationId,
      principalId: ownerPrincipalId,
      action: "read",
      resourceKind: "agent",
      resourceId: address.agentId,
      source: "inspection-test",
    });
  });
  let requests = 0;
  let lookups = 0;
  const env = {
    DATABASE_URL: process.env.CHANNEL_TEST_DATABASE_URL,
    DEPLOY_MODE: "local",
    RUNTIME_CONFIG_JSON: inspectionConfiguration,
    SESSION: {
      idFromName: (name: string) => {
        lookups += 1;
        return { name };
      },
      get: (target: { name: string }) => ({
        fetch: async (request: Request) => {
          requests += 1;
          assert.equal(
            target.name,
            JSON.stringify([address.organizationId, ownerPrincipalId])
          );
          const verified = await authenticateSessionRequest(
            request,
            inspectionSecret,
            { organizationId: address.organizationId, ownerPrincipalId }
          );
          assert.deepEqual(verified.address, address);
          assert.equal(verified.context.actor.id, ownerPrincipalId);
          return Response.json({
            kind: "overview",
            address,
            profile: { agentVersion: 7 },
            work: [],
            refresh: false,
          });
        },
      }),
    },
  } as unknown as WorkerEnv;
  const handler = createApiHandler({
    ...app.options,
    inspection: createInspectionClient(env),
  });
  const request = (body: unknown, user = "test-owner") =>
    handler(
      new Request(
        `http://cerebro.test/api/product/conversations/${address.conversationId}/inspection`,
        {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json", "x-test-user": user },
        }
      )
    );
  const response = await request({ query: { kind: "overview" } });
  assert.equal(response.status, 200, await response.clone().text());
  const frame = await response.json();
  assert.equal(frame.kind, "overview");
  assert.equal(requests, 1);
  assert.equal(lookups, 1);
  const extra = await request({
    query: { kind: "team", workId: "work", cell: "forged-cell" },
  });
  assert.equal(extra.status, 422);
  const foreign = await request({ query: { kind: "overview" } }, "test-other");
  assert.equal(foreign.status, 403);
  assert.equal(requests, 1);
  assert.equal(lookups, 1);
  await app.options.withDatabase((database) =>
    database
      .delete(identityGrant)
      .where(
        and(
          eq(identityGrant.principalId, ownerPrincipalId),
          eq(identityGrant.resourceId, address.agentId)
        )
      )
  );
  const revoked = await request({ query: { kind: "overview" } });
  assert.equal(revoked.status, 403);
  assert.equal(requests, 1);
  assert.equal(lookups, 1);
});

test("the real private Inspector authorizes the complete raw and canonical union after projection without role execute", async () => {
  const app = await createTestProduct();
  const installed = await app.install();
  const ownerPrincipalId = id.principal(string(installed.principalId));
  const address = {
    organizationId: id.organization(app.options.organizationId),
    agentId: id.agent("unavailable-source"),
    conversationId: id.conversation("inspection-source"),
    sessionId: id.session("inspection-source"),
  };
  const actor = {
    actor: {
      id: ownerPrincipalId,
      kind: "human" as const,
      state: "active" as const,
      organizationId: address.organizationId,
    },
  };
  const env = {
    DATABASE_URL: process.env.CHANNEL_TEST_DATABASE_URL,
    DEPLOY_MODE: "local",
    RUNTIME_CONFIG_JSON: inspectionConfiguration,
  } as WorkerEnv;
  const work = inspectionWork(address, ownerPrincipalId);
  const rawTools = Array.from({ length: 257 }, (_, index) => `raw-${index}`);
  await app.options.withDatabase(async (database) => {
    await database.insert(channelConversation).values({
      ...address,
      bindingKey: "inspection-owned-source",
      ownerPrincipalId,
    });
    await database
      .delete(identityGrant)
      .where(
        and(
          eq(identityGrant.principalId, ownerPrincipalId),
          eq(identityGrant.action, "execute")
        )
      );
    await database.insert(identityGrant).values([
      {
        organizationId: address.organizationId,
        principalId: ownerPrincipalId,
        action: "read" as const,
        resourceKind: "agent" as const,
        resourceId: address.agentId,
        source: "inspection-test",
      },
      ...[...rawTools, "canonical-only"].map((resourceId) => ({
        organizationId: address.organizationId,
        principalId: ownerPrincipalId,
        action: "read" as const,
        resourceKind: "tool" as const,
        resourceId,
        source: "inspection-test",
      })),
    ]);
  });
  const database = new DatabaseSync(":memory:");
  const platform = {
    sql: {
      exec: (query: string, ...bindings: SQLInputValue[]) => {
        const rows = database.prepare(query).all(...bindings);
        return { toArray: () => rows };
      },
    },
  } as unknown as DurableObjectStorage;
  const context = piContext();
  const pi = await Harness.open(
    await SqliteStorage.open(new NodeSqliteDatabase(database)),
    {
      models: createModels(),
      registry: createRegistry(),
      settings: { extensions: [] },
    },
    context
  );
  try {
    const native = await pi.createConversation(
      { ownership: { kind: "ownerless" } },
      context
    );
    const roleAddress = await teamRoleAddress(work, 0);
    await pi.commit(async (tx) => {
      initializeContentSchema(platform);
      const raw = createSourceDependencyStore(
        platform,
        roleAddress.sessionId,
        (operation) => pi.commit(operation, context)
      );
      raw.importDependencies({ sourceIds: [], toolIds: rawTools });
      const canonical = await tx.doc(ImportedContent, native.id);
      canonical.toolIds = ["canonical-only"];
      const state = await tx.doc(TeamState);
      state.admission = work;
      state.lead = native.id;
      state.phase = "completed";
      state.report = {
        kind: "completed",
        id: "private-report",
        key: work.key,
        contentDependencies: { sourceIds: [], toolIds: [] },
        text: "Private retained result.",
      };
    }, context);
    const execute = await createCurrentAuthorization(env).evaluate(
      actor,
      "execute",
      {
        kind: "agent",
        id: address.agentId,
        organizationId: address.organizationId,
      },
      { deadlineAt: Date.now() + 5000 }
    );
    assert.ok(execute.status === "ok" && execute.value.decision === "deny");
    await authorizeTeamInspection(env, platform, pi, work, actor);
    const frame = await readTeamInspection({
      pi,
      work,
      query: { kind: "team", workId: work.key.workId },
    });
    assert.ok(frame.kind === "team" && frame.team.kind === "available");
    assert.equal(frame.team.result?.content.text, "Private retained result.");
    await pi.commit(async (tx) => {
      const canonical = await tx.doc(ImportedContent, native.id);
      canonical.toolIds.push("revoked-after-projection");
    }, context);
    await assert.rejects(
      authorizeTeamInspection(env, platform, pi, work, actor),
      Denied
    );
    await pi.commit(async (tx) => {
      const canonical = await tx.doc(ImportedContent, native.id);
      canonical.toolIds = ["canonical-only"];
    }, context);
    await app.options.withDatabase((connection) =>
      connection
        .delete(identityGrant)
        .where(
          and(
            eq(identityGrant.principalId, ownerPrincipalId),
            eq(identityGrant.resourceId, "raw-256")
          )
        )
    );
    await assert.rejects(
      authorizeTeamInspection(env, platform, pi, work, actor),
      Denied
    );
    await assert.rejects(
      authorizeTeamInspection(
        env,
        platform,
        pi,
        { ...work, goal: "Changed retained admission." },
        actor
      ),
      Denied
    );
    const scheduling = await pi.inspect(context);
    assert.equal(scheduling.scheduling, "paused");
  } finally {
    await pi.close(context);
  }
});
