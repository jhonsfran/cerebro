import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

import postgres from "postgres";

const baseURL = process.env.BASE_URL ?? "http://localhost:18765";
const origin = "http://localhost:18765";
const results = [];
const schemaConflict = "Database is not empty and has no session table";
const sql = postgres(process.env.DATABASE_URL, { connect_timeout: 5, max: 1 });
const request = async (path, options = {}) => {
  const response = await fetch(`${baseURL}${path}`, {
    ...options,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { body, response };
};
const check = async (id, run) => {
  const start = performance.now();
  try {
    const evidence = await run();
    results.push({
      durationMs: Math.round(performance.now() - start),
      evidence,
      id,
      status: "pass",
    });
    return evidence;
  } catch (error) {
    results.push({
      durationMs: Math.round(performance.now() - start),
      error:
        error.message === schemaConflict
          ? schemaConflict
          : "Probe failed; response bodies omitted",
      id,
      status: "fail",
    });
    return null;
  }
};
const pending = (id, reason) => results.push({ id, reason, status: "not-run" });
await check("api.health", async () => {
  const { response, body } = await request("/health");
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  return { status: response.status };
});
const database = await check("database.transactions", async () => {
  const { response, body } = await request("/database");
  assert.equal(response.status, 200);
  const rows =
    await sql`select key, value from slice_probe where key in (${body.committedKey}, ${body.rolledBackKey})`;
  assert.deepEqual([...rows], [{ key: body.committedKey, value: body.value }]);
  return body;
});
const readAfterIdle = async (probe) => {
  await setTimeout(1500);
  const { response, body } = await request(
    `/database/read?key=${probe.committedKey}`
  );
  assert.equal(response.status, 200);
  assert.equal(body.row.value, probe.value);
};

if (database) {
  await check("database.event-lifetime", async () => {
    await readAfterIdle(database);
    await readAfterIdle(database);
    await readAfterIdle(database);
    return { idleMs: 1500, requests: 3 };
  });
} else {
  pending("database.event-lifetime", "The Worker transaction probe failed");
}
await check("auth.cors", async () => {
  const { response } = await request("/api/auth/sign-in/email", {
    headers: {
      "Access-Control-Request-Headers": "content-type",
      "Access-Control-Request-Method": "POST",
      Origin: origin,
    },
    method: "OPTIONS",
  });
  assert.equal(response.status, 204);
  assert.ok(
    response.headers
      .get("access-control-allow-methods")
      ?.split(",")
      .map((value) => value.trim())
      .includes("POST")
  );
  assert.ok(
    response.headers
      .get("access-control-allow-headers")
      ?.toLowerCase()
      .split(",")
      .map((value) => value.trim())
      .includes("content-type")
  );
  assert.equal(response.headers.get("access-control-allow-origin"), origin);
  assert.equal(
    response.headers.get("access-control-allow-credentials"),
    "true"
  );
  return {
    credentials: true,
    header: "content-type",
    method: "POST",
    origin,
    status: response.status,
  };
});
await check("auth.untrusted-origin", async () => {
  const { response } = await request("/api/auth/sign-up/email", {
    body: JSON.stringify({
      email: "denied@example.test",
      name: "Denied",
      password: "local-only-test-password",
    }),
    headers: {
      "Content-Type": "application/json",
      Origin: "https://untrusted.invalid",
    },
    method: "POST",
  });
  assert.equal(response.status, 403);
  return { status: response.status };
});
const email = `slice-${crypto.randomUUID()}@example.test`;
const password = "local-only-test-password";
const auth = await check("auth.signup", async () => {
  const { response, body } = await request("/api/auth/sign-up/email", {
    body: JSON.stringify({ email, name: "Slice", password }),
    headers: { "Content-Type": "application/json", Origin: origin },
    method: "POST",
  });
  assert.equal(response.status, 200);
  assert.equal(body.user.email, email);
  return { userId: body.user.id };
});
if (auth) {
  await check("auth.session-lifecycle", async () => {
    const login = await request("/api/auth/sign-in/email", {
      body: JSON.stringify({ email, password }),
      headers: { "Content-Type": "application/json", Origin: origin },
      method: "POST",
    });
    assert.equal(login.response.status, 200);
    const cookie = login.response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    assert.ok(cookie);
    const session = await request("/private", {
      headers: { Cookie: cookie, Origin: origin },
    });
    assert.equal(session.response.status, 200);
    assert.equal(session.body.user.id, auth.userId);
    const logout = await request("/api/auth/sign-out", {
      body: "{}",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        Origin: origin,
      },
      method: "POST",
    });
    assert.equal(logout.response.status, 200);
    const stale = await request("/private", { headers: { Cookie: cookie } });
    assert.equal(stale.response.status, 401);
    return { oldCookieStatus: stale.response.status, signedIn: true };
  });
  await check("auth.invalid-credentials", async () => {
    const { response } = await request("/api/auth/sign-in/email", {
      body: JSON.stringify({ email, password: "incorrect-password" }),
      headers: { "Content-Type": "application/json", Origin: origin },
      method: "POST",
    });
    assert.equal(response.status, 401);
    return { status: response.status };
  });
} else {
  pending("auth.session-lifecycle", "User creation failed");
  pending("auth.invalid-credentials", "User creation failed");
}
const conversation = crypto.randomUUID();
await check("agent.base-storage", async () => {
  const { response, body } = await request(`/sessions/${conversation}/storage`);
  assert.equal(response.status, 200);
  assert.ok(body.tables.some((table) => table.name.startsWith("cf_agents_")));
  assert.ok(!body.tables.some((table) => table.name.startsWith("cerebro_")));
  return { conversation, tables: body.tables };
});
await check("agent.opencode-empty-storage-control", async () => {
  const { response, body } = await request(
    `/control/opencode/${crypto.randomUUID()}`
  );
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  return body;
});
await Promise.all(
  ["unknown", "partial", "similar-agent-prefix", "similar-cerebro-prefix"].map(
    (schema) =>
      check(`migration.rejects-${schema}`, async () => {
        const { response, body } = await request(
          `/control/opencode/${crypto.randomUUID()}?schema=${schema}`
        );
        assert.equal(response.status, 500);
        assert.equal(body.error, schemaConflict);
        assert.ok(
          !body.tablesAfter.some(
            (table) => table.name === "session_v2" || table.name === "migration"
          )
        );
        return {
          error: body.error,
          status: response.status,
          tablesAfter: body.tablesAfter,
        };
      })
  )
);
await check("agent.durable-sqlite", async () => {
  const name = crypto.randomUUID();
  const prepared = await request(`/sessions/${name}/seed-ledger`, {
    method: "POST",
  });
  assert.equal(prepared.response.status, 200);
  const before = await request(`/sessions/${name}/storage`);
  assert.equal(before.response.status, 200);
  assert.deepEqual(before.body.ledgerProbe, {
    id: "schema-fixture",
    result: "preserved",
  });
  const initialized = await request(`/sessions/${name}/inspect`);
  if (initialized.body.error === schemaConflict) {
    throw new Error(schemaConflict);
  }
  assert.equal(initialized.response.status, 200);
  const after = await request(`/sessions/${name}/storage`);
  assert.equal(after.response.status, 200);
  assert.deepEqual(after.body.ledgerProbe, before.body.ledgerProbe);
  assert.ok(
    before.body.tables.every((table) =>
      after.body.tables.some((entry) => entry.name === table.name)
    )
  );
  assert.ok(after.body.tables.some((table) => table.name === "session_v2"));
  return {
    existingTablesPreserved: true,
    ledgerProbe: after.body.ledgerProbe,
    name,
    sessionId: initialized.body.sessionId,
  };
});
const agent = await check("agent.composition", async () => {
  const { response, body } = await request(`/sessions/${conversation}/inspect`);
  if (body.error === schemaConflict) {
    throw new Error(schemaConflict);
  }
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.ok(body.sessionId);
  const repeated = await request(`/sessions/${conversation}/inspect`);
  assert.equal(repeated.body.sessionId, body.sessionId);
  return { conversation, model: body.model, sessionId: body.sessionId };
});
if (agent) {
  await check("agent.fixture-loop", async () => {
    const { response, body } = await request(
      `/sessions/${conversation}/prompt`,
      {
        body: JSON.stringify({ operationId: crypto.randomUUID() }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }
    );
    assert.equal(response.status, 200);
    assert.equal(body.toolCalls, 1);
    assert.equal(body.reply, "Cerebro fixture completed.");
    return body;
  });
  await check("agent.isolation", async () => {
    const { response, body } = await request(
      `/sessions/${crypto.randomUUID()}/inspect`
    );
    assert.equal(response.status, 200);
    assert.notEqual(body.sessionId, agent.sessionId);
    assert.deepEqual(body.messages, []);
    return { messages: 0, separateSessionId: body.sessionId };
  });
} else {
  pending("agent.fixture-loop", "Agent composition failed");
  pending("agent.isolation", "Agent composition failed");
}
await check("tools.egress", async () => {
  const { response, body } = await request("/tools/isolation");
  assert.equal(response.status, 200);
  assert.equal(body.fixtureReachable, true);
  assert.equal(body.workerStatus, 200);
  assert.equal(body.observations.direct.denied, true);
  assert.match(
    body.observations.direct.error,
    /not permitted to access the internet/u
  );
  assert.equal(body.observations.capability.status, 200);
  assert.deepEqual(body.observations.capability.body, {
    capability: true,
    ok: true,
  });
  return body;
});
for (const id of [
  "database.tls-verified",
  "database.private-ca",
  "database.restart",
  "auth.restart",
  "auth.browser",
  "agent.reconnect",
  "agent.real-provider",
  "tools.broker",
  "tools.secrets",
  "tools.approval",
  "tools.replay",
  "recovery.before-model",
  "recovery.approval",
  "recovery.idempotent-effect",
  "recovery.unknown-effect",
  "recovery.completed",
  "recovery.wakeup",
  "recovery.postgres-outage",
  "recovery.minio-outage",
  "baseline.one-session",
  "baseline.ten-sessions",
  "deployment.clean-rebuild",
]) {
  pending(id, "This stage has not produced runtime evidence");
}
await sql.end();
let gate = "incomplete";
if (results.some((result) => result.status === "fail")) {
  gate = "fail";
} else if (results.every((result) => result.status === "pass")) {
  gate = "pass";
}
const report = {
  gate,
  results,
  runtime: "celld 0.6.0",
  timestamp: new Date().toISOString(),
};
await mkdir("/results", { recursive: true });
await writeFile(
  `/results/check-${Date.now()}.json`,
  `${JSON.stringify(report, null, 2)}\n`
);
process.stdout.write(
  `${JSON.stringify({ gate: report.gate, results: results.map(({ id, status, error }) => ({ error, id, status })) }, null, 2)}\n`
);
process.exitCode = report.gate === "pass" ? 0 : 1;
