/* oxlint-disable no-await-in-loop -- Acceptance commands and physical crash checkpoints must run in order. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readlink, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { Schema } from "effect";
import { z } from "zod";

import { DomainSnapshot } from "../../packages/contracts/src/session-service.ts";
import {
  applicationFixture,
  bootApplication,
  initializeFixtureAgent,
  waitForFixture,
} from "../slice-1/application.ts";
import { verifyPilotRestore } from "./pilot-restore.ts";

const root = path.resolve(import.meta.dirname, "../..");
const executeFile = promisify(execFile);
const execute = (command: string, args: readonly string[]) =>
  executeFile("rtk", ["proxy", command, ...args], {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  });
const sourceId = "pilot-source-real";
const sourceUri = "urn:cerebro:pilot:refund-policy";
const sourceVersion = "1";
const document =
  "Pilot support policy permits refunds within 14 days. The reference code is CEREBRO-REAL-MEMORY-731.";
const firstEvent = {
  eventId: "pilot-first-event",
  mode: "follow-up" as const,
  text: "What is the pilot refund support policy? Use fixture-read.",
};
const conversationSchema = z.object({
  conversationId: z.string(),
  sessionId: z.string(),
});
type Conversation = z.infer<typeof conversationSchema>;
const receiptSchema = z.object({
  receipt: z.object({
    acceptedEventId: z.string(),
    replayed: z.boolean(),
    runId: z.string(),
    sessionId: z.string(),
  }),
});
const viewSchema = z.object({
  cursor: z.string(),
  items: z.array(z.object({ type: z.string() }).passthrough()),
  sessionId: z.string(),
  snapshot: z
    .unknown()
    .transform((value) => Schema.decodeUnknownSync(DomainSnapshot)(value)),
});
const providerSchema = z.object({
  checkpoints: z.array(
    z.object({
      armId: z.string().nullable().optional(),
      armed: z.boolean().optional(),
      at: z.number(),
      boundary: z.string(),
      operationId: z.string(),
    })
  ),
  held: z.number(),
  model: z.array(
    z.object({
      completedAt: z.number().optional(),
      maxTokens: z.number(),
      messageTextDigests: z.array(z.string()),
      model: z.string(),
      operationId: z.string(),
      startedAt: z.number(),
      toolNames: z.array(z.string()),
    })
  ),
  tools: z.array(
    z.object({
      completedAt: z.number().optional(),
      operationId: z.string(),
      startedAt: z.number(),
      write: z.boolean(),
    })
  ),
});
const artifactSchema = z.object({
  artifactId: z.string(),
  organizationId: z.string(),
  provenance: z.object({
    observedAt: z.number(),
    sourceId: z.string(),
    sourceUri: z.string(),
    sourceVersion: z.string(),
  }),
  visibility: z.object({ grantId: z.string(), kind: z.literal("grant") }),
});
const publicFailureCode = (content: string): string => {
  try {
    const parsed = z
      .object({
        code: z.enum([
          "forbidden",
          "provider-unavailable",
          "unavailable",
          "UNAVAILABLE",
          "not-found",
          "unauthorized",
          "conflict",
          "invalid-input",
        ]),
      })
      .safeParse(JSON.parse(content));
    return parsed.success ? parsed.data.code : "unrecognized";
  } catch {
    return "non-json";
  }
};
let fixture: ReturnType<typeof applicationFixture>;
let owner: Awaited<ReturnType<typeof fixture.signup>>;
let support: Awaited<ReturnType<typeof fixture.signup>>;
let outsider: Awaited<ReturnType<typeof fixture.signup>>;
let organizationId: string;
let ownerPrincipal: string;
let supportPrincipal: string;
let agentId: string;
let conversation: Conversation;
let firstRunId: string;
let artifact: z.infer<typeof artifactSchema>;
let evidenceDirectory: string;
const metrics: Record<string, unknown> = {};
const evidence: Record<string, unknown> = {};
let currentGate = "application setup";
const ownerConversations = new Map<
  string,
  { address: Conversation; gate: string }
>();
const failedRequests: {
  gate: string;
  route: string;
  status: number;
  elapsedMs: number;
  bodySha256: string;
  code: string;
  intent: {
    eventId?: string;
    operationId?: string;
    runId?: string;
  };
}[] = [];
evidence.failedRequests = failedRequests;
const gates = new Set<string>();
const expectedGates = 10;
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const route = (address: Conversation): string =>
  `/api/product/conversations/${encodeURIComponent(address.conversationId)}`;
const provider = async () => providerSchema.parse(await fixture.observations());
const trackedJson: ReturnType<typeof applicationFixture>["json"] = async (
  requestRoute,
  cookie,
  schema,
  body,
  method
) => {
  const started = performance.now();
  const response = await fixture.request(requestRoute, cookie, body, method);
  if (response.status !== 200) {
    const content = await response.text();
    const intent = z
      .object({
        eventId: z.string().optional(),
        operationId: z.string().optional(),
        runId: z.string().optional(),
      })
      .safeParse(body);
    failedRequests.push({
      bodySha256: createHash("sha256").update(content).digest("hex"),
      code: publicFailureCode(content),
      elapsedMs: Math.round(performance.now() - started),
      gate: currentGate,
      intent: intent.success ? intent.data : {},
      route: requestRoute,
      status: response.status,
    });
  }
  assert.equal(
    response.status,
    200,
    `${requestRoute}: HTTP ${response.status}`
  );
  return schema.parse(await response.json());
};
const modelCalls = async () => {
  const observed = await provider();
  return observed.model;
};
const toolCalls = async () => {
  const observed = await provider();
  return observed.tools;
};
const rpc = async <Value>(
  name: string,
  schema: z.ZodType<Value>,
  input: unknown,
  cookie = owner.cookie
): Promise<Value> => {
  const result = await fixture.json(
    `/rpc/${name.replaceAll(".", "/")}`,
    cookie,
    z.object({ json: schema }),
    { json: input }
  );
  return result.json;
};
const seedGrant = (
  principalId: string,
  action: string,
  kind: string,
  resourceId: string
) =>
  fixture.sql(
    `INSERT INTO identity_grant(organization_id,principal_id,action,resource_kind,resource_id,source) VALUES (${[organizationId, principalId, action, kind, resourceId, "pilot-acceptance"].map(literal).join(",")}) ON CONFLICT DO NOTHING`
  );
const createConversation = async (
  cookie = owner.cookie,
  selectedAgent = agentId
) => {
  const address = await fixture.json(
    "/api/product/conversations",
    cookie,
    conversationSchema,
    {
      agentId: selectedAgent,
      operationId: randomUUID(),
    }
  );
  if (cookie === owner.cookie) {
    ownerConversations.set(address.conversationId, {
      address,
      gate: currentGate,
    });
  }
  return address;
};
const submit = (
  address: Conversation,
  text: string,
  eventId: string = randomUUID(),
  mode: "follow-up" | "steer" | "replace" = "follow-up"
) =>
  fixture.json(`${route(address)}/messages`, owner.cookie, receiptSchema, {
    eventId,
    mode,
    text,
  });
const read = (address: Conversation) =>
  fixture.json(route(address), owner.cookie, viewSchema);
const state = (address: Conversation, runId: string, expected: string) =>
  waitForFixture(
    () => read(address),
    (view) =>
      view.snapshot.runs.find((run) => run.runId === runId)?.state === expected,
    60_000
  );
const pending = async (address: Conversation, runId: string) => {
  const view = await waitForFixture(
    () => read(address),
    (value) =>
      value.snapshot.approvals.some(
        (approval) => approval.runId === runId && approval.state === "pending"
      ),
    60_000
  );
  const approval = view.snapshot.approvals.find(
    (value) => value.runId === runId && value.state === "pending"
  );
  assert.ok(approval);
  return approval;
};
const approve = (
  address: Conversation,
  approval: DomainSnapshot["approvals"][number],
  operationId = randomUUID()
) =>
  fixture.json(
    `${route(address)}/approvals/${encodeURIComponent(approval.approvalId)}`,
    owner.cookie,
    z.object({ run: z.unknown() }),
    { decision: "allow", operationId, runId: approval.runId }
  );
const cancel = (address: Conversation, runId: string) =>
  fixture.json(
    `${route(address)}/runs/${encodeURIComponent(runId)}/cancel`,
    owner.cookie,
    z.object({ run: z.unknown() }),
    { operationId: randomUUID() }
  );
const expectStatus = async (response: Response, expected: number) => {
  assert.equal(response.status, expected, `Expected HTTP ${expected}`);
  await response.body?.cancel();
};
const restart = async (
  address: Conversation,
  settlingToolOperationId?: string
) => {
  const beforeCrash = await provider();
  const recoveryRequests: {
    status: number;
    elapsedMs: number;
    bodySha256: string;
    code: string;
  }[] = [];
  const started = performance.now();
  evidence[`restart:${address.conversationId}`] = {
    beforeCrash,
    recoveryRequests,
    settlingToolOperationId,
  };
  const container = await fixture.container("celld");
  await execute("docker", ["kill", "--signal", "SIGKILL", container]);
  await fixture.controls({ arm: null, release: true });
  await execute("docker", ["start", container]);
  await waitForFixture(
    async () => {
      try {
        const response = await fetch(`${fixture.boot.apiUrl}/ready`, {
          signal: AbortSignal.timeout(2000),
        });
        await response.body?.cancel();
        return response.status;
      } catch (error) {
        if (
          error instanceof TypeError ||
          (error instanceof DOMException &&
            ["AbortError", "TimeoutError"].includes(error.name))
        ) {
          return 0;
        }
        throw error;
      }
    },
    (status) => status === 200,
    60_000
  );
  await waitForFixture(
    async () => {
      const requestStarted = performance.now();
      const response = await fixture.request(route(address), owner.cookie);
      const body = await response.text();
      recoveryRequests.push({
        bodySha256: createHash("sha256").update(body).digest("hex"),
        code: response.status === 200 ? "ok" : publicFailureCode(body),
        elapsedMs: Math.round(performance.now() - requestStarted),
        status: response.status,
      });
      assert.ok(
        [200, 503].includes(response.status),
        `Unexpected recovery HTTP ${response.status}`
      );
      return response.status;
    },
    (status) => status === 200,
    30_000
  );
  const afterRecovery = await provider();
  // A settling tool lets its run answer after recovery; otherwise nothing runs.
  if (settlingToolOperationId === undefined) {
    assert.deepEqual(afterRecovery.model, beforeCrash.model);
  }
  assert.deepEqual(
    afterRecovery.tools.map(
      ({ completedAt: _completedAt, ...record }) => record
    ),
    beforeCrash.tools.map(({ completedAt: _completedAt, ...record }) => record)
  );
  for (const beforeTool of beforeCrash.tools) {
    const recoveredTool = afterRecovery.tools.find(
      (tool) => tool.operationId === beforeTool.operationId
    );
    assert.ok(recoveredTool);
    if (
      beforeTool.operationId === settlingToolOperationId &&
      beforeTool.completedAt === undefined
    ) {
      assert.ok(
        recoveredTool.completedAt === undefined ||
          recoveredTool.completedAt >= beforeTool.startedAt
      );
    } else {
      assert.equal(recoveredTool.completedAt, beforeTool.completedAt);
    }
  }
  return {
    afterRecovery,
    beforeCrash,
    elapsedMs: Math.round(performance.now() - started),
    recoveryRequests,
    settlingToolOperationId,
  };
};
const sourceIdentity = async (): Promise<string> => {
  const files = await execute("git", [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  const hash = createHash("sha256");
  for (const file of [...new Set(files.stdout.trim().split("\n"))]
    .filter((value) => !value.startsWith("artifacts/"))
    .toSorted()) {
    hash.update(`${file}\n`);
    try {
      const absolute = path.join(root, file);
      const metadata = await lstat(absolute);
      hash.update(
        metadata.isSymbolicLink()
          ? `symlink:${await readlink(absolute)}`
          : await readFile(absolute)
      );
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
      hash.update("<deleted>");
    }
  }
  return `sha256:${hash.digest("hex")}`;
};
const gate = (name: string, action: () => Promise<void>, timeout = 180_000) =>
  test(name, { timeout }, async () => {
    currentGate = name;
    const started = performance.now();
    try {
      await action();
      gates.add(name);
    } finally {
      metrics[name] = {
        elapsedMs: Math.round(performance.now() - started),
        passed: gates.has(name),
      };
    }
  });

before(
  async () => {
    metrics.sourceIdentity = await sourceIdentity();
    const bootStarted = performance.now();
    fixture = applicationFixture(await bootApplication("pilot"));
    fixture.json = trackedJson;
    metrics.bootMs = Math.round(performance.now() - bootStarted);
    metrics.sourceIdentityAfterBoot = await sourceIdentity();
    evidenceDirectory = path.join(
      root,
      "artifacts/slice-1",
      fixture.boot.sha,
      fixture.boot.fixtureId
    );
    metrics.boot = fixture.boot;
    metrics.externalMetering = "unbound";
    assert.equal(
      metrics.sourceIdentityAfterBoot,
      metrics.sourceIdentity,
      "The source checkout changed during the fixture build"
    );
    owner = await fixture.signup("Pilot owner");
    const initialized = await initializeFixtureAgent(fixture, owner);
    ({ organizationId, principalId: ownerPrincipal, agentId } = initialized);
    support = await fixture.signup("Pilot support");
    outsider = await fixture.signup("Pilot outsider");
    for (const user of [support, outsider]) {
      await expectStatus(
        await fixture.request("/api/product/setup", user.cookie, {
          operationId: randomUUID(),
        }),
        403
      );
    }
    supportPrincipal = `pilot-support:${randomUUID()}`;
    await fixture.sql(
      `INSERT INTO identity_principal(id,organization_id,better_auth_user_id,kind,state) VALUES (${literal(supportPrincipal)},${literal(organizationId)},${literal(support.userId)},'human','active')`
    );
    const resources = [
      ["read", "memory", sourceId],
      ["write", "memory", sourceId],
      ["read", "memory", "pilot-refund-policy"],
      ["write", "memory", "pilot-refund-policy"],
      ["read", "tool", "fixture-read"],
      ["execute", "tool", "fixture-read"],
      ["read", "tool", "fixture_effect"],
      ["execute", "tool", "fixture_effect"],
      ["write", "tool", "fixture_effect"],
      ["approve", "tool", "fixture_effect"],
      ["execute", "tool", "fixture-connector"],
      ["read", "audit", organizationId],
      ["read", "budget", organizationId],
    ] as const;
    for (const principal of [ownerPrincipal, supportPrincipal]) {
      for (const [action, kind, resource] of resources) {
        await seedGrant(principal, action, kind, resource);
      }
    }
    await seedGrant(ownerPrincipal, "export", "audit", organizationId);
    await seedGrant(ownerPrincipal, "export", "budget", organizationId);
    const published = await fixture.json(
      `/api/product/agents/${encodeURIComponent(agentId)}`,
      owner.cookie,
      z.object({ agentId: z.string(), version: z.number() }),
      {
        enabledToolIds: ["fixture-read", "fixture_effect"],
        expectedVersion: initialized.version,
        grants: resources.map(([action, kind, resource]) => ({
          action,
          resource: { id: resource, kind, organizationId },
        })),
        instructions:
          "Answer from the supplied sources. Use fixture-read when requested. Use fixture_effect only when the user requests the write fixture.",
        model: "fixture/slice-1",
        name: "Pilot support",
        operationId: randomUUID(),
      },
      "PUT"
    );
    assert.equal(published.version, initialized.version + 1);
    await fixture.json(
      `/api/product/agents/${encodeURIComponent(agentId)}/access/${encodeURIComponent(supportPrincipal)}`,
      owner.cookie,
      z.unknown(),
      { actions: ["read", "execute", "approve"], operationId: randomUUID() },
      "PUT"
    );
    const catalog = await fixture.json(
      "/api/product/catalog",
      owner.cookie,
      z.object({
        connectorChoices: z.array(z.object({ id: z.string() })),
        modelChoices: z.array(z.object({ id: z.string() })),
      })
    );
    assert.ok(
      catalog.modelChoices.some((model) => model.id === "fixture/slice-1")
    );
    assert.ok(
      catalog.connectorChoices.some((tool) => tool.id === "fixture-read")
    );
    const ingested = await rpc(
      "memory.ingest",
      z.object({ status: z.literal("ok") }),
      {
        operationId: "pilot-ingest",
        organizationId,
        requestDigest: "sha256:pilot-ingest",
        source: {
          chunks: [{ id: "pilot-chunk-real", text: document }],
          document,
          expectedGeneration: null,
          observedAt: 1_800_000_000_000,
          sourceId,
          uri: sourceUri,
          version: sourceVersion,
          visibility: { grantId: "pilot-refund-policy", kind: "grant" },
        },
      }
    );
    evidence.ingest = ingested;
    assert.equal(
      await fixture.sql(
        `SELECT count(*) FROM memory_record WHERE organization_id=${literal(organizationId)} AND source_id=${literal(sourceId)} AND embedding IS NULL AND embedding_model IS NULL AND embedding_dimensions IS NULL`
      ),
      "1"
    );
    artifact = artifactSchema.parse(
      JSON.parse(
        await fixture.sql(
          `SELECT json_build_object('artifactId',id,'organizationId',organization_id,'provenance',json_build_object('observedAt',extract(epoch from observed_at)*1000,'sourceId',source_id,'sourceUri',source_uri,'sourceVersion',source_version),'visibility',visibility) FROM memory_artifact WHERE organization_id=${literal(organizationId)} AND source_id=${literal(sourceId)}`
        )
      )
    );
    await fixture.sql(`INSERT INTO usage_account(organization_id,unit,total,available,held,spent) VALUES(${literal(organizationId)},'historical-credits',1000,976,0,24);
      INSERT INTO usage_reservation(id,incurred,maximum,operation_id,organization_id,state,unit) VALUES('historical-model-1',12,100,'historical-operation-1',${literal(organizationId)},'settled','historical-credits'),('historical-model-2',12,100,'historical-operation-2',${literal(organizationId)},'settled','historical-credits');
      INSERT INTO usage_operation(id,canonical_input,digest,kind,result) VALUES('historical-operation-1','historical acceptance row','sha256:historical-1','settle','{"status":"ok"}'),('historical-operation-2','historical acceptance row','sha256:historical-2','settle','{"status":"ok"}');`);
    conversation = await createConversation();
    await writeFile(
      `/tmp/${fixture.boot.fixtureId}-private.json`,
      `${JSON.stringify({ agentId, outsider, owner, ownerPrincipal, support, supportPrincipal }, null, 2)}\n`,
      { mode: 0o600 }
    );
  },
  { timeout: 20 * 60_000 }
);

afterEach(async () => {
  if (!fixture) {
    return;
  }
  await fixture.controls({ arm: null, release: true });
  if (gates.has(currentGate)) {
    return;
  }
  const owned = [...ownerConversations.values()];
  const current = owned.filter((value) => value.gate === currentGate);
  const records: Record<string, unknown>[] = [];
  evidence[`failureDiagnostics:${currentGate}`] = records;
  for (const { address, gate: createdGate } of current.length > 0
    ? current
    : owned) {
    const started = performance.now();
    try {
      const response = await fixture.request(route(address), owner.cookie);
      const content = await response.text();
      records.push({
        bodySHA256: createHash("sha256").update(content).digest("hex"),
        code: response.status === 200 ? "ok" : publicFailureCode(content),
        conversationId: address.conversationId,
        createdGate,
        elapsedMs: Math.round(performance.now() - started),
        runs:
          response.status === 200
            ? viewSchema.parse(JSON.parse(content)).snapshot.runs
            : null,
        status: response.status,
      });
    } catch (error) {
      records.push({
        conversationId: address.conversationId,
        createdGate,
        elapsedMs: Math.round(performance.now() - started),
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
  }
});

after(async () => {
  if (!fixture) {
    return;
  }
  metrics.completedGates = [...gates];
  metrics.passed = gates.size === expectedGates;
  metrics.provider = await provider().catch(() => ({ unavailable: true }));
  await writeFile(
    path.join(evidenceDirectory, "pilot-result.json"),
    `${JSON.stringify({ evidence, metrics }, null, 2)}\n`
  );
  if (gates.size === expectedGates) {
    await fixture.close();
    await rm(`/tmp/${fixture.boot.fixtureId}-private.json`);
  } else {
    process.stderr.write(
      `Failed owned pilot stack retained: ${fixture.boot.fixtureId}\n`
    );
  }
});

gate(
  "selected Pi application retrieves real memory, canonical citations, MCP, and exact receipts",
  async () => {
    const initial = await provider();
    const historical = await fixture.sql(
      "SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) FROM usage_reservation t"
    );
    const empty = await read(conversation);
    assert.deepEqual(empty.snapshot.runs, []);
    assert.deepEqual(empty.snapshot.outputs, []);
    assert.deepEqual(empty.items, []);
    assert.deepEqual(await read(conversation), empty);
    assert.deepEqual(await modelCalls(), initial.model);
    const started = performance.now();
    const sent = await submit(
      conversation,
      firstEvent.text,
      firstEvent.eventId
    );
    metrics.admissionReceiptMs = Math.round(performance.now() - started);
    firstRunId = sent.receipt.runId;
    const view = await waitForFixture(
      () => read(conversation),
      (value) =>
        value.snapshot.runs.find((run) => run.runId === firstRunId)?.state ===
          "completed" &&
        value.items.some(
          (item) => item.type === "citation" && item.sourceId === sourceId
        ) &&
        value.items.some(
          (item) => item.type === "tool" && item.toolId === "fixture-read"
        ),
      60_000
    );
    metrics.answerCompletionMs = Math.round(performance.now() - started);
    const output = view.snapshot.outputs.find((value) =>
      value.runIds.some((member) => member === firstRunId)
    );
    assert.ok(output);
    assert.equal(output.text, "Cerebro slice 1 completed.");
    assert.deepEqual(
      output.citations.map((value) => value.sourceId),
      [sourceId]
    );
    assert.deepEqual(output.dependencies.sourceIds, [sourceId]);
    assert.ok(output.dependencies.toolIds.includes("fixture-read"));
    const [citation] = output.citations;
    assert.ok(citation);
    assert.equal(citation.sourceUri, sourceUri);
    assert.equal(citation.sourceVersion, sourceVersion);
    assert.ok(
      view.items.some(
        (item) => item.type === "citation" && item.sourceId === sourceId
      )
    );
    assert.ok(
      view.snapshot.tools.some(
        (tool) => tool.toolId === "fixture-read" && tool.state === "succeeded"
      )
    );
    const observed = await provider();
    const calls = observed.model.slice(initial.model.length);
    assert.equal(calls.length, 2);
    assert.equal(observed.tools.length - initial.tools.length, 1);
    assert.equal(observed.tools.at(-1)?.write, false);
    const preparedDigest = createHash("sha256")
      .update(
        `${firstEvent.text}\n\nAuthorized source excerpts:\n${sourceUri} (${sourceVersion}):\n${document}`
      )
      .digest("hex");
    assert.ok(
      calls.every(
        (call) =>
          call.model === "slice-1" &&
          call.maxTokens > 0 &&
          call.maxTokens <= 2048
      )
    );
    assert.ok(
      calls.every((call) => call.messageTextDigests.includes(preparedDigest)),
      "The physical provider must receive the complete authorized document"
    );
    assert.equal(
      await fixture.sql(
        "SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) FROM usage_reservation t"
      ),
      historical
    );
    const replay = await submit(
      conversation,
      firstEvent.text,
      firstEvent.eventId
    );
    assert.equal(replay.receipt.replayed, true);
    assert.equal(replay.receipt.runId, firstRunId);
    await expectStatus(
      await fixture.request(`${route(conversation)}/messages`, owner.cookie, {
        ...firstEvent,
        text: "Changed",
      }),
      409
    );
    assert.deepEqual(await modelCalls(), observed.model);
    assert.deepEqual(await toolCalls(), observed.tools);
    const source = await fixture.json(
      `${route(conversation)}/sources/${sourceId}`,
      owner.cookie,
      z.object({ sourceVersion: z.string(), text: z.string() })
    );
    assert.equal(source.text, document);
    assert.equal(source.sourceVersion, sourceVersion);
    const original = await rpc(
      "memory.readArtifact",
      z.object({ status: z.literal("ok"), value: z.array(z.number()) }),
      { organizationId, ref: artifact }
    );
    assert.equal(Buffer.from(original.value).toString("utf-8"), document);
    evidence.realMemory = {
      artifact,
      calls,
      citation,
      firstRunId,
      preparedDigest,
      source,
      view,
    };
  }
);

gate(
  "audit append, redaction, and historical exports use current authorization",
  async () => {
    const recordsSchema = z.object({
      records: z.array(
        z
          .object({
            eventId: z.string(),
            organizationId: z.string(),
            payload: z.unknown(),
          })
          .passthrough()
      ),
    });
    // Earlier conversations drain their audit outboxes in the background.
    // Read until the export and the table agree, then test replay on one event.
    const consistent = await waitForFixture(
      async () => ({
        exported: await rpc("identity.exportData", recordsSchema, {
          kind: "audit",
          limit: 200,
          organizationId,
        }),
        rows: Number(
          await fixture.sql(
            `SELECT count(*) FROM cerebro_audit_event WHERE organization_id=${literal(organizationId)}`
          )
        ),
      }),
      (value) => value.rows === value.exported.records.length,
      30_000
    );
    const { exported } = consistent;
    assert.ok(exported.records.length >= 4);
    assert.ok(
      exported.records.every(
        (record) => record.organizationId === organizationId
      )
    );
    assert.equal(
      JSON.stringify(exported).includes("CEREBRO-REAL-MEMORY-731"),
      false
    );
    assert.equal(
      JSON.stringify(exported).includes("MCP read completed."),
      false
    );
    assert.equal(JSON.stringify(exported).includes(firstEvent.text), false);
    assert.equal(
      JSON.stringify(exported).includes("Cerebro slice 1 completed."),
      false
    );
    const [firstAudit] = exported.records;
    assert.ok(firstAudit);
    const { eventId } = firstAudit;
    assert.equal(
      await fixture.sql(
        `SELECT count(*) FROM cerebro_audit_event WHERE event_id=${literal(eventId)}`
      ),
      "1"
    );
    const historical = await rpc(
      "identity.exportData",
      z.object({
        records: z.array(
          z.object({
            id: z.string(),
            incurred: z.number(),
            organizationId: z.string(),
            state: z.literal("settled"),
          })
        ),
      }),
      { kind: "usage", limit: 20, organizationId }
    );
    assert.deepEqual(
      historical.records.map((record) => record.id),
      ["historical-model-1", "historical-model-2"]
    );
    assert.ok(
      historical.records.every(
        (record) =>
          record.organizationId === organizationId && record.incurred === 12
      )
    );
    for (const kind of ["audit", "usage"]) {
      await expectStatus(
        await fixture.request("/rpc/identity/exportData", support.cookie, {
          json: { kind, limit: 20, organizationId },
        }),
        403
      );
    }
    evidence.audit = { eventId, exported, historical, rows: consistent.rows };
  }
);

gate(
  "company, agent, tool, source, and principal revocations deny cached content and resumed history",
  async () => {
    const beforeProvider = await provider();
    const deniedSubmissions: {
      conversationId: string;
      eventId: string;
      text: string;
    }[] = [];
    evidence.deniedSubmissions = deniedSubmissions;
    // The session is the only admission point: a denied message never becomes
    // a user message in any snapshot that is readable again later.
    const assertNoDeniedAdmission = (snapshots: readonly DomainSnapshot[]) => {
      for (const snapshot of snapshots) {
        for (const denied of deniedSubmissions) {
          assert.equal(
            snapshot.userMessages.some(
              (message) => message.text === denied.text
            ),
            false
          );
        }
      }
    };
    const denyMessage = async (
      address: Conversation,
      cookie: string,
      text: string,
      eventId = randomUUID()
    ) => {
      deniedSubmissions.push({
        conversationId: address.conversationId,
        eventId,
        text,
      });
      await expectStatus(
        await fixture.request(`${route(address)}/messages`, cookie, {
          eventId,
          mode: "follow-up",
          text,
        }),
        403
      );
    };
    const foreign = await fixture.signup("Pilot foreign company");
    const foreignCompany = `foreign:${randomUUID()}`;
    await fixture.sql(
      `INSERT INTO organization(id,name) VALUES(${literal(foreignCompany)},'Foreign pilot company'); INSERT INTO identity_principal(id,organization_id,better_auth_user_id,kind,state) VALUES(${literal(`foreign:${randomUUID()}`)},${literal(foreignCompany)},${literal(foreign.userId)},'human','active')`
    );
    for (const credentials of [outsider.cookie, foreign.cookie]) {
      for (const suffix of [
        "",
        "/history",
        `/sources/${sourceId}`,
        "/observations?accessGeneration=0",
        "/messages",
      ]) {
        if (suffix === "/messages") {
          await denyMessage(conversation, credentials, "Denied write fixture");
          continue;
        }
        await expectStatus(
          await fixture.request(`${route(conversation)}${suffix}`, credentials),
          403
        );
      }
    }
    const supportConversation = await createConversation(support.cookie);
    const supportView = await fixture.json(
      route(supportConversation),
      support.cookie,
      viewSchema
    );
    const accessRoute = `/api/product/agents/${encodeURIComponent(agentId)}/access/${encodeURIComponent(supportPrincipal)}`;
    await fixture.json(
      accessRoute,
      owner.cookie,
      z.unknown(),
      { actions: [], operationId: randomUUID() },
      "PUT"
    );
    await expectStatus(
      await fixture.request(
        `${route(supportConversation)}/history`,
        support.cookie
      ),
      403
    );
    await denyMessage(
      supportConversation,
      support.cookie,
      "Denied agent execution"
    );
    await fixture.json(
      accessRoute,
      owner.cookie,
      z.unknown(),
      { actions: ["read", "execute", "approve"], operationId: randomUUID() },
      "PUT"
    );
    const restoredSupportView = await fixture.json(
      route(supportConversation),
      support.cookie,
      viewSchema
    );
    assert.deepEqual(restoredSupportView.snapshot, supportView.snapshot);
    assertNoDeniedAdmission([restoredSupportView.snapshot]);
    const beforeToolRevocation = await read(conversation);
    await fixture.sql(
      `DELETE FROM identity_grant WHERE organization_id=${literal(organizationId)} AND principal_id=${literal(ownerPrincipal)} AND resource_kind='tool' AND resource_id='fixture-read'`
    );
    try {
      await expectStatus(
        await fixture.request(route(conversation), owner.cookie),
        403
      );
      await expectStatus(
        await fixture.request(`${route(conversation)}/history`, owner.cookie),
        403
      );
      await denyMessage(conversation, owner.cookie, "Denied cached tool input");
    } finally {
      await seedGrant(ownerPrincipal, "read", "tool", "fixture-read");
      await seedGrant(ownerPrincipal, "execute", "tool", "fixture-read");
    }
    const retainedView = await read(conversation);
    assert.deepEqual(retainedView.snapshot, beforeToolRevocation.snapshot);
    assertNoDeniedAdmission([retainedView.snapshot]);
    const deniedEventId = randomUUID();
    await fixture.sql(
      `DELETE FROM identity_grant WHERE organization_id=${literal(organizationId)} AND principal_id=${literal(ownerPrincipal)} AND resource_kind='memory' AND resource_id=${literal(sourceId)}`
    );
    try {
      for (const suffix of [
        "",
        "/history",
        `/sources/${sourceId}`,
        "/observations?accessGeneration=0",
      ]) {
        await expectStatus(
          await fixture.request(
            `${route(conversation)}${suffix}`,
            owner.cookie
          ),
          403
        );
      }
      await denyMessage(
        conversation,
        owner.cookie,
        "Use previous pilot answer",
        deniedEventId
      );
      const laterSupportView = await fixture.json(
        route(supportConversation),
        support.cookie,
        viewSchema
      );
      assert.deepEqual(laterSupportView.snapshot, supportView.snapshot);
      assert.deepEqual(await modelCalls(), beforeProvider.model);
      assert.deepEqual(await toolCalls(), beforeProvider.tools);
    } finally {
      await seedGrant(ownerPrincipal, "read", "memory", sourceId);
      await seedGrant(ownerPrincipal, "write", "memory", sourceId);
    }
    for (let sample = 0; sample < 3; sample += 1) {
      await delay(1000);
      const restoredView = await read(conversation);
      assert.deepEqual(restoredView.snapshot, retainedView.snapshot);
      const restoredSupportSnapshot = await fixture.json(
        route(supportConversation),
        support.cookie,
        viewSchema
      );
      assert.deepEqual(restoredSupportSnapshot.snapshot, supportView.snapshot);
      assertNoDeniedAdmission([
        restoredView.snapshot,
        restoredSupportSnapshot.snapshot,
      ]);
      assert.deepEqual(await modelCalls(), beforeProvider.model);
      assert.deepEqual(await toolCalls(), beforeProvider.tools);
    }
    await fixture.sql(
      `UPDATE identity_principal SET state='disabled' WHERE id=${literal(supportPrincipal)}`
    );
    await expectStatus(
      await fixture.request("/api/product/agents", support.cookie),
      403
    );
    await fixture.sql(
      `UPDATE identity_principal SET state='active' WHERE id=${literal(supportPrincipal)}`
    );
    const finalProvider = await provider();
    assert.deepEqual(finalProvider.model, beforeProvider.model);
    assert.deepEqual(finalProvider.tools, beforeProvider.tools);
    evidence.revocations = {
      beforeProvider,
      deniedEventId,
      deniedSubmissions,
      finalProvider,
      retainedNativeSnapshot: retainedView.snapshot,
    };
  }
);

gate("model input limits cause zero physical dispatch", async () => {
  const beforeProvider = await provider();
  await expectStatus(
    await fixture.request(`${route(conversation)}/chat/session`, owner.cookie),
    404
  );
  const oversizedId = "pilot-oversized-source";
  const oversizedText = `Oversized pilot context ${"oversized ".repeat(16_000)}`;
  for (const action of ["read", "write"]) {
    await seedGrant(ownerPrincipal, action, "memory", oversizedId);
  }
  await rpc("memory.ingest", z.object({ status: z.literal("ok") }), {
    operationId: randomUUID(),
    organizationId,
    requestDigest: "sha256:oversized-source",
    source: {
      chunks: [{ id: "pilot-oversized-chunk", text: oversizedText }],
      document: oversizedText,
      expectedGeneration: null,
      observedAt: Date.now(),
      sourceId: oversizedId,
      uri: "urn:cerebro:pilot:oversized",
      version: "1",
      visibility: { kind: "organization" },
    },
  });
  const selected = await fixture.json(
    "/api/product/agents",
    owner.cookie,
    z.object({ agentId: z.string() }),
    {
      enabledToolIds: [],
      grants: [
        {
          action: "read",
          resource: { id: oversizedId, kind: "memory", organizationId },
        },
      ],
      instructions: "Answer from the authorized source.",
      model: "fixture/slice-1",
      name: "Oversized provider context",
      operationId: randomUUID(),
    }
  );
  try {
    const address = await createConversation(owner.cookie, selected.agentId);
    const sent = await submit(address, "Read the oversized pilot context.");
    const view = await state(address, sent.receipt.runId, "failed");
    assert.deepEqual(await modelCalls(), beforeProvider.model);
    assert.deepEqual(await toolCalls(), beforeProvider.tools);
    evidence.inputLimits = {
      bytes: Buffer.byteLength(oversizedText),
      view,
    };
  } finally {
    await fixture.sql(
      `UPDATE memory_source SET state='revoked' WHERE organization_id=${literal(organizationId)} AND id=${literal(oversizedId)}`
    );
  }
});

gate(
  "durable approval survives SIGKILL and invalid approval causes zero write effects",
  async () => {
    const initial = await provider();
    const address = await createConversation();
    const sent = await submit(
      address,
      "Run the approval fixture for the pilot refund support policy."
    );
    const approval = await pending(address, sent.receipt.runId);
    const approvalRoute = `${route(address)}/approvals/${encodeURIComponent(approval.approvalId)}`;
    const decision = {
      decision: "allow",
      operationId: randomUUID(),
      runId: approval.runId,
    };
    await expectStatus(
      await fixture.request(approvalRoute, outsider.cookie, decision),
      403
    );
    await expectStatus(
      await fixture.request(approvalRoute, owner.cookie, {
        ...decision,
        arguments: { value: "changed" },
      }),
      422
    );
    await expectStatus(
      await fixture.request(approvalRoute, owner.cookie, {
        operationId: randomUUID(),
      }),
      422
    );
    assert.deepEqual(await toolCalls(), initial.tools);
    const started = performance.now();
    const restartEvidence = await restart(address);
    const recovered = await state(
      address,
      sent.receipt.runId,
      "waiting-for-approval"
    );
    assert.deepEqual(
      recovered.snapshot.approvals.find(
        (value) => value.approvalId === approval.approvalId
      ),
      approval
    );
    assert.deepEqual(await toolCalls(), initial.tools);
    await approve(address, approval, decision.operationId);
    const completed = await state(address, sent.receipt.runId, "completed");
    await approve(address, approval, decision.operationId);
    const finalProvider = await provider();
    assert.equal(
      finalProvider.tools.filter((tool) => tool.write).length -
        initial.tools.filter((tool) => tool.write).length,
      1
    );
    assert.equal(
      finalProvider.tools.filter(
        (tool) => tool.operationId === approval.operationId
      ).length,
      1
    );
    assert.equal(completed.snapshot.approvals[0]?.state, "allowed");
    assert.equal(completed.snapshot.tools[0]?.state, "succeeded");
    metrics.approvalRecoveryMs = Math.round(performance.now() - started);
    evidence.approvalRestart = {
      approval,
      completed,
      finalProvider,
      recovered,
      restartEvidence,
    };
  }
);

gate(
  "native approval expiry preserves its waiting owner and rejects an expired write intent",
  async () => {
    const address = await createConversation();
    const sent = await submit(address, "Run the approval fixture expiry case.");
    const approval = await pending(address, sent.receipt.runId);
    const waitingProvider = await provider();
    const startedAt = Date.now();
    const started = performance.now();
    const samples: {
      at: number;
      elapsedMs: number;
      beforeExpiry: boolean;
      modelCount: number;
      toolCount: number;
      runState: string | undefined;
    }[] = [];
    evidence.approvalExpiry = { approval, samples, waitingProvider };
    assert.ok(approval.expiresAt - startedAt >= 50_000);
    for (let sample = 0; sample < 13; sample += 1) {
      await delay(5000);
      const view = await read(address);
      const observed = await provider();
      const at = Date.now();
      const currentApproval = view.snapshot.approvals.find(
        (value) => value.approvalId === approval.approvalId
      );
      const run = view.snapshot.runs.find(
        (value) => value.runId === sent.receipt.runId
      );
      assert.ok(currentApproval);
      assert.equal(currentApproval.expiresAt, approval.expiresAt);
      assert.equal(currentApproval.operationId, approval.operationId);
      assert.equal(currentApproval.runId, approval.runId);
      assert.deepEqual(observed.tools, waitingProvider.tools);
      const beforeExpiry = at < approval.expiresAt;
      if (beforeExpiry) {
        assert.deepEqual(currentApproval, approval);
        assert.equal(run?.state, "waiting-for-approval");
        assert.deepEqual(observed.model, waitingProvider.model);
      }
      samples.push({
        at,
        beforeExpiry,
        elapsedMs: Math.round(performance.now() - started),
        modelCount: observed.model.length,
        runState: run?.state,
        toolCount: observed.tools.length,
      });
    }
    const elapsedMs = Math.round(performance.now() - started);
    assert.ok(elapsedMs >= 65_000);
    assert.ok(
      samples.some(
        (sample) => sample.beforeExpiry && sample.elapsedMs >= 50_000
      )
    );
    assert.ok(Date.now() >= approval.expiresAt);
    const expiredView = await read(address);
    const beforeDeniedDecision = await provider();
    const operationId = randomUUID();
    await expectStatus(
      await fixture.request(
        `${route(address)}/approvals/${encodeURIComponent(approval.approvalId)}`,
        owner.cookie,
        { decision: "allow", operationId, runId: approval.runId }
      ),
      403
    );
    const finalProvider = await provider();
    const deniedView = await read(address);
    assert.deepEqual(
      deniedView.snapshot.approvals,
      expiredView.snapshot.approvals
    );
    assert.deepEqual(finalProvider.model, beforeDeniedDecision.model);
    assert.deepEqual(finalProvider.tools, beforeDeniedDecision.tools);
    assert.deepEqual(finalProvider.tools, waitingProvider.tools);
    const terminal = await waitForFixture(
      () => read(address),
      (view) =>
        view.snapshot.runs.some(
          (run) =>
            run.runId === sent.receipt.runId &&
            ["completed", "failed", "cancelled"].includes(run.state)
        ),
      60_000
    );
    metrics.approvalExpiryObservationMs = elapsedMs;
    evidence.approvalExpiry = {
      approval,
      beforeDeniedDecision,
      deniedView,
      expiredView,
      finalProvider,
      operationId,
      samples,
      terminal,
      waitingProvider,
    };
  }
);

gate(
  "revoked write authority rejects approval before its external effect",
  async () => {
    const initial = await provider();
    const address = await createConversation();
    const sent = await submit(
      address,
      "Apply write fixture with fixture_effect after approval."
    );
    const approval = await pending(address, sent.receipt.runId);
    await fixture.sql(
      `DELETE FROM identity_grant WHERE organization_id=${literal(organizationId)} AND principal_id=${literal(ownerPrincipal)} AND action='execute' AND resource_kind='tool' AND resource_id='fixture_effect'`
    );
    try {
      await expectStatus(
        await fixture.request(
          `${route(address)}/approvals/${encodeURIComponent(approval.approvalId)}`,
          owner.cookie,
          {
            decision: "allow",
            operationId: randomUUID(),
            runId: approval.runId,
          }
        ),
        403
      );
      assert.deepEqual(await toolCalls(), initial.tools);
    } finally {
      await seedGrant(ownerPrincipal, "execute", "tool", "fixture_effect");
    }
    await cancel(address, sent.receipt.runId);
    const cancelled = await read(address);
    assert.equal(cancelled.snapshot.runs[0]?.state, "cancelled");
    evidence.revokedWrite = { after: await provider(), approval, initial };
  }
);

gate(
  "a non-idempotent write interrupted by SIGKILL is never dispatched again",
  async () => {
    const initial = await provider();
    const armId = `pilot-unknown:${randomUUID()}`;
    await fixture.controls({
      arm: { boundary: "after-tool-dispatch", id: armId },
    });
    const address = await createConversation();
    const text = "Apply write fixture with fixture_effect once.";
    const eventId = randomUUID();
    const sent = await submit(address, text, eventId);
    const approval = await pending(address, sent.receipt.runId);
    const approving = (async () => {
      try {
        await approve(address, approval);
        return { status: "fulfilled" as const };
      } catch (error) {
        return {
          errorName: error instanceof Error ? error.name : "unknown",
          status: "rejected" as const,
        };
      }
    })();
    await waitForFixture(
      provider,
      (value) =>
        value.held > 0 &&
        value.tools.some((tool) => tool.operationId === approval.operationId),
      30_000
    );
    const restartEvidence = await restart(address, approval.operationId);
    const approvalOutcome = await approving;
    // Pi replays the interrupted call; its dispatch marker stops a second
    // write and the model is told that the outcome is unknown.
    const settled = await state(address, sent.receipt.runId, "completed");
    assert.equal(settled.snapshot.tools[0]?.state, "unknown-outcome");
    assert.equal(settled.snapshot.outputs.length, 1);
    const finalProvider = await provider();
    assert.equal(finalProvider.tools.length - initial.tools.length, 1);
    assert.equal(
      finalProvider.tools.filter(
        (tool) => tool.operationId === approval.operationId
      ).length,
      1
    );
    const exact = await submit(address, text, eventId);
    assert.equal(exact.receipt.replayed, true);
    assert.equal(exact.receipt.runId, sent.receipt.runId);
    assert.deepEqual(await toolCalls(), finalProvider.tools);
    evidence.unknownWrite = {
      approval,
      approvalOutcome,
      armId,
      exact,
      finalProvider,
      restartEvidence,
      settled,
    };
  }
);

gate(
  "queued withdrawal preserves the active run and Stop makes replacement eligible",
  async () => {
    const initial = await provider();
    const address = await createConversation();
    const active = await submit(
      address,
      "Run the approval fixture as active A."
    );
    await pending(address, active.receipt.runId);
    const queued = await submit(address, "Queued B follow-up");
    await state(address, queued.receipt.runId, "queued");
    await expectStatus(
      await fixture.request(
        `${route(address)}/runs/${encodeURIComponent(queued.receipt.runId)}/cancel`,
        owner.cookie,
        { operationId: randomUUID(), text: "changed" }
      ),
      422
    );
    await cancel(address, queued.receipt.runId);
    const withdrawn = await state(address, queued.receipt.runId, "cancelled");
    assert.equal(
      withdrawn.snapshot.runs.find((run) => run.runId === active.receipt.runId)
        ?.state,
      "waiting-for-approval"
    );
    const queuedAgain = await submit(address, "Queued C before active Stop");
    await cancel(address, active.receipt.runId);
    const stopped = await state(address, active.receipt.runId, "cancelled");
    assert.equal(
      stopped.snapshot.runs.find(
        (run) => run.runId === queuedAgain.receipt.runId
      )?.state,
      "cancelled"
    );
    const predecessor = await submit(
      address,
      "Run the approval fixture before replacement."
    );
    await pending(address, predecessor.receipt.runId);
    const replacedQueue = await submit(address, "Queued before replacement");
    const replacementEvent = randomUUID();
    const replacementText = "Run the approval fixture replacement.";
    const replacement = await submit(
      address,
      replacementText,
      replacementEvent,
      "replace"
    );
    const approval = await pending(address, replacement.receipt.runId);
    const eligible = await read(address);
    assert.equal(
      eligible.snapshot.runs.find(
        (run) => run.runId === predecessor.receipt.runId
      )?.state,
      "cancelled"
    );
    assert.equal(
      eligible.snapshot.runs.find(
        (run) => run.runId === replacedQueue.receipt.runId
      )?.state,
      "cancelled"
    );
    const later = await submit(address, "Later accepted follow-up");
    const beforeReplay = await provider();
    const exact = await submit(
      address,
      replacementText,
      replacementEvent,
      "replace"
    );
    assert.equal(exact.receipt.replayed, true);
    assert.equal(exact.receipt.runId, replacement.receipt.runId);
    const afterReplay = await read(address);
    assert.equal(
      afterReplay.snapshot.runs.find((run) => run.runId === later.receipt.runId)
        ?.state,
      "queued"
    );
    assert.deepEqual(await modelCalls(), beforeReplay.model);
    await approve(address, approval);
    await state(address, replacement.receipt.runId, "completed");
    const complete = await state(address, later.receipt.runId, "completed");
    const completedProvider = await provider();
    assert.equal(
      completedProvider.tools.filter((tool) => tool.write).length -
        initial.tools.filter((tool) => tool.write).length,
      1
    );
    assert.equal(
      complete.snapshot.userMessages.find(
        (message) => message.runId === replacement.receipt.runId
      )?.mode,
      "replace"
    );
    evidence.stop = {
      active,
      complete,
      eligible,
      exact,
      later,
      queued,
      replacement,
      stopped,
      withdrawn,
    };
  }
);

gate(
  "cold backup restores seven physical stores with original auth, history, citations, artifacts, and receipts",
  async () => {
    metrics.restore = await verifyPilotRestore({
      artifact,
      boot: fixture.boot,
      conversationId: conversation.conversationId,
      cookie: owner.cookie,
      event: firstEvent,
      sourceId,
      sourceText: document,
    });
  },
  15 * 60_000
);
