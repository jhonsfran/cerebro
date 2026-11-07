import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { Schema } from "effect";
import { z } from "zod";

import { ChatSnapshot } from "../../../packages/contracts/src/session-service.ts";
import { SlackPrimaryDecisionSchema } from "../../../packages/contracts/src/slack-events.ts";
import {
  applicationFixture,
  readApplicationBoot,
  stackFiles,
  waitForFixture,
} from "../../slice-1/application.ts";

const metadataPath = process.env.CHANNEL_NATIVE_METADATA;
assert.ok(metadataPath, "Use the owned native channel runner.");
export const metadata = z
  .object({
    agent: z.object({ organizationId: z.string(), principalId: z.string() }),
    bootPath: z.string(),
    owner: z.object({ cookie: z.string() }),
    sourceIdentity: z.string(),
  })
  .parse(JSON.parse(await readFile(metadataPath, "utf-8")));
export const boot = await readApplicationBoot(metadata.bootPath);
export const fixture = applicationFixture(boot);
const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../../..");
export const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
export const docker = (...args: string[]) =>
  execute("rtk", ["proxy", "docker", ...args], {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
  });
export const compose = (...args: string[]) =>
  execute(
    "rtk",
    [
      "proxy",
      "docker",
      "compose",
      "--project-directory",
      root,
      "-p",
      boot.fixtureId,
      ...[...stackFiles, boot.overridePath].flatMap((file) => ["-f", file]),
      ...args,
    ],
    {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 120_000,
      env: {
        ...process.env,
        CEREBRO_API_PORT: new URL(boot.apiUrl).port,
        CEREBRO_WEB_PORT: new URL(boot.webUrl).port,
        CEREBRO_FIXTURE_PORT: new URL(boot.fixtureUrl).port,
        CEREBRO_FIXTURE_ID: boot.fixtureId,
        CEREBRO_FIXTURE_SHA: boot.sha,
        CEREBRO_PUBLIC_API_URL: boot.apiUrl,
        CEREBRO_PUBLIC_WEB_URL: boot.webUrl,
      },
    }
  );
export const ready = () =>
  waitForFixture(
    async () => {
      try {
        const response = await fetch(`${boot.apiUrl}/ready`, {
          signal: AbortSignal.timeout(5000),
        });
        await response.body?.cancel();
        return response.status;
      } catch {
        return 0;
      }
    },
    (status) => status === 200,
    60_000
  );
export const agentWireModel = "slack-coordinator";
export const teamRoles = {
  coordinator: "coordinator",
  lead: "lead",
  worker: "worker",
} as const;
export type TeamRole = (typeof teamRoles)[keyof typeof teamRoles];
export const slack = {
  appId: "native-team-app",
  apiUrl: "http://fixture:8090/slack",
  botToken: "fixture-slack-token",
  signingSecret: "fixture-team-signing-secret",
  workspaceId: "native-team-workspace",
};
export const event = (
  eventId: string,
  text: string,
  timestamp: string,
  thread?: string
) => ({
  api_app_id: slack.appId,
  event_id: eventId,
  team_id: slack.workspaceId,
  type: "event_callback",
  event: {
    type: "message",
    channel: "D-native-team",
    channel_type: "im",
    user: "native-team-user",
    text,
    ts: timestamp,
    ...(thread ? { thread_ts: thread } : {}),
  },
});
export const signedCallback = async (
  payload: unknown,
  options: {
    retry?: boolean;
    timestamp?: string;
    invalidSignature?: boolean;
  } = {}
) => {
  const body = JSON.stringify(payload);
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(slack.signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`v0:${timestamp}:${body}`)
    )
  );
  return await fetch(`${boot.apiUrl}/api/channels/slack/events`, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(30_000),
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": options.invalidSignature
        ? "v0=invalid"
        : `v0=${Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
      ...(options.retry ? { "x-slack-retry-num": "1" } : {}),
    },
  });
};
export const send = async (payload: unknown, retry = false) => {
  const response = await signedCallback(payload, { retry });
  assert.equal(response.status, 200, await response.clone().text());
  await response.body?.cancel();
};
export const observed = async () =>
  z
    .object({
      held: z.number(),
      model: z.array(
        z.object({
          model: z.string(),
          digest: z.string(),
          operationId: z.string(),
          role: z.enum(["coordinator", "lead", "worker"]).nullable(),
          startedAt: z.number(),
          completedAt: z.number().optional(),
          toolNames: z.array(z.string()),
          messageTextDigests: z.array(z.string()),
          status: z.number().optional(),
        })
      ),
      slack: z.object({
        calls: z.array(
          z.object({
            method: z.string(),
            request: z.record(z.string(), z.unknown()),
            response: z.unknown().optional(),
            status: z.number().optional(),
          })
        ),
        messages: z.array(
          z.object({
            text: z.string(),
            channel: z.string(),
            threadTs: z.string().optional(),
            ts: z.string(),
          })
        ),
      }),
    })
    .parse(await fixture.observations());
export type Observation = Awaited<ReturnType<typeof observed>>;
export const completedCalls = (value: Observation, role: TeamRole) =>
  value.model.filter(
    (call) => call.role === role && call.completedAt !== undefined
  );
export const hasReply = (value: Observation, thread: string, text: string) =>
  value.slack.messages.some(
    (message) =>
      message.channel === "D-native-team" &&
      message.threadTs === thread &&
      message.text === text
  );
export const externalEventKey = (eventId: string) =>
  `slack:${metadata.agent.organizationId}:${slack.appId}:${slack.workspaceId}:${eventId}`;
export const primaryDecision = async (eventId: string) => {
  const eventKey = externalEventKey(eventId);
  const row = await waitForFixture(
    () =>
      fixture.sql(
        `SELECT json_build_object('eventKey',event_key,'digest',digest,'decision',decision) FROM channel_slack_event_receipt WHERE event_key=${literal(eventKey)}`
      ),
    (value) => value.length > 0,
    60_000
  );
  const saved = z
    .object({ eventKey: z.string(), digest: z.string(), decision: z.unknown() })
    .parse(JSON.parse(row));
  const decision = Schema.decodeUnknownSync(SlackPrimaryDecisionSchema, {
    onExcessProperty: "error",
  })(saved.decision);
  assert.equal(saved.eventKey, eventKey);
  assert.equal(decision.authority.eventId, eventId);
  assert.equal(decision.ownerPrincipalId, metadata.agent.principalId);
  return { ...saved, decision };
};
export const snapshot = async (eventId: string, agentId: string) => {
  const saved = await primaryDecision(eventId);
  const targets = saved.decision.targets.filter(
    (target) => target.agentId === agentId
  );
  assert.equal(targets.length, 1);
  const [target] = targets;
  assert.ok(target);
  const { conversationId } = target;
  const value = await fixture.json(
    `/api/product/conversations/${encodeURIComponent(conversationId)}`,
    metadata.owner.cookie,
    z.object({
      snapshot: z
        .unknown()
        .transform((input) => Schema.decodeUnknownSync(ChatSnapshot)(input)),
    })
  );
  assert.deepEqual(value.snapshot.address, target);
  return { ...value, conversationId, target, saved };
};
export const evidence = (name: string, value: unknown) =>
  writeFile(
    path.join(path.dirname(metadataPath), `${name}.json`),
    `${JSON.stringify({ sourceIdentity: metadata.sourceIdentity, at: Date.now(), value }, null, 2)}\n`
  );
export const queue = async (
  operation: string,
  name: string,
  limit?: number
): Promise<unknown> =>
  await waitForFixture(
    async () => {
      try {
        const output = await docker(
          "exec",
          await fixture.container("celld"),
          "node",
          "/app/deploy/queues.mjs",
          operation,
          name,
          ...(limit === undefined ? [] : ["--limit", String(limit)])
        );
        return JSON.parse(output.stdout);
      } catch (error) {
        if (
          (operation === "info" || operation === "peek") &&
          error instanceof Error &&
          error.message.includes("409 Conflict") &&
          error.message.includes(
            "peer request targets a different node session"
          )
        ) {
          return;
        }
        throw error;
      }
    },
    (value) => value !== undefined,
    30_000
  );
export const drained = (name: string) =>
  waitForFixture(
    async () => {
      await delay(100);
      return z
        .object({ stored: z.number(), backlogCount: z.number() })
        .parse(await queue("info", name));
    },
    (value) => value.stored === 0 && value.backlogCount === 0,
    30_000
  );
export const controlQueue = (
  operation: "pause" | "resume",
  name:
    | "cerebro-team-reports"
    | "cerebro-team-commands"
    | "cerebro-slack-events" = "cerebro-team-reports"
) =>
  waitForFixture(
    async () => {
      try {
        const output = await docker(
          "exec",
          await fixture.container("celld"),
          "node",
          "--input-type=module",
          "-e",
          `
    import { readFile } from 'node:fs/promises';
    import { spawnSync } from 'node:child_process';
    const password = (await readFile('/run/cerebro-secrets/minio-password','utf8')).trim();
    const result = spawnSync('celld', ['queue',process.argv[1],process.argv[2],'--bucket','s3://cerebro-runtime','--endpoint','http://minio-runtime:9000','--region','us-east-1','--json'], { encoding:'utf8', timeout:30000, env:{...process.env,AWS_ACCESS_KEY_ID:'cerebro',AWS_SECRET_ACCESS_KEY:password,AWS_SESSION_TOKEN:undefined} });
    const redact = (text) => text.replaceAll(JSON.stringify(password).slice(1,-1),'[secret removed]').replaceAll(password,'[secret removed]');
    process.stdout.write(redact(result.stdout ?? ''));
    process.stderr.write(redact(result.stderr ?? ''));
    process.exitCode = result.error || result.signal ? 1 : result.status ?? 1;
  `,
          operation,
          name
        );
        return JSON.parse(output.stdout);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("409 Conflict") &&
          error.message.includes(
            "peer request targets a different node session"
          )
        ) {
          return;
        }
        throw error;
      }
    },
    (value) => value !== undefined,
    30_000
  );
export const selectSlackAgent = async (agentId: string) => {
  await compose(
    "run",
    "--no-deps",
    "--rm",
    "test-config",
    "node",
    "--input-type=module",
    "-e",
    "import {writeFile} from 'node:fs/promises'; await writeFile('/run/cerebro-secrets/channels.json',process.argv[1],{mode:0o600});",
    JSON.stringify({
      organizationId: metadata.agent.organizationId,
      slack: { ...slack, agentId },
    })
  );
  await compose("run", "--no-deps", "--rm", "bootstrap");
  await compose("restart", "celld");
  await ready();
  await waitForFixture(
    async () => {
      try {
        await send({
          type: "url_verification",
          challenge: "team-ready",
          api_app_id: slack.appId,
          team_id: slack.workspaceId,
        });
        return true;
      } catch {
        return false;
      }
    },
    (value) => value,
    60_000
  );
};
export const coordinatorDefinition = () => ({
  name: "Slack coordinator",
  model: `fixture/${agentWireModel}`,
  instructions: "Use the supplied sources and bounded team tools.",
  enabledToolIds: ["fixture-read"],
  grants: [
    ["read", "memory", "pilot-source"],
    ["read", "tool", "fixture-read"],
    ["execute", "tool", "fixture-read"],
    ["execute", "tool", "fixture-connector"],
  ].map(([action, kind, id]) => ({
    action,
    resource: {
      id,
      kind,
      organizationId: metadata.agent.organizationId,
    },
  })),
});
export const configure = async (options: { link?: boolean } = {}) => {
  await fixture.container("fixture");
  const coordinator = await fixture.json(
    "/api/product/agents",
    metadata.owner.cookie,
    z.object({ agentId: z.string(), version: z.number() }),
    { operationId: crypto.randomUUID(), ...coordinatorDefinition() }
  );
  await selectSlackAgent(coordinator.agentId);
  const linkedPrincipal = await fixture.sql(
    `SELECT principal_id FROM identity_slack_link WHERE workspace_id=${literal(slack.workspaceId)} AND slack_user_id='native-team-user'`
  );
  if (options.link === false) {
    assert.equal(linkedPrincipal, "");
  } else if (linkedPrincipal) {
    assert.equal(linkedPrincipal, metadata.agent.principalId);
  } else {
    const link = await fixture.json(
      "/rpc/identity/beginSlackLink",
      metadata.owner.cookie,
      z.object({ json: z.object({ code: z.string() }) }),
      { json: { organizationId: metadata.agent.organizationId } }
    );
    await send(
      event("team-link", `link ${link.json.code}`, "1800000100.000001")
    );
    await waitForFixture(
      () =>
        fixture.sql(
          `SELECT count(*) FROM identity_slack_link WHERE workspace_id=${literal(slack.workspaceId)}`
        ),
      (count) => count === "1"
    );
  }
  await fixture.controls({
    arm: null,
    delayMs: 0,
    failFirst: false,
    release: true,
    models: {},
  });
  return { coordinator };
};
