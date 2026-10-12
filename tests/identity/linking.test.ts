import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";

import { createIdentityRouter } from "../../packages/api/src/routers/identity.ts";

const requireFromApi = createRequire(
  new URL("../../packages/api/package.json", import.meta.url)
);
const { call } = requireFromApi("@orpc/server");

const digest = (code: string): string =>
  createHash("sha256").update(code).digest("hex");

const principal = {
  betterAuthUserId: "user-a",
  id: "principal-a",
  kind: "human" as const,
  organizationId: "org-a",
  state: "active" as const,
};

const context = (userId: string, email = "same@example.test") => ({
  db: {},
  session: { user: { email, id: userId } },
});

const fixture = () => {
  const currentTime = Date.now();
  const challenges = new Map<
    string,
    {
      organizationId: string;
      principalId: string;
      expiresAt: number;
    }
  >();
  const lookupCalls: [string, string][] = [];
  const grants: {
    action: "export";
    resourceId: string;
    resourceKind: "audit";
  }[] = [];
  const repository = {
    createSlackLinkChallenge(
      organizationId: string,
      principalId: string,
      codeDigest: string,
      expiresAt: Date
    ) {
      challenges.set(codeDigest, {
        expiresAt: expiresAt.getTime(),
        organizationId,
        principalId,
      });
      return Promise.resolve("challenge-a");
    },
    findPrincipalByUser(organizationId: string, userId: string) {
      lookupCalls.push([organizationId, userId]);
      if (
        organizationId === principal.organizationId &&
        userId === principal.betterAuthUserId
      ) {
        return Promise.resolve(principal);
      }
      return Promise.resolve();
    },
    readSnapshot(organizationId: string, actorId: string) {
      const actor =
        organizationId === principal.organizationId && actorId === principal.id
          ? principal
          : undefined;
      return Promise.resolve({
        actor,
        actorDirectoryActive: true,
        actorGrants: grants,
        delegation: undefined,
        policyVersion: "identity:org-a:1",
        represented: undefined,
        representedDirectoryActive: false,
        representedGrants: [],
        scopes: [],
      });
    },
  };
  return {
    challenges,
    grants,
    lookupCalls,
    now: () => currentTime,
    repository,
  };
};

test("the authenticated session selects an existing organization principal", async () => {
  const state = fixture();
  const router = createIdentityRouter(() => state.repository, state.now);

  assert.deepEqual(
    await call(
      router.currentPrincipal,
      { organizationId: "org-a" },
      { context: context("user-a") }
    ),
    {
      id: "principal-a",
      kind: "human",
      organizationId: "org-a",
      state: "active",
    }
  );
  assert.deepEqual(state.lookupCalls, [["org-a", "user-a"]]);

  await assert.rejects(
    call(
      router.currentPrincipal,
      { organizationId: "org-other" },
      { context: context("user-a") }
    ),
    { code: "FORBIDDEN" }
  );
  await assert.rejects(
    call(
      router.currentPrincipal,
      { organizationId: "org-a" },
      { context: context("user-other", "same@example.test") }
    ),
    { code: "FORBIDDEN" }
  );
  assert.deepEqual(state.lookupCalls, [
    ["org-a", "user-a"],
    ["org-other", "user-a"],
    ["org-a", "user-other"],
  ]);
});

test("Slack link initiation binds a random code digest to the current principal", async () => {
  const state = fixture();
  const router = createIdentityRouter(() => state.repository, state.now);
  const started = await call(
    router.beginSlackLink,
    { organizationId: "org-a" },
    { context: context("user-a") }
  );

  assert.match(started.code, /^[a-f0-9]{64}$/u);
  assert.equal(
    started.expiresAt,
    new Date(state.now() + 10 * 60 * 1000).toISOString()
  );
  assert.equal(state.challenges.has(started.code), false);
  assert.deepEqual(state.challenges.get(digest(started.code)), {
    expiresAt: state.now() + 10 * 60 * 1000,
    organizationId: "org-a",
    principalId: "principal-a",
  });

  const second = await call(
    router.beginSlackLink,
    { organizationId: "org-a" },
    { context: context("user-a") }
  );
  assert.notEqual(second.code, started.code);
  assert.equal(state.challenges.size, 2);
  assert.deepEqual(Object.keys(router), [
    "authorizeExport",
    "beginSlackLink",
    "currentPrincipal",
    "exportData",
  ]);
});

test("email equality does not grant Slack linking or export access", async () => {
  const state = fixture();
  const router = createIdentityRouter(() => state.repository, state.now);
  await assert.rejects(
    call(
      router.beginSlackLink,
      { organizationId: "org-a" },
      { context: context("user-other", "same@example.test") }
    ),
    { code: "FORBIDDEN" }
  );
  assert.equal(state.challenges.size, 0);
  await assert.rejects(
    call(
      router.authorizeExport,
      { kind: "audit", organizationId: "org-a" },
      { context: context("user-a") }
    ),
    { code: "FORBIDDEN" }
  );
  await assert.rejects(
    call(
      router.authorizeExport,
      { kind: "audit", organizationId: "org-other" },
      { context: context("user-a") }
    ),
    { code: "FORBIDDEN" }
  );
});

test("audit export requires a current grant", async () => {
  const state = fixture();
  const router = createIdentityRouter(() => state.repository, state.now);
  await assert.rejects(
    call(
      router.authorizeExport,
      { kind: "audit", organizationId: "org-a" },
      { context: context("user-a") }
    ),
    { code: "FORBIDDEN" }
  );
  state.grants.push({
    action: "export",
    resourceId: "org-a",
    resourceKind: "audit",
  });
  assert.deepEqual(
    await call(
      router.authorizeExport,
      { kind: "audit", organizationId: "org-a" },
      { context: context("user-a") }
    ),
    { authorized: true, policyVersion: "identity:org-a:1" }
  );
});
