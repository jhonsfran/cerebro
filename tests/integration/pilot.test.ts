/* oxlint-disable no-await-in-loop -- Acceptance steps change the state used by the next authenticated request. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { verifyPilotRestore } from "./pilot-restore.ts";

const exec = promisify(execFile);
const project =
  process.env.CEREBRO_S7_PROJECT ??
  `cerebro-pilot-${randomBytes(4).toString("hex")}`;
const organizationId = "local-company";
const sourceId = "pilot-source-real";
const document =
  "Pilot support policy permits refunds within 14 days. The reference code is CEREBRO-REAL-MEMORY-731.";
const outputPollingIntervalMs = 400;
const metrics: Record<string, unknown> = { outputPollingIntervalMs, project };
let environment: NodeJS.ProcessEnv;
let apiUrl: string;
let webUrl: string;
let fixtureUrl: string;
let cookie: string;
let supportCookie: string;
let ownerPrincipal: string;
let supportPrincipal: string;
let agentId: string;
let conversation: Conversation;
let firstRunId: string;
let passed = false;
interface Conversation {
  conversationId: string;
  sessionId: string;
  agentId: string;
}
interface Item {
  type: string;
  run?: { runId: string; state: string };
  text?: string;
  toolId?: string;
  sourceId?: string;
  runId?: string;
  approvalId?: string;
  dependencies?: { sourceIds: string[]; toolIds: string[] };
}
interface View {
  items: Item[];
  snapshot: { runs: { runId: string; state: string }[] };
  cursor: string;
}
interface Observation {
  model: { operationId: string; model: string; maxTokens: number }[];
  tools: Record<
    string,
    { count: number; startedAt: number; completedAt: number }
  >;
  effects: Record<string, { count: number; effects: number }>;
  held: string[];
}
const freePort = async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  server.close();
  await once(server, "close");
  return address.port;
};
const docker = async (...args: string[]) =>
  await exec("docker", ["compose", "-p", project, ...args], {
    env: environment,
    maxBuffer: 12 * 1024 * 1024,
    timeout: 15 * 60_000,
  });
const containerStats = async (): Promise<string> => {
  const containers = await docker("ps", "-q");
  const statistics = await exec(
    "docker",
    [
      "stats",
      "--no-stream",
      "--format",
      "{{json .}}",
      ...containers.stdout.trim().split("\n").filter(Boolean),
    ],
    { env: environment, timeout: 30_000 }
  );
  return statistics.stdout;
};
const sql = async (query: string) => {
  const result = await docker(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "cerebro",
    "-d",
    "cerebro",
    "-tA",
    "-c",
    query
  );
  return result.stdout.trim();
};
const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;
const request = async (
  path: string,
  input?: unknown,
  credentials = cookie,
  method = input === undefined ? "GET" : "POST"
) => {
  const options: RequestInit = {
    headers: {
      "Content-Type": "application/json",
      Cookie: credentials,
      Origin: webUrl,
    },
    method,
    signal: AbortSignal.timeout(30_000),
  };
  if (input !== undefined) {
    options.body = JSON.stringify(input);
  }
  return await fetch(`${apiUrl}${path}`, options);
};
const json = async <Value>(
  path: string,
  input?: unknown,
  credentials = cookie,
  method?: string
): Promise<Value> => {
  const response = await request(path, input, credentials, method);
  const body = await response.text();
  assert.equal(response.status, 200, `${path}: ${body}`);
  return JSON.parse(body) as Value;
};
const rpc = async <Value>(
  name: string,
  input: unknown,
  credentials = cookie
): Promise<Value> => {
  const response = await json<{ json: Value }>(
    `/rpc/${name.replaceAll(".", "/")}`,
    { json: input },
    credentials
  );
  return response.json;
};
const waitFor = async <Value>(
  read: () => Promise<Value>,
  matches: (value: Value) => boolean,
  timeoutMs = 120_000
): Promise<Value> => {
  const deadline = Date.now() + timeoutMs;
  let last: Value | undefined;
  let failure: unknown;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (matches(last)) {
        return last;
      }
    } catch (error) {
      failure = error;
    }
    await delay(outputPollingIntervalMs);
  }
  throw new Error(
    `Acceptance state did not converge: ${JSON.stringify(last)} ${String(failure)}`
  );
};
const signup = async (name: string) => {
  const password = randomBytes(24).toString("base64url");
  const email = `${name.toLowerCase().replaceAll(" ", "-")}-${randomBytes(5).toString("hex")}@example.test`;
  const response = await request(
    "/api/auth/sign-up/email",
    { email, name, password },
    ""
  );
  assert.equal(response.status, 200, await response.text());
  const cookieValue = response.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .join("; ");
  const session = await json<{ user: { id: string } }>(
    "/api/auth/get-session",
    undefined,
    cookieValue
  );
  return { cookie: cookieValue, email, password, userId: session.user.id };
};
const seedGrant = async (
  principalId: string,
  action: string,
  kind: string,
  resourceId: string
) =>
  await sql(
    `INSERT INTO identity_grant(organization_id,principal_id,action,resource_kind,resource_id,source) VALUES (${quoted(organizationId)},${quoted(principalId)},${quoted(action)},${quoted(kind)},${quoted(resourceId)},'acceptance-trusted') ON CONFLICT DO NOTHING`
  );
const observe = async () => {
  const response = await fetch(`${fixtureUrl}/observations`);
  assert.equal(response.status, 200);
  return (await response.json()) as Observation;
};
const modelCount = async () => {
  const observation = await observe();
  return observation.model.length;
};
const effectsObserved = async () => {
  const observation = await observe();
  return Object.values(observation.effects);
};
const control = async (input: unknown) => {
  const response = await fetch(`${fixtureUrl}/control`, {
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(response.status, 200);
};
const createConversation = async (credentials = cookie) =>
  await json<Conversation>(
    "/api/product/conversations",
    { agentId, operationId: randomBytes(8).toString("hex") },
    credentials
  );
const submit = async (
  address: Conversation,
  text: string,
  eventId = randomBytes(8).toString("hex"),
  credentials = cookie
) =>
  await json<{ receipt: { runId: string; replayed: boolean }; cursor: string }>(
    `/api/product/conversations/${encodeURIComponent(address.conversationId)}/messages`,
    { eventId, text },
    credentials
  );
const read = async (address: Conversation, credentials = cookie) =>
  await json<View>(
    `/api/product/conversations/${encodeURIComponent(address.conversationId)}`,
    undefined,
    credentials
  );
const completed = async (
  address: Conversation,
  runId: string,
  credentials = cookie,
  outputObserved?: () => void
) =>
  await waitFor(
    () => read(address, credentials),
    (view) => {
      const hasOutput = view.items.some(
        (item) => item.type === "output" && item.runId === runId
      );
      if (hasOutput) {
        outputObserved?.();
      }
      const run = view.snapshot.runs.find(
        (candidate) => candidate.runId === runId
      );
      if (run?.state === "completed") {
        return hasOutput;
      }
      return (
        ["failed", "unknown-outcome"].includes(run?.state ?? "") &&
        view.items.some(
          (item) =>
            item.type === "run" &&
            item.run?.runId === runId &&
            item.run.state === run?.state
        )
      );
    }
  );

before(
  async () => {
    const [apiPort, webPort, fixturePort] = await Promise.all([
      process.env.CEREBRO_API_PORT
        ? Number(process.env.CEREBRO_API_PORT)
        : freePort(),
      process.env.CEREBRO_WEB_PORT
        ? Number(process.env.CEREBRO_WEB_PORT)
        : freePort(),
      process.env.CEREBRO_FIXTURE_PORT
        ? Number(process.env.CEREBRO_FIXTURE_PORT)
        : freePort(),
    ]);
    apiUrl = `http://localhost:${apiPort}`;
    webUrl = `http://localhost:${webPort}`;
    fixtureUrl = `http://localhost:${fixturePort}`;
    environment = {
      ...process.env,
      CEREBRO_API_PORT: String(apiPort),
      CEREBRO_FIXTURE_PORT: String(fixturePort),
      CEREBRO_PUBLIC_API_URL: apiUrl,
      CEREBRO_PUBLIC_WEB_URL: webUrl,
      CEREBRO_WEB_PORT: String(webPort),
    };
    metrics.apiUrl = apiUrl;
    metrics.webUrl = webUrl;
    metrics.fixtureUrl = fixtureUrl;
    try {
      await docker("up", "--build", "-d", "--wait");
    } catch (error) {
      const logs = await docker(
        "logs",
        "--no-color",
        "--tail=100",
        "bootstrap",
        "celld"
      );
      throw new Error(`${String(error)}\n${logs.stdout}`, { cause: error });
    }
    const readiness = await fetch(`${apiUrl}/ready`);
    assert.equal(readiness.status, 200);
    const owner = await signup("Pilot Owner");
    ({ cookie } = owner);
    const setup = await json<{ principalId: string; owner: boolean }>(
      "/api/product/setup",
      { operationId: "pilot-owner" }
    );
    assert.equal(setup.owner, true);
    ownerPrincipal = setup.principalId;
    const support = await signup("Pilot Support");
    supportCookie = support.cookie;
    supportPrincipal = `support-${randomBytes(6).toString("hex")}`;
    await sql(
      `INSERT INTO identity_principal(id,organization_id,better_auth_user_id,kind,state) VALUES (${quoted(supportPrincipal)},${quoted(organizationId)},${quoted(support.userId)},'human','active')`
    );
    for (const principal of [ownerPrincipal, supportPrincipal]) {
      for (const [action, kind, resource] of [
        ["read", "memory", sourceId],
        ["write", "memory", sourceId],
        ["read", "memory", "pilot-refund-policy"],
        ["write", "memory", "pilot-refund-policy"],
        ["read", "tool", "fixture-read"],
        ["execute", "tool", "fixture-read"],
        ["read", "tool", "fixture_effect"],
        ["execute", "tool", "fixture_effect"],
        ["execute", "tool", "fixture-connector"],
        ["read", "audit", organizationId],
        ["read", "budget", organizationId],
      ]) {
        await seedGrant(principal, action, kind, resource);
      }
    }
    await seedGrant(ownerPrincipal, "export", "audit", organizationId);
    await seedGrant(ownerPrincipal, "export", "budget", organizationId);
    const catalog = await json<{
      modelChoices: { id: string }[];
      connectorChoices: { id: string }[];
    }>("/api/product/catalog");
    assert.ok(
      catalog.modelChoices.some((model) => model.id === "fixture/pilot")
    );
    assert.ok(
      catalog.connectorChoices.some((tool) => tool.id === "fixture-read")
    );
    const grants = [
      ["read", "memory", sourceId],
      ["read", "tool", "fixture-read"],
      ["execute", "tool", "fixture-read"],
      ["read", "tool", "fixture_effect"],
      ["execute", "tool", "fixture_effect"],
      ["execute", "tool", "fixture-connector"],
    ].map(([action, kind, resource]) => ({
      action,
      resource: { id: resource, kind, organizationId },
    }));
    const published = await json<{
      definition: { agentId: string };
      agentId?: string;
    }>("/api/product/agents", {
      enabledToolIds: ["fixture-read", "fixture_effect"],
      grants,
      instructions:
        "Answer from the supplied source. Use the available read tool once. Use fixture_effect only when the user asks for write fixture.",
      model: "fixture/pilot",
      name: "Pilot Support",
      operationId: "pilot-publish",
    });
    agentId = published.agentId ?? published.definition.agentId;
    await json(
      `/api/product/agents/${encodeURIComponent(agentId)}/access/${encodeURIComponent(supportPrincipal)}`,
      {
        actions: ["read", "execute", "approve"],
        operationId: "support-access",
      },
      cookie,
      "PUT"
    );
    const ingested = await rpc<{ status: string }>("memory.ingest", {
      operationId: "pilot-ingest",
      organizationId,
      requestDigest: "sha256:pilot-ingest",
      source: {
        chunks: [{ id: "pilot-chunk-real", text: document }],
        document,
        expectedGeneration: null,
        observedAt: 1_800_000_000_000,
        sourceId,
        uri: "urn:cerebro:pilot:refund-policy",
        version: "1",
        visibility: { grantId: "pilot-refund-policy", kind: "grant" },
      },
    });
    assert.equal(ingested.status, "ok", JSON.stringify(ingested));
    const vectors = await sql(
      `SELECT count(*) FROM memory_record WHERE organization_id=${quoted(organizationId)} AND source_id=${quoted(sourceId)} AND embedding IS NULL AND embedding_model IS NULL AND embedding_dimensions IS NULL`
    );
    assert.equal(vectors, "1");
    const artifacts = await sql(
      `SELECT count(*) FROM memory_artifact WHERE organization_id=${quoted(organizationId)} AND source_id=${quoted(sourceId)}`
    );
    assert.equal(artifacts, "1");
    conversation = await createConversation();
    await writeFile(
      "/tmp/cerebro-s7-stack.json",
      JSON.stringify(
        {
          ...metrics,
          agentId,
          conversation,
          environment: Object.fromEntries(
            Object.entries(environment).filter(([key]) =>
              key.startsWith("CEREBRO_")
            )
          ),
          organizationId,
          owner,
          ownerPrincipal,
          project,
          support,
          supportPrincipal,
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
  },
  { timeout: 20 * 60_000 }
);

after(async () => {
  metrics.postgresConnections = await sql(
    "SELECT count(*) FROM pg_stat_activity WHERE datname='cerebro'"
  ).catch(() => "unavailable");
  metrics.containerStats = await containerStats();
  await writeFile(
    "/tmp/cerebro-s7-acceptance-metrics.json",
    JSON.stringify(metrics, null, 2)
  );
  if (passed && process.env.CEREBRO_S7_KEEP_STACK !== "1") {
    await docker("down", "--volumes");
  } else {
    process.stdout.write(
      `Pilot stack retained. Project ${project}. API ${apiUrl}. Web ${webUrl}.\n`
    );
  }
});

test("authenticated deployed API uses SDK, real memory, MCP, shared budget, audit and exact event replay", async () => {
  const initialModelCount = await modelCount();
  const initialAccount = await sql(
    `SELECT held || ',' || spent FROM usage_account WHERE organization_id=${quoted(organizationId)}`
  );
  const empty = await read(conversation);
  assert.deepEqual(empty.snapshot.runs, []);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.cursor, "0");
  assert.deepEqual(await read(conversation), empty);
  await waitFor(
    () =>
      sql(
        `SELECT projection_state FROM channel_conversation WHERE conversation_id=${quoted(conversation.conversationId)}`
      ),
    (state) => state === "idle"
  );
  assert.equal(await modelCount(), initialModelCount);
  assert.equal(
    await sql(
      `SELECT held || ',' || spent FROM usage_account WHERE organization_id=${quoted(organizationId)}`
    ),
    initialAccount
  );
  const start = performance.now();
  const sent = await submit(
    conversation,
    "What is the pilot refund support policy?",
    "pilot-first-event"
  );
  metrics.admissionReceiptMs = Math.round(performance.now() - start);
  firstRunId = sent.receipt.runId;
  const view = await completed(conversation, firstRunId, cookie, () => {
    metrics.firstVisibleOutputObservationMs ??= Math.round(
      performance.now() - start
    );
  });
  metrics.answerCompletionMs = Math.round(performance.now() - start);
  assert.equal(
    view.snapshot.runs.find((run) => run.runId === firstRunId)?.state,
    "completed"
  );
  assert.ok(
    view.items.some(
      (item) =>
        item.type === "output" && item.text?.includes("CEREBRO-REAL-MEMORY-731")
    )
  );
  assert.ok(
    view.items.some(
      (item) => item.type === "citation" && item.sourceId === sourceId
    )
  );
  assert.ok(
    view.items.some(
      (item) => item.type === "tool" && item.toolId === "fixture-read"
    )
  );
  const observation = await observe();
  metrics.toolProviderMs = Object.values(observation.tools).map(
    (tool) => tool.completedAt - tool.startedAt
  );
  assert.equal(observation.model.length, 2);
  assert.equal(
    Object.values(observation.tools).reduce(
      (sum, value) => sum + value.count,
      0
    ),
    1
  );
  assert.ok(observation.model.every((model) => model.maxTokens > 0));
  assert.equal(
    new Set(observation.model.map((model) => model.operationId)).size,
    2
  );
  const account = await sql(
    `SELECT held || ',' || spent FROM usage_account WHERE organization_id=${quoted(organizationId)}`
  );
  assert.equal(account, "0,24");
  assert.equal(
    await sql(
      `SELECT count(*) FROM usage_reservation WHERE organization_id=${quoted(organizationId)} AND state='settled'`
    ),
    "2"
  );
  const rowsBefore = await sql(
    `SELECT count(*) FROM cerebro_audit_event WHERE organization_id=${quoted(organizationId)}`
  );
  assert.ok(Number(rowsBefore) >= 4);
  const replay = await submit(
    conversation,
    "What is the pilot refund support policy?",
    "pilot-first-event"
  );
  assert.equal(replay.receipt.runId, firstRunId);
  assert.equal(replay.receipt.replayed, true);
  assert.equal(await modelCount(), 2);
  assert.equal(
    await sql(
      `SELECT held || ',' || spent FROM usage_account WHERE organization_id=${quoted(organizationId)}`
    ),
    "0,24"
  );
  const conflict = await request(
    `/api/product/conversations/${encodeURIComponent(conversation.conversationId)}/messages`,
    { eventId: "pilot-first-event", text: "Changed" }
  );
  assert.equal(conflict.status, 409);
  const source = await json<{ text: string }>(
    `/api/product/conversations/${encodeURIComponent(conversation.conversationId)}/sources/${sourceId}`
  );
  assert.equal(source.text, document);
  const exports = await rpc<{ records: { organizationId: string }[] }>(
    "identity.exportData",
    { kind: "usage", limit: 20, organizationId }
  );
  assert.equal(exports.records.length, 2);
  assert.ok(
    exports.records.every((record) => record.organizationId === organizationId)
  );
  const auditExport = await rpc<{
    records: { eventId: string; organizationId: string; payload: unknown }[];
  }>("identity.exportData", { kind: "audit", limit: 200, organizationId });
  assert.ok(auditExport.records.length >= 4);
  assert.ok(
    auditExport.records.every(
      (record) => record.organizationId === organizationId
    )
  );
  const exported = JSON.stringify(auditExport.records);
  assert.equal(exported.includes("CEREBRO-REAL-MEMORY-731"), false);
  assert.equal(exported.includes("MCP read completed."), false);
  const auditEventId = auditExport.records[0].eventId;
  const projectedRows = await sql(
    `SELECT count(*) FROM cerebro_audit_event WHERE organization_id=${quoted(organizationId)}`
  );
  await json("/api/fixture/audit/replay", { eventId: auditEventId });
  await json("/api/fixture/audit/replay", { eventId: auditEventId });
  assert.equal(
    await sql(
      `SELECT count(*) FROM cerebro_audit_event WHERE organization_id=${quoted(organizationId)}`
    ),
    projectedRows
  );
  const changedAudit = await request("/api/fixture/audit/replay", {
    changed: true,
    eventId: auditEventId,
  });
  assert.equal(changedAudit.status, 409);
  const deniedExport = await request(
    "/rpc/identity/exportData",
    { json: { kind: "usage", limit: 20, organizationId } },
    supportCookie
  );
  assert.equal(deniedExport.status, 403);
});

test("oversized provider context is rejected before dispatch and terminates the run", async () => {
  const count = await modelCount();
  const address = await createConversation();
  const sent = await submit(address, "𐐀".repeat(6000));
  const view = await completed(address, sent.receipt.runId);
  assert.equal(
    view.snapshot.runs.find((run) => run.runId === sent.receipt.runId)?.state,
    "failed"
  );
  assert.equal(await modelCount(), count);
});

test("native restricted loader denies ambient egress and reaches only its named gateway", async () => {
  const isolated = await json<{ deniedAmbientEgress: boolean }>(
    "/api/fixture/runtime/isolation",
    {}
  );
  assert.equal(isolated.deniedAmbientEgress, true);
});

test("approval survives native restart and one controlled write effect completes", async () => {
  const address = await createConversation();
  const sent = await submit(
    address,
    "Run the approval fixture for the pilot refund support policy."
  );
  const waiting = await waitFor(
    () => read(address),
    (view) => view.items.some((item) => item.type === "approval")
  );
  const approval = waiting.items.find((item) => item.type === "approval");
  assert.ok(approval?.approvalId);
  const initialEffects = await effectsObserved();
  assert.equal(
    initialEffects.reduce((sum, value) => sum + value.effects, 0),
    0
  );
  const recoveryStartedAt = performance.now();
  await docker("kill", "-s", "SIGKILL", "celld");
  await docker("up", "-d", "--wait", "celld");
  await waitFor(
    () => fetch(`${apiUrl}/ready`),
    (response) => response.status === 200
  );
  const approved = await json<{ run: { state: string } }>(
    `/api/product/conversations/${encodeURIComponent(address.conversationId)}/approvals/${encodeURIComponent(approval.approvalId)}`,
    { operationId: "pilot-approve" }
  );
  assert.ok(["queued", "running"].includes(approved.run.state));
  const view = await completed(address, sent.receipt.runId);
  assert.equal(
    view.snapshot.runs.find((run) => run.runId === sent.receipt.runId)?.state,
    "completed"
  );
  metrics.approvalRecoveryMs = Math.round(
    performance.now() - recoveryStartedAt
  );
  const effects = await effectsObserved();
  assert.equal(
    effects.reduce((sum, value) => sum + value.effects, 0),
    1
  );
  assert.equal(
    effects.reduce((sum, value) => sum + value.count, 0),
    1
  );
});

test("approval timeout keeps one SDK owner and cancellation cannot affect another run", async () => {
  const address = await createConversation();
  const first = await submit(
    address,
    "Apply write fixture for the pilot refund support policy."
  );
  await waitFor(
    () => read(address),
    (view) => view.items.some((item) => item.type === "approval")
  );
  const countBefore = await modelCount();
  for (let sample = 0; sample < 13; sample += 1) {
    await delay(5000);
    assert.equal(await modelCount(), countBefore);
  }
  const queued = await submit(address, "no tools queued request");
  await delay(1000);
  assert.equal(await modelCount(), countBefore);
  await json(
    `/api/product/conversations/${encodeURIComponent(address.conversationId)}/runs/${encodeURIComponent(queued.receipt.runId)}/cancel`,
    { operationId: "pilot-cancel-queued-owner-test" }
  );
  const waitingOwner = await read(address);
  assert.equal(
    waitingOwner.snapshot.runs.find((run) => run.runId === first.receipt.runId)
      ?.state,
    "waiting-for-approval"
  );
  assert.equal(await modelCount(), countBefore);
  await json(
    `/api/product/conversations/${encodeURIComponent(address.conversationId)}/runs/${encodeURIComponent(first.receipt.runId)}/cancel`,
    { operationId: "pilot-cancel-sdk-owner-test" }
  );
  const next = await submit(address, "no tools replacement owner");
  const result = await completed(address, next.receipt.runId);
  assert.equal(
    result.snapshot.runs.find((run) => run.runId === next.receipt.runId)?.state,
    "completed"
  );
  const observed = await observe();
  const calls = observed.model.slice(countBefore);
  assert.equal(calls.length, 1);
  assert.notEqual(
    calls[0].operationId.split(":model:")[0],
    observed.model[countBefore - 1].operationId.split(":model:")[0]
  );
  const reservations = await sql(
    `SELECT operation_id FROM usage_reservation WHERE operation_id=${quoted(`${calls[0].operationId}:budget:reserve`)}`
  );
  assert.equal(reservations, `${calls[0].operationId}:budget:reserve`);
});

test("lost non-idempotent tool receipt stops recovery without a second effect", async () => {
  const prior = await effectsObserved();
  const count = prior.reduce((sum, entry) => sum + entry.effects, 0);
  await control({ holdTool: true });
  const address = await createConversation();
  const sent = await submit(address, "Apply write fixture once.");
  const waiting = await waitFor(
    () => read(address),
    (view) => view.items.some((item) => item.type === "approval")
  );
  const approval = waiting.items.find((item) => item.type === "approval");
  assert.ok(approval?.approvalId);
  await json(
    `/api/product/conversations/${encodeURIComponent(address.conversationId)}/approvals/${encodeURIComponent(approval.approvalId)}`,
    { operationId: "pilot-ambiguous-approve" }
  );
  await waitFor(
    effectsObserved,
    (entries) =>
      entries.reduce((sum, entry) => sum + entry.effects, 0) === count + 1
  );
  await docker("kill", "-s", "SIGKILL", "celld");
  await control({ holdTool: false, release: true });
  await docker("up", "-d", "--wait", "celld");
  await waitFor(
    () => fetch(`${apiUrl}/ready`),
    (response) => response.status === 200
  );
  const view = await completed(address, sent.receipt.runId);
  assert.equal(
    view.snapshot.runs.find((run) => run.runId === sent.receipt.runId)?.state,
    "unknown-outcome"
  );
  const final = await effectsObserved();
  assert.equal(
    final.reduce((sum, entry) => sum + entry.effects, 0),
    count + 1
  );
});

test("revoked write access blocks an approval before its external effect", async () => {
  const prior = await effectsObserved();
  const count = prior.reduce((sum, entry) => sum + entry.effects, 0);
  const address = await createConversation();
  const sent = await submit(address, "Apply write fixture after approval.");
  const waiting = await waitFor(
    () => read(address),
    (view) => view.items.some((item) => item.type === "approval")
  );
  const approval = waiting.items.find((item) => item.type === "approval");
  assert.ok(approval?.approvalId);
  await sql(
    `DELETE FROM identity_grant WHERE organization_id=${quoted(organizationId)} AND principal_id=${quoted(ownerPrincipal)} AND action='execute' AND resource_kind='tool' AND resource_id='fixture_effect'`
  );
  const denied = await request(
    `/api/product/conversations/${encodeURIComponent(address.conversationId)}/approvals/${encodeURIComponent(approval.approvalId)}`,
    { operationId: "pilot-denied-approve" }
  );
  assert.equal(denied.status, 403);
  const final = await effectsObserved();
  assert.equal(
    final.reduce((sum, entry) => sum + entry.effects, 0),
    count
  );
  await seedGrant(ownerPrincipal, "execute", "tool", "fixture_effect");
  await json(
    `/api/product/conversations/${encodeURIComponent(address.conversationId)}/runs/${encodeURIComponent(sent.receipt.runId)}/cancel`,
    { operationId: "pilot-cancel-denied-approval" }
  );
});

test("shared PostgreSQL account rejects a competing session while a maximum is held", async () => {
  const observationsBefore = await observe();
  const maximum = Number(
    await sql("SELECT maximum FROM usage_reservation ORDER BY id LIMIT 1")
  );
  assert.ok(maximum > 0);
  await sql(
    `UPDATE usage_account SET available=${maximum},total=spent+held+${maximum} WHERE organization_id=${quoted(organizationId)}`
  );
  await control({ holdModel: true });
  const first = await createConversation();
  const second = await createConversation();
  const start = performance.now();
  const accepted = await Promise.all([
    submit(first, "Pilot concurrent A no tools"),
    submit(second, "Pilot concurrent B no tools"),
  ]);
  await waitFor(
    observe,
    (value) => value.model.length === observationsBefore.model.length + 1
  );
  assert.equal(
    await sql(
      `SELECT held || ',' || available FROM usage_account WHERE organization_id=${quoted(organizationId)}`
    ),
    `${maximum},0`
  );
  const samplingStart = performance.now();
  const [loadStats, loadConnections] = await Promise.all([
    containerStats(),
    sql("SELECT count(*) FROM pg_stat_activity WHERE datname='cerebro'"),
  ]);
  metrics.concurrentContainerStats = loadStats;
  metrics.concurrentPostgresConnections = loadConnections;
  metrics.concurrentResourceSamplingMs = Math.round(
    performance.now() - samplingStart
  );
  metrics.concurrentDurationIncludesResourceSampling = true;
  await control({ holdModel: false, release: true });
  const results = await Promise.all([
    completed(first, accepted[0].receipt.runId),
    completed(second, accepted[1].receipt.runId),
  ]);
  const states = results
    .flatMap((view) => view.snapshot.runs.map((run) => run.state))
    .toSorted();
  assert.deepEqual(states, ["completed", "failed"]);
  metrics.concurrentTwoSessionMs = Math.round(performance.now() - start);
  assert.equal(
    await sql(
      `SELECT held FROM usage_account WHERE organization_id=${quoted(organizationId)}`
    ),
    "0"
  );
  await sql(
    `UPDATE usage_account SET available=1000000,total=spent+held+1000000 WHERE organization_id=${quoted(organizationId)}`
  );
});

test("lost model receipt keeps its maximum and never dispatches again after restart", async () => {
  const observationsBefore = await observe();
  await control({ holdModel: true });
  const address = await createConversation();
  const sent = await submit(address, "Pilot ambiguous model result");
  await waitFor(
    observe,
    (value) => value.model.length === observationsBefore.model.length + 1
  );
  const held = await sql(
    `SELECT held FROM usage_account WHERE organization_id=${quoted(organizationId)}`
  );
  assert.ok(Number(held) > 0);
  await docker("kill", "-s", "SIGKILL", "celld");
  await control({ holdModel: false, release: true });
  await docker("up", "-d", "--wait", "celld");
  await waitFor(
    () => fetch(`${apiUrl}/ready`),
    (response) => response.status === 200
  );
  const view = await completed(address, sent.receipt.runId);
  assert.equal(
    view.snapshot.runs.find((run) => run.runId === sent.receipt.runId)?.state,
    "unknown-outcome"
  );
  assert.equal(await modelCount(), observationsBefore.model.length + 1);
  assert.equal(
    await sql(
      `SELECT held FROM usage_account WHERE organization_id=${quoted(organizationId)}`
    ),
    held
  );
});

test("current source, tool and principal revocations deny cached content and resumed history", async () => {
  const observationsBefore = await observe();
  await sql(
    `DELETE FROM identity_grant WHERE organization_id=${quoted(organizationId)} AND principal_id=${quoted(ownerPrincipal)} AND resource_kind='tool' AND resource_id='fixture-read'`
  );
  const deniedTool = await request(
    `/api/product/conversations/${encodeURIComponent(conversation.conversationId)}`
  );
  assert.equal(deniedTool.status, 403);
  assert.equal(await modelCount(), observationsBefore.model.length);
  await seedGrant(ownerPrincipal, "read", "tool", "fixture-read");
  await seedGrant(ownerPrincipal, "execute", "tool", "fixture-read");
  await sql(
    `DELETE FROM identity_grant WHERE organization_id=${quoted(organizationId)} AND principal_id=${quoted(ownerPrincipal)} AND resource_kind='memory' AND resource_id=${quoted(sourceId)}`
  );
  const source = await request(
    `/api/product/conversations/${encodeURIComponent(conversation.conversationId)}/sources/${sourceId}`
  );
  assert.equal(source.status, 403);
  const cached = await request(
    `/api/product/conversations/${encodeURIComponent(conversation.conversationId)}`
  );
  assert.equal(cached.status, 403);
  const followup = await submit(conversation, "Use previous pilot answer");
  await waitFor(
    () =>
      sql(
        `SELECT payload->'run'->>'state' FROM cerebro_audit_event WHERE run_id=${quoted(followup.receipt.runId)} AND name='run' ORDER BY occurred_at DESC LIMIT 1`
      ),
    (state) => state === "failed"
  );
  assert.equal(await modelCount(), observationsBefore.model.length);
  await sql(
    `UPDATE identity_principal SET state='disabled' WHERE id=${quoted(supportPrincipal)}`
  );
  const deniedPrincipal = await request(
    "/api/product/agents",
    undefined,
    supportCookie
  );
  assert.equal(deniedPrincipal.status, 403);
  await seedGrant(ownerPrincipal, "read", "memory", sourceId);
  await seedGrant(ownerPrincipal, "write", "memory", sourceId);
});

test(
  "cold restore preserves auth, source artifacts, ledger replay, audit and accounting",
  async () => {
    metrics.restore = await verifyPilotRestore({
      apiUrl,
      conversationId: conversation.conversationId,
      cookie,
      environment,
      eventId: "pilot-first-event",
      eventText: "What is the pilot refund support policy?",
      project,
      sourceId,
      sourceText: document,
      webUrl,
    });
    passed = true;
  },
  { timeout: 15 * 60_000 }
);
