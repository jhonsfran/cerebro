import { z } from "zod";

import { createProductHandler } from "../../packages/api/src/routers/conversations";
import type {
  ProductHandlerOptions,
  SlackConfiguration,
} from "../../packages/channels/src/types";
import { sql } from "../../packages/db/node_modules/drizzle-orm";
import { withDatabase } from "../../packages/db/src/index";
import { user } from "../../packages/db/src/schema/auth";

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
    fetch,
    getUser: (request) =>
      Promise.resolve(
        request.headers.get("x-test-user")
          ? { id: request.headers.get("x-test-user") ?? "" }
          : null
      ),
    mode: "fixture",
    organizationId: "channel-test-company",
    slack,
    withDatabase: database,
  };
  await options.withDatabase(async (db) => {
    await db.execute(
      sql`truncate installation_setup, agent, agent_version, agent_publish_operation, channel_conversation, channel_inbox, channel_item, channel_fixture_run, channel_effect, channel_reply, channel_link_event, identity_principal, identity_grant, identity_policy_revision, identity_slack_link, identity_slack_link_challenge restart identity cascade`
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
  const install = async () => {
    const response = await request("/api/product/setup", "POST", {
      operationId: "install-1",
    });
    if (response.status !== 200) {
      throw new Error(await response.text());
    }
    return object(await response.json());
  };
  const agentBody = {
    enabledToolIds: ["fixture-read"],
    grants: [],
    instructions: "Use the pilot source.",
    model: "fixture-model",
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
