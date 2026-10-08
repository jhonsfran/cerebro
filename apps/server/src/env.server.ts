import type { WorkerLoader } from "@cerebro/tools/dynamic-worker";

import type { SessionAgent } from "./deployed-session-agent";

export interface WorkerEnv {
  readonly [binding: string]: unknown;
  DATABASE_URL: string;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  ENTERPRISE_IDENTITY_JSON?: string;
  CORS_ORIGIN: string;
  DEPLOY_MODE: "local" | "fixture" | "production";
  FIXTURE_ADAPTERS: "0" | "1";
  CHANNEL_DISPATCHER: DurableObjectNamespace;
  CHANNEL_ORGANIZATION_ID?: string;
  SLACK_CHANNEL_JSON?: string;
  SESSION_FIXTURE: DurableObjectNamespace;
  SESSION: DurableObjectNamespace<SessionAgent>;
  GATEWAY_JOURNAL: DurableObjectNamespace;
  TOOL_GATEWAY: Fetcher;
  LOADER: WorkerLoader;
  AUDIT_SINK: Fetcher;
  RUNTIME_CONFIG_JSON: string;
  FIXTURE_URL: string;
  TOOL_EFFECT_MODE: "idempotent" | "non-idempotent";
}

export const assertWorkerEnv = (env: WorkerEnv): void => {
  if (!env.DATABASE_URL || !env.BETTER_AUTH_URL || !env.CORS_ORIGIN) {
    throw new Error("Worker deployment settings are incomplete");
  }
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
    throw new Error("Authentication secret is missing or too short");
  }
  if (!["local", "fixture", "production"].includes(env.DEPLOY_MODE)) {
    throw new Error("Invalid deployment mode");
  }
  if (env.DEPLOY_MODE !== "fixture" && env.FIXTURE_ADAPTERS !== "0") {
    throw new Error("Fixture adapters require explicit fixture mode");
  }
  if (
    env.DEPLOY_MODE === "production" &&
    new URL(env.DATABASE_URL).searchParams.get("sslmode") !== "verify-full"
  ) {
    throw new Error("Production database URL must use sslmode=verify-full");
  }
  if (
    env.DEPLOY_MODE === "production" &&
    new URL(env.BETTER_AUTH_URL).protocol !== "https:"
  ) {
    throw new Error("Production authentication URL must use HTTPS");
  }
};
