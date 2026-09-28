import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const baseURL = process.env.BASE_URL ?? "http://celld:8080";
const origin = "http://localhost:18765";
const request = async (path, options = {}) => {
  const response = await fetch(`${baseURL}${path}`, {
    ...options,
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json();
  assert.equal(response.status, 200, "Restart probe request failed");
  return { body, response };
};
const statePath = "/results/restart-state.json";
if (process.argv[2] === "prepare") {
  const email = `restart-${crypto.randomUUID()}@example.test`;
  const { response, body } = await request("/api/auth/sign-up/email", {
    body: JSON.stringify({
      email,
      name: "Restart fixture",
      password: "local-only-test-password",
    }),
    headers: { "Content-Type": "application/json", Origin: origin },
    method: "POST",
  });
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  assert.ok(cookie);
  const database = await request("/database");
  const conversation = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const prompt = await request(`/sessions/${conversation}/prompt`, {
    body: JSON.stringify({ operationId }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(prompt.body.ok, true);
  assert.equal(prompt.body.toolCalls, 1);
  assert.equal(prompt.body.reply, "Cerebro fixture completed.");
  const session = await request(`/sessions/${conversation}/inspect`);
  assert.equal(session.body.sessionId, prompt.body.sessionId);
  await mkdir("/results", { recursive: true });
  await writeFile(
    statePath,
    JSON.stringify({
      agentResult: prompt.body,
      conversation,
      cookie,
      database: database.body,
      messages: session.body.messages,
      operationId,
      userId: body.user.id,
    }),
    { mode: 0o600 }
  );
  process.stdout.write(
    "Restart markers saved. Restart the experiment services with volumes preserved.\n"
  );
} else if (process.argv[2] === "verify") {
  const state = JSON.parse(await readFile(statePath, "utf-8"));
  const session = await request("/private", {
    headers: { Cookie: state.cookie },
  });
  assert.equal(session.body.user.id, state.userId);
  const row = await request(
    `/database/read?key=${state.database.committedKey}`
  );
  assert.equal(row.body.row.value, state.database.value);
  const rollback = await request(
    `/database/read?key=${state.database.rolledBackKey}`
  );
  assert.equal(rollback.body.row, null);
  const agent = await request(`/sessions/${state.conversation}/inspect`);
  assert.equal(agent.body.sessionId, state.agentResult.sessionId);
  assert.deepEqual(agent.body.messages, state.messages);
  const repeated = await request(`/sessions/${state.conversation}/prompt`, {
    body: JSON.stringify({ operationId: state.operationId }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.deepEqual(repeated.body, state.agentResult);
  const afterReplay = await request(`/sessions/${state.conversation}/inspect`);
  assert.deepEqual(afterReplay.body.messages, state.messages);
  const evidence = {
    agentMessagesPreserved: true,
    agentSessionPreserved: true,
    authSessionPreserved: true,
    committedKey: state.database.committedKey,
    committedRowPreserved: true,
    completedOperationReused: true,
    replayAddedNoMessages: true,
    rollbackAbsent: true,
    sessionId: state.agentResult.sessionId,
    timestamp: new Date().toISOString(),
    userId: state.userId,
  };
  await writeFile(
    "/results/restart-evidence.json",
    `${JSON.stringify(evidence, null, 2)}\n`
  );
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} else {
  throw new Error("Use prepare or verify");
}
