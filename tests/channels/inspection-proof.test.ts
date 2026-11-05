import { test } from "bun:test";
import assert from "node:assert/strict";

import { Schema } from "effect";

import type { WorkerEnv } from "../../apps/server/src/bindings";
import { signSessionRequest } from "../../apps/server/src/session/proof";
import {
  resolveTeamInspection,
  authorizeTeamInspection,
} from "../../apps/server/src/session/team-inspection";
import { Denied, Unavailable } from "../../packages/contracts/src/failures";
import { id } from "../../packages/contracts/src/identity";
import { PrivateInspectionQuery } from "../../packages/contracts/src/inspection";
import { workCellName } from "../../packages/contracts/src/work";
import { createModels } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  Harness,
  MemoryStorage,
  createRegistry,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { piContext } from "../../packages/runtime/src/pi-harness";
import { TeamState } from "../../packages/runtime/src/team-state";
import {
  inspectionConfiguration,
  inspectionSecret,
  inspectionWork,
} from "./inspection-support";

test("the real private Inspector resolver binds source, owner, work admission, query, body, and cell", async () => {
  const address = {
    organizationId: id.organization("org"),
    agentId: id.agent("source"),
    conversationId: id.conversation("public"),
    sessionId: id.session("public"),
  };
  const context = {
    actor: {
      id: id.principal("owner"),
      kind: "human" as const,
      state: "active" as const,
      organizationId: address.organizationId,
    },
  };
  const work = inspectionWork(address, context.actor.id);
  const identity = {
    organizationId: address.organizationId,
    ownerPrincipalId: context.actor.id,
  };
  const env = {
    DEPLOY_MODE: "local",
    RUNTIME_CONFIG_JSON: inspectionConfiguration,
  } as WorkerEnv;
  const input = { work, query: { kind: "team", workId: work.key.workId } };
  const body = JSON.stringify(input);
  const proof = await signSessionRequest(
    address,
    context,
    "/inspect",
    body,
    inspectionSecret,
    identity
  );
  const request = (payload = body, credential = proof) =>
    new Request("https://team.internal/inspect", {
      method: "POST",
      body: payload,
      headers: { "x-cerebro-session-proof": credential },
    });
  assert.deepEqual(
    await resolveTeamInspection(env, workCellName(work.key), request()),
    { ...input, context }
  );
  await assert.rejects(
    resolveTeamInspection(env, "foreign-cell", request()),
    Denied
  );
  await assert.rejects(
    resolveTeamInspection(
      env,
      workCellName(work.key),
      request(
        JSON.stringify({
          ...input,
          work: { ...work, goal: "Changed admission." },
        })
      )
    ),
    Denied
  );
  await assert.rejects(
    resolveTeamInspection(
      env,
      workCellName(work.key),
      request(
        JSON.stringify({
          ...input,
          query: { kind: "tasks", workId: work.key.workId, role: 0 },
        })
      )
    ),
    Denied
  );
  const changedSource = {
    ...work.sourceEventAddress,
    sessionId: id.session("foreign-session"),
  };
  const signedForeign = await signSessionRequest(
    changedSource,
    context,
    "/inspect",
    body,
    inspectionSecret,
    identity
  );
  await assert.rejects(
    resolveTeamInspection(
      env,
      workCellName(work.key),
      request(body, signedForeign)
    ),
    Denied
  );
  const foreignActor = {
    actor: { ...context.actor, id: id.principal("foreign-owner") },
  };
  const signedActor = await signSessionRequest(
    address,
    foreignActor,
    "/inspect",
    body,
    inspectionSecret,
    identity
  );
  await assert.rejects(
    resolveTeamInspection(
      env,
      workCellName(work.key),
      request(body, signedActor)
    ),
    Denied
  );
});

test("the real private Inspector parser rejects every source-only query at the schema boundary", async () => {
  const address = {
    organizationId: id.organization("org"),
    agentId: id.agent("source"),
    conversationId: id.conversation("public"),
    sessionId: id.session("public"),
  };
  const context = {
    actor: {
      id: id.principal("owner"),
      kind: "human" as const,
      state: "active" as const,
      organizationId: address.organizationId,
    },
  };
  const work = inspectionWork(address, context.actor.id);
  const identity = {
    organizationId: address.organizationId,
    ownerPrincipalId: context.actor.id,
  };
  const env = {
    DEPLOY_MODE: "local",
    RUNTIME_CONFIG_JSON: inspectionConfiguration,
  } as WorkerEnv;
  await Promise.all(
    ["overview", "history", "events"].map(async (kind) => {
      const input = { work, query: { kind } };
      assert.throws(() =>
        Schema.decodeUnknownSync(PrivateInspectionQuery)(input)
      );
      const body = JSON.stringify(input);
      const proof = await signSessionRequest(
        address,
        context,
        "/inspect",
        body,
        inspectionSecret,
        identity
      );
      const request = new Request("https://team.internal/inspect", {
        method: "POST",
        body,
        headers: { "x-cerebro-session-proof": proof },
      });
      await assert.rejects(
        resolveTeamInspection(env, workCellName(work.key), request)
      );
    })
  );
});

test("the real private Inspector distinguishes a pending start from a changed retained admission", async () => {
  const address = {
    organizationId: id.organization("org"),
    agentId: id.agent("source"),
    conversationId: id.conversation("public"),
    sessionId: id.session("public"),
  };
  const actor = {
    actor: {
      id: id.principal("owner"),
      kind: "human" as const,
      state: "active" as const,
      organizationId: address.organizationId,
    },
  };
  const work = inspectionWork(address, actor.actor.id);
  const env = {
    DEPLOY_MODE: "local",
    RUNTIME_CONFIG_JSON: inspectionConfiguration,
  } as WorkerEnv;
  const platform = {} as DurableObjectStorage;
  const context = piContext();
  const pi = await Harness.open(
    new MemoryStorage(),
    {
      models: createModels(),
      registry: createRegistry(),
      settings: { extensions: [] },
    },
    context
  );
  try {
    await assert.rejects(
      authorizeTeamInspection(env, platform, pi, work, actor),
      Unavailable
    );
    await pi.commit(async (tx) => {
      const state = await tx.doc(TeamState);
      state.admission = { ...work, goal: "Changed saved admission." };
    }, context);
    await assert.rejects(
      authorizeTeamInspection(env, platform, pi, work, actor),
      Denied
    );
    const inspection = await pi.inspect(context);
    assert.equal(inspection.scheduling, "paused");
    assert.equal(inspection.tasks.length, 0);
  } finally {
    await pi.close(context);
  }
});
