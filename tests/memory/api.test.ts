import { expect, test } from "bun:test";
import { createRequire } from "node:module";

import { createAppRouter } from "../../packages/api/src/routers/index.ts";
import { effectOptions, fixture } from "./fixture.ts";

const requireFromApi = createRequire(
  new URL("../../packages/api/package.json", import.meta.url)
);
const { call } = requireFromApi("@orpc/server");

test("memory API derives actor from authenticated session and uses real services", async () => {
  const f = await fixture({ retrievalMode: "full-text" });
  try {
    await f.grant("api-source");
    const router = createAppRouter(() => ({
      artifacts: f.artifacts,
      identity: f.identity,
      memory: f.memory,
    })).memory;
    const context = { db: f.database, session: { user: { id: f.authUserId } } };
    const request = effectOptions();
    expect(
      await call(
        router.ingest,
        {
          operationId: request.operationId,
          organizationId: f.organizationId,
          requestDigest: request.requestDigest,
          source: f.source(
            "api-source",
            "API finance approves travel expenses"
          ),
        },
        { context }
      )
    ).toEqual({
      status: "ok",
      value: { generation: 1, sourceId: "api-source", version: "v1" },
    });
    const result = await call(
      router.retrieve,
      { limit: 1, organizationId: f.organizationId, text: "finance" },
      { context }
    );
    expect(result.status).toBe("ok");
    expect(result.value[0].record.text).toBe(
      "API finance approves travel expenses"
    );
    expect(result.value[0].citation).toEqual({
      observedAt: 1_760_000_000_000,
      sourceId: "api-source",
      sourceUri: "https://example.test/api-source",
      sourceVersion: "v1",
    });
    const second = await f.secondActor();
    const forgedActor = await call(
      router.retrieve,
      {
        context: f.scope.context,
        limit: 1,
        organizationId: f.organizationId,
        text: "finance",
      },
      {
        context: {
          db: f.database,
          session: { user: { id: second.authUserId } },
        },
      }
    );
    expect(forgedActor).toEqual({ status: "ok", value: [] });
    await expect(
      call(
        router.retrieve,
        { limit: 1, organizationId: f.organizationId, text: "finance" },
        { context: { db: f.database, session: null } }
      )
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(
        router.retrieve,
        { limit: 1, organizationId: "wrong-company", text: "finance" },
        { context }
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const remove = effectOptions();
    expect(
      await call(
        router.forget,
        {
          operationId: remove.operationId,
          organizationId: f.organizationId,
          requestDigest: remove.requestDigest,
          sourceId: "api-source",
        },
        { context }
      )
    ).toEqual({ status: "ok", value: { removed: 1 } });
    expect(
      await call(
        router.retrieve,
        { limit: 1, organizationId: f.organizationId, text: "finance" },
        { context }
      )
    ).toEqual({ status: "ok", value: [] });
  } finally {
    await f.close();
  }
});

test("unconfigured production memory API fails without selecting a fake embedding provider", async () => {
  const f = await fixture();
  try {
    const router = createAppRouter().memory;
    await expect(
      call(
        router.retrieve,
        { limit: 1, organizationId: f.organizationId, text: "finance" },
        { context: { db: f.database, session: { user: { id: f.authUserId } } } }
      )
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  } finally {
    await f.close();
  }
});
