export interface WorkerEnv {
  DATABASE_URL: string;
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  ENTERPRISE_IDENTITY_JSON?: string;
  CORS_ORIGIN: string;
  DEPLOY_MODE: "fixture" | "production";
  FIXTURE_ADAPTERS: "0" | "1";
  SESSION_FIXTURE: DurableObjectNamespace;
}

export const assertWorkerEnv = (env: WorkerEnv): void => {
  if (!env.DATABASE_URL || !env.BETTER_AUTH_URL || !env.CORS_ORIGIN) {
    throw new Error("Worker deployment settings are incomplete");
  }
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
    throw new Error("Authentication secret is missing or too short");
  }
  if (env.DEPLOY_MODE !== "fixture" && env.DEPLOY_MODE !== "production") {
    throw new Error("Invalid deployment mode");
  }
  if (env.DEPLOY_MODE === "production" && env.FIXTURE_ADAPTERS !== "0") {
    throw new Error("Fixture adapters are forbidden in production");
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
