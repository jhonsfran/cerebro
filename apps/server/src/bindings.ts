import type { SlackQueueDelivery } from "@cerebro/channels/slack-events";
import type { TeamCommand, TeamReportDelivery } from "@cerebro/contracts/work";

import type { IdentityAgent } from "./session/agent";
import type { TeamAgent } from "./team-agent";

export interface WorkerEnv {
  readonly [binding: string]: unknown;
  DATABASE_URL: string;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  ENTERPRISE_IDENTITY_JSON?: string;
  CORS_ORIGIN: string;
  DEPLOY_MODE: "local" | "production";
  CHANNEL_ORGANIZATION_ID?: string;
  SLACK_CHANNEL_JSON?: string;
  SLACK_EVENTS: Queue<SlackQueueDelivery>;
  TEAM_COMMANDS: Queue<TeamCommand>;
  TEAM_REPORTS: Queue<TeamReportDelivery>;
  SESSION: DurableObjectNamespace<IdentityAgent>;
  TEAM: DurableObjectNamespace<TeamAgent>;
  AUDIT_SINK: Fetcher;
  ACCOUNT_KEY: string;
  RUNTIME_CONFIG_JSON: string;
}

export const assertWorkerEnv = (env: WorkerEnv): void => {
  if (!env.DATABASE_URL || !env.BETTER_AUTH_URL || !env.CORS_ORIGIN) {
    throw new Error("Worker deployment settings are incomplete");
  }
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
    throw new Error("Authentication secret is missing or too short");
  }
  if (!env.ACCOUNT_KEY || env.ACCOUNT_KEY.length < 32) {
    throw new Error("Account key is missing or too short");
  }
  if (!["local", "production"].includes(env.DEPLOY_MODE)) {
    throw new Error("Invalid deployment mode");
  }
  if (env.SLACK_CHANNEL_JSON && !env.SLACK_EVENTS) {
    throw new Error("The Slack event queue binding is missing");
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
