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
  assert.equal(response.status, 200, JSON.stringify(body));
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
  await mkdir("/results", { recursive: true });
  await writeFile(
    statePath,
    JSON.stringify({ cookie, database: database.body, userId: body.user.id }),
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
  const evidence = {
    authSessionPreserved: true,
    committedKey: state.database.committedKey,
    committedRowPreserved: true,
    rollbackAbsent: true,
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
