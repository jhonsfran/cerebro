import { Schema } from "effect";
import { z } from "zod";

import { createProductHandler } from "../../packages/api/src/routers/conversations";
import { ChannelError } from "../../packages/channels/src/types";
import type {
  ProductHandlerOptions,
  SlackConfiguration,
} from "../../packages/channels/src/types";
import type { EventAddress } from "../../packages/contracts/src/events";
import { DomainSnapshot } from "../../packages/contracts/src/session-service";
import { sql } from "../../packages/db/node_modules/drizzle-orm";
import { withDatabase } from "../../packages/db/src/index";
import { user } from "../../packages/db/src/schema/auth";
import { identityGrant } from "../../packages/db/src/schema/identity";
import {
  createFixtureSessionService,
  FIXTURE_MODEL_ID,
  FIXTURE_SOURCE_ID,
  FIXTURE_TOOL_ID,
  fixtureRun,
  resetFixtureSessions,
} from "./fixture-session";

export const TEST_BOOTSTRAP_TOKEN = "channel-test-bootstrap-token-0123456789";

export const object = (value: unknown): Record<string, unknown> =>
  z.record(z.string(), z.unknown()).parse(value);
export const string = (value: unknown): string => z.string().parse(value);
export const array = (value: unknown): unknown[] =>
  z.array(z.unknown()).parse(value);
export const createTestProduct = async (
  slack?: SlackConfiguration,
  fetch?: typeof globalThis.fetch
) => {
  const databaseUrl = process.env.CHANNEL_TEST_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "CHANNEL_TEST_DATABASE_URL is required. Run pnpm test:channels to start an isolated PostgreSQL fixture."
    );
  }
  const database: ProductHandlerOptions["withDatabase"] = (run) =>
    withDatabase({ DATABASE_URL: databaseUrl }, run);
  const options: ProductHandlerOptions = {
    bootstrapToken: TEST_BOOTSTRAP_TOKEN,
    catalog: {
      connectorChoices: [{ id: FIXTURE_TOOL_ID, label: "Local pilot source" }],
      modelChoices: [
        { id: FIXTURE_MODEL_ID, label: "Deterministic test model" },
      ],
    },
    checkContentDependencies: () =>
      Promise.resolve({ status: "ok", value: undefined }),
    fetch,
    getUser: (request) =>
      Promise.resolve(
        request.headers.get("x-test-user")
          ? { id: request.headers.get("x-test-user") ?? "" }
          : null
      ),
    mode: "local",
    organizationId: "channel-test-company",
    readAudit: (_database, _context, input) => {
      const run = fixtureRun(input.conversationId, input.runId);
      if (!run) {
        throw new ChannelError(404, "not-found", "The run was not found.");
      }
      let endedAt = run.envelope.occurredAt;
      if (run.state.state === "completed") {
        endedAt = run.state.completedAt;
      } else if ("endedAt" in run.state) {
        ({ endedAt } = run.state);
      }
      return Promise.resolve({
        status: "ok",
        value: {
          entries: [
            {
              at: run.envelope.occurredAt,
              description: "The stable conversation event was accepted.",
              type: "admission",
            },
            {
              at: endedAt,
              description: `The run state is ${run.state.state}.`,
              type: "state",
            },
          ],
          runId: input.runId,
          state: run.state.state,
        },
      });
    },
    readSource: (_database, _context, input) =>
      Promise.resolve(
        input.sourceId === FIXTURE_SOURCE_ID
          ? {
              status: "ok",
              value: {
                sourceId: input.sourceId,
                sourceVersion: "1",
                text: "Cerebro admits each conversation event with a stable ID. Current permissions apply to every read and action.",
                title: "Local pilot source",
              },
            }
          : { resource: "source", status: "not-found" }
      ),
    sessions: (db) => createFixtureSessionService(db, options),
    slack,
    withDatabase: database,
  };
  resetFixtureSessions();
  await options.withDatabase(async (db) => {
    await db.execute(
      sql`truncate installation_setup, agent, agent_version, agent_publish_operation, channel_conversation, channel_item, channel_effect, channel_reply, channel_link_event, identity_principal, identity_grant, identity_policy_revision, identity_slack_link, identity_slack_link_challenge restart identity cascade`
    );
    await db
      .insert(user)
      .values(
        ["test-owner", "test-other"].map((id) => ({
          createdAt: new Date(),
          email: `${id}@example.test`,
          emailVerified: false,
          id,
          name: id,
          updatedAt: new Date(),
        }))
      )
      .onConflictDoNothing();
  });
  const handler = createProductHandler(options);
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    userId: string | null = "test-owner",
    headers?: Record<string, string>
  ) =>
    handler(
      new Request(`http://cerebro.test${path}`, {
        ...(method !== "GET" && body !== undefined
          ? { body: JSON.stringify(body) }
          : {}),
        headers: {
          ...(userId ? { "x-test-user": userId } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        method,
      })
    );
  // The owner receives the test tool and source grants that an operator
  // would configure for real connectors.
  const install = async () => {
    const response = await request("/api/product/setup", "POST", {
      bootstrapToken: TEST_BOOTSTRAP_TOKEN,
      operationId: "install-1",
    });
    if (response.status !== 200) {
      throw new Error(await response.text());
    }
    const setup = object(await response.json());
    const principalId = string(setup.principalId);
    await options.withDatabase((db) =>
      db
        .insert(identityGrant)
        .values(
          (
            [
              ["read", "tool", FIXTURE_TOOL_ID],
              ["execute", "tool", FIXTURE_TOOL_ID],
              ["read", "memory", FIXTURE_SOURCE_ID],
            ] as const
          ).map(([action, resourceKind, resourceId]) => ({
            action,
            organizationId: options.organizationId,
            principalId,
            resourceId,
            resourceKind,
            source: "test-fixture",
          }))
        )
        .onConflictDoNothing()
    );
    return setup;
  };
  const agentBody = {
    enabledToolIds: ["fixture-read"],
    grants: [],
    instructions: "Use the pilot source.",
    model: FIXTURE_MODEL_ID,
    name: "Support",
    operationId: "agent-create-1",
  };
  const createAgent = async () => {
    const response = await request("/api/product/agents", "POST", agentBody);
    if (response.status !== 200) {
      throw new Error(await response.text());
    }
    return object(await response.json());
  };
  return { agentBody, createAgent, handler, install, options, request };
};
export const signSlack = async (
  body: unknown,
  secret: string,
  timestamp = String(Math.floor(Date.now() / 1000))
) => {
  const raw = JSON.stringify(body);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`v0:${timestamp}:${raw}`)
    )
  );
  return {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  };
};

export const domainSnapshot = (
  address: EventAddress,
  values: Record<string, unknown> = {}
): DomainSnapshot =>
  Schema.decodeUnknownSync(DomainSnapshot)({
    address,
    agentVersion: 1,
    approvals: [],
    executions: [],
    outputs: [],
    revision: 0,
    runs: [],
    tools: [],
    userMessages: [],
    ...values,
  });
