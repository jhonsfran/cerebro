/* oxlint-disable no-await-in-loop -- Poll the deployed session until its durable output is projected. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const freePort = async (): Promise<number> => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  server.close();
  await once(server, "close");
  return address.port;
};
interface View {
  items: { type: string; text?: string; runId?: string }[];
  snapshot: { runs: { runId: string; state: string }[] };
}

test(
  "native OpenCode free model completes with a durable zero-cost usage receipt",
  { timeout: 900_000 },
  async () => {
    const project = `cerebro-opencode-${randomBytes(4).toString("hex")}`;
    const model = "opencode/space-bunny-free";
    assert.ok(["opencode/space-bunny-free"].includes(model));
    const [apiPort, webPort] = await Promise.all([freePort(), freePort()]);
    const apiUrl = `http://localhost:${apiPort}`;
    const webUrl = `http://localhost:${webPort}`;
    const environment = {
      ...process.env,
      CEREBRO_API_PORT: String(apiPort),
      CEREBRO_DEPLOY_MODE: "local",
      CEREBRO_PUBLIC_API_URL: apiUrl,
      CEREBRO_PUBLIC_WEB_URL: webUrl,
      CEREBRO_WEB_PORT: String(webPort),
      COMPOSE_PROFILES: "",
    };
    const docker = async (...args: string[]) =>
      await exec("docker", ["compose", "-p", project, ...args], {
        env: environment,
        maxBuffer: 12 * 1024 * 1024,
        timeout: 720_000,
      });
    let cookie = "";
    const request = async (path: string, body?: unknown): Promise<Response> =>
      await fetch(`${apiUrl}${path}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: webUrl,
        },
        method: body === undefined ? "GET" : "POST",
      });
    const json = async <Value>(
      path: string,
      body?: unknown
    ): Promise<Value> => {
      const response = await request(path, body);
      const value = await response.json();
      assert.ok(response.ok, `${response.status} ${JSON.stringify(value)}`);
      return value as Value;
    };
    let passed = false;
    try {
      await docker("up", "--build", "-d", "--wait");
      const ready = await fetch(`${apiUrl}/ready`);
      assert.equal(ready.status, 200);
      const fixture = await fetch(`${apiUrl}/fixture/sessions/disabled`);
      assert.equal(fixture.status, 404);
      const services = await docker("ps", "--services");
      assert.ok(!services.stdout.split("\n").includes("fixture"));
      const signup = await request("/api/auth/sign-up/email", {
        email: `live-${randomBytes(8).toString("hex")}@example.test`,
        name: "Free model check",
        password: randomBytes(24).toString("base64url"),
      });
      assert.equal(signup.status, 200);
      cookie = signup.headers
        .getSetCookie()
        .map((entry) => entry.split(";")[0])
        .join("; ");
      const untrusted = await request("/api/product/setup", {
        operationId: "untrusted",
      });
      assert.equal(untrusted.status, 403);
      const token = await docker(
        "run",
        "--rm",
        "--no-deps",
        "bootstrap",
        "node",
        "--input-type=module",
        "-e",
        'import {readFile} from "node:fs/promises";process.stdout.write(await readFile("/run/cerebro-secrets/bootstrap-token","utf8"))'
      );
      const setup = await json<{ mode: string; owner: boolean }>(
        "/api/product/setup",
        { bootstrapToken: token.stdout.trim(), operationId: "trusted" }
      );
      assert.equal(setup.mode, "local");
      assert.equal(setup.owner, true);
      const catalog = await json<{
        modelChoices: { id: string }[];
        connectorChoices: unknown[];
        sourceChoices: unknown[];
      }>("/api/product/catalog");
      assert.deepEqual(
        catalog.modelChoices.map(({ id }) => id),
        ["opencode/space-bunny-free"]
      );
      assert.deepEqual(catalog.connectorChoices, []);
      assert.deepEqual(catalog.sourceChoices, []);
      const agent = await json<{ agentId: string }>("/api/product/agents", {
        enabledToolIds: [],
        grants: [],
        instructions:
          "Reply exactly CEREBRO_OPENCODE_LIVE_OK. No tools are available.",
        model,
        name: "Free OpenCode",
        operationId: "publish",
      });
      const conversation = await json<{ conversationId: string }>(
        "/api/product/conversations",
        { agentId: agent.agentId, operationId: "conversation" }
      );
      const path = `/api/product/conversations/${encodeURIComponent(conversation.conversationId)}`;
      const sent = await json<{ receipt: { runId: string } }>(
        `${path}/messages`,
        {
          eventId: "live-message",
          text: "Reply exactly CEREBRO_OPENCODE_LIVE_OK.",
        }
      );
      const deadline = Date.now() + 150_000;
      let view: View | undefined;
      while (Date.now() < deadline) {
        view = await json<View>(path);
        const run = view.snapshot.runs.find(
          ({ runId }) => runId === sent.receipt.runId
        );
        const terminal =
          run && ["completed", "failed", "unknown-outcome"].includes(run.state);
        const outputProjected = view.items.some(
          (item) => item.type === "output" && item.runId === run?.runId
        );
        if (terminal && (run.state !== "completed" || outputProjected)) {
          break;
        }
        await delay(500);
      }
      assert.equal(
        view?.snapshot.runs.find(({ runId }) => runId === sent.receipt.runId)
          ?.state,
        "completed",
        JSON.stringify(view)
      );
      assert.ok(
        view?.items.some(
          (item) =>
            item.type === "output" &&
            item.text?.includes("CEREBRO_OPENCODE_LIVE_OK")
        ),
        JSON.stringify(view)
      );
      const receipt = await docker(
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "cerebro",
        "-d",
        "cerebro",
        "-At",
        "-c",
        "SELECT count(*), coalesce(sum(incurred),0) FROM usage_reservation WHERE unit='usd-micro' AND state='settled'"
      );
      assert.equal(receipt.stdout.trim(), "1|0");
      process.stdout.write(
        `Live model completed through the native SDK with one zero-cost receipt in ${project}.\n`
      );
      passed = true;
    } finally {
      if (passed) {
        await docker("down", "--volumes");
      } else {
        process.stderr.write(
          `Live OpenCode check retained in ${project}; external access or native execution did not pass.\n`
        );
      }
    }
  }
);
