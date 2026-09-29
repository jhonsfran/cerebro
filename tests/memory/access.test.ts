import { expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { id } from "../../packages/contracts/src/index.ts";
import {
  scimConnectionBinding,
  scimProjectionGrant,
  scimUser,
} from "../../packages/db/src/schema/auth.ts";
import { identityPrincipal } from "../../packages/db/src/schema/identity.ts";
import { createMemoryStore } from "../../packages/memory/src/index.ts";
import {
  delegatedScope,
  effectOptions,
  fixture,
  readOptions,
} from "./fixture.ts";

test("fresh grants, private ownership, grant visibility, and retention control returned text", async () => {
  let time = Date.now();
  const f = await fixture({ now: () => time });
  try {
    const second = await f.secondActor();
    await f.add("private", "private salary details", {
      visibility: { kind: "private", ownerId: f.scope.context.actor.id },
    });
    await f.grant("salary-group");
    await f.add("restricted", "restricted salary details", {
      visibility: { grantId: "salary-group", kind: "grant" },
    });
    await f.add("expiring", "salary retention expires", {
      expiresAt: time + 1000,
    });
    await Promise.all(
      ["private", "restricted", "expiring", "salary-group"].map(
        async (source) =>
          await f.grant(source, true, second.scope.context.actor.id)
      )
    );
    const initial = await f.memory.retrieve(
      { ...f.scope, limit: 10, text: "salary" },
      readOptions()
    );
    expect(initial.status).toBe("ok");
    if (initial.status !== "ok") {
      throw new Error("Initial retrieval failed.");
    }
    expect(initial.value.map((hit) => hit.record.id).toSorted()).toEqual([
      "expiring-chunk",
      "private-chunk",
      "restricted-chunk",
    ]);
    const other = await f.memory.retrieve(
      { ...second.scope, limit: 10, text: "salary" },
      readOptions()
    );
    if (other.status !== "ok") {
      throw new Error("Other principal retrieval failed.");
    }
    expect(other.value.map((hit) => hit.record.id).toSorted()).toEqual([
      "expiring-chunk",
      "restricted-chunk",
    ]);
    await f.grant("salary-group", false);
    await f.grant("private", false);
    time += 1001;
    const revoked = await f.memory.retrieve(
      { ...f.scope, limit: 10, text: "salary" },
      readOptions()
    );
    expect(revoked).toEqual({ status: "ok", value: [] });
  } finally {
    await f.close();
  }
});

test("delegation uses represented grants and its current expiry and revocation", async () => {
  const f = await fixture();
  try {
    await f.add("delegated", "Delegated source content");
    const represented = await f.secondActor();
    await f.grant("delegated", true, represented.scope.context.actor.id);
    const delegation = await f.identity.createDelegation({
      actorId: f.principal.id,
      expiresAt: new Date(Date.now() + 10_000),
      organizationId: f.organizationId,
      representedId: represented.scope.context.actor.id,
      scopes: [
        { action: "read", resourceId: "delegated", resourceKind: "memory" },
      ],
    });
    const scope = delegatedScope(
      f.scope,
      represented.scope.context.actor,
      delegation
    );
    const allowed = await f.memory.retrieve(
      { ...scope, limit: 1, text: "Delegated" },
      readOptions()
    );
    if (allowed.status !== "ok") {
      throw new Error("Delegated retrieval failed.");
    }
    expect(allowed.value[0]?.record.text).toBe("Delegated source content");
    const expired = createMemoryStore({
      ...f.dependencies,
      now: () => Date.now() + 11_000,
    });
    expect(
      await expired.retrieve(
        { ...scope, limit: 1, text: "Delegated" },
        readOptions()
      )
    ).toEqual({ status: "ok", value: [] });
    await f.identity.revokeDelegation(f.organizationId, delegation.id);
    expect(
      await f.memory.retrieve(
        { ...scope, limit: 1, text: "Delegated" },
        readOptions()
      )
    ).toEqual({ status: "ok", value: [] });
  } finally {
    await f.close();
  }
});

test("SCIM projection removal and directory deactivation apply to the next read", async () => {
  const f = await fixture();
  try {
    await f.add("directory", "SCIM directory access content");
    await f.grant("directory", false);
    await f.database
      .update(identityPrincipal)
      .set({ directoryManaged: true })
      .where(eq(identityPrincipal.id, f.principal.id));
    const now = new Date();
    const connectionId = `connection-${f.organizationId}`;
    const scimId = `scim-${f.organizationId}`;
    const projectionId = `projection-${f.organizationId}`;
    await f.database.insert(scimConnectionBinding).values({
      connectionId,
      connectionKey: connectionId,
      createdAt: now,
      id: `binding-${f.organizationId}`,
      provisioningDomainId: f.organizationId,
    });
    await f.database.insert(scimUser).values({
      active: true,
      connectionId,
      connectionUserKey: scimId,
      createdAt: now,
      displayName: "Directory user",
      emailValueIndex: `${f.authUserId}@example.test`,
      formattedName: "Directory user",
      id: scimId,
      orderKey: scimId,
      primaryEmail: `${f.authUserId}@example.test`,
      provisioningDomainId: f.organizationId,
      serializedEmails: "[]",
      updatedAt: now,
      userId: f.authUserId,
      userName: f.authUserId,
      userNameKey: f.authUserId,
      workEmailValueIndex: `${f.authUserId}@example.test`,
    });
    await f.identity.setRolePermissions(f.organizationId, "memory-reader", [
      { action: "read", resourceId: "directory", resourceKind: "memory" },
    ]);
    const projection = {
      connectionId,
      createdAt: now,
      grantKey: projectionId,
      id: projectionId,
      provisioningDomainId: f.organizationId,
      role: "memory-reader",
      scimUserId: scimId,
      sourceId: "memory-group",
      sourceKind: "group" as const,
      sourceValue: "memory-group",
      updatedAt: now,
      userId: f.authUserId,
    };
    await f.database.insert(scimProjectionGrant).values(projection);
    const initial = await f.memory.retrieve(
      { ...f.scope, limit: 1, text: "directory" },
      readOptions()
    );
    if (initial.status !== "ok") {
      throw new Error("SCIM retrieval failed.");
    }
    expect(initial.value[0]?.record.text).toBe("SCIM directory access content");
    await f.database
      .delete(scimProjectionGrant)
      .where(eq(scimProjectionGrant.id, projectionId));
    expect(
      await f.memory.retrieve(
        { ...f.scope, limit: 1, text: "directory" },
        readOptions()
      )
    ).toEqual({ status: "ok", value: [] });
    await f.database.insert(scimProjectionGrant).values(projection);
    await f.database
      .update(scimUser)
      .set({ active: false })
      .where(eq(scimUser.id, scimId));
    const inactive = await f.memory.retrieve(
      { ...f.scope, limit: 1, text: "directory" },
      readOptions()
    );
    expect(inactive.status).toBe("denied");
    await f.database
      .update(scimUser)
      .set({ active: true })
      .where(eq(scimUser.id, scimId));
    await f.database
      .update(scimConnectionBinding)
      .set({ decommissionStatus: "reconciling" })
      .where(eq(scimConnectionBinding.connectionId, connectionId));
    const resolved1 = await f.memory.retrieve(
      { ...f.scope, limit: 1, text: "directory" },
      readOptions()
    );
    expect(resolved1.status).toBe("denied");
  } finally {
    await f.close();
  }
});

test("summaries need all dependencies and cannot create company facts from an unsupported assertion", async () => {
  const f = await fixture();
  try {
    const a = await f.add("a", "Refund policy requires a receipt.");
    const b = await f.add("b", "Conversation source record");
    const summary = {
      dependentSourceIds: [id.source("a")],
      id: "summary",
      kind: "conversation-summary" as const,
      provenance: {
        observedAt: b.input.observedAt,
        sourceId: id.source("b"),
        sourceUri: b.input.uri,
        sourceVersion: "v1",
      },
      text: "The refund policy requires a receipt.",
      visibility: { kind: "organization" as const },
    };
    const resolved2 = await f.memory.remember(
      f.scope,
      summary,
      effectOptions()
    );
    expect(resolved2.status).toBe("ok");
    const fact = {
      id: "fact",
      kind: "remembered-fact" as const,
      provenance: {
        observedAt: a.input.observedAt,
        sourceId: id.source("a"),
        sourceUri: a.input.uri,
        sourceVersion: "v1",
      },
      text: "Refund policy requires a receipt.",
      visibility: { kind: "organization" as const },
    };
    const remembered = await f.memory.remember(f.scope, fact, effectOptions());
    if (remembered.status !== "ok") {
      throw new Error("Grounded fact write failed.");
    }
    expect(remembered.value.text).toBe("Refund policy requires a receipt.");
    const resolved3 = await f.memory.remember(
      f.scope,
      {
        ...fact,
        id: "untrusted",
        text: "All refunds are unlimited and need no receipt.",
      },
      effectOptions()
    );
    expect(resolved3.status).toBe("invalid-input");
    await f.grant("a", false);
    const denied = await f.memory.retrieve(
      { ...f.scope, limit: 10, text: "refund" },
      readOptions()
    );
    expect(denied).toEqual({ status: "ok", value: [] });
    const resolved4 = await f.memory.remember(
      f.scope,
      { ...summary, id: "summary-denied" },
      effectOptions()
    );
    expect(resolved4.status).toBe("denied");
  } finally {
    await f.close();
  }
});
