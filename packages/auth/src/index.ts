import type { Database } from "@cerebro/db";
import { authSchema } from "@cerebro/db/schema/auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

export interface AuthConfig {
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  CORS_ORIGIN: string;
}

export const createAuth = (env: AuthConfig, database: Database) =>
  betterAuth({
    advanced: {
      useSecureCookies: new URL(env.BETTER_AUTH_URL).protocol === "https:",
    },
    baseURL: env.BETTER_AUTH_URL,
    database: drizzleAdapter(database, {
      provider: "pg",
      schema: authSchema,
    }),
    emailAndPassword: { enabled: true },
    secret: env.BETTER_AUTH_SECRET,
    session: { cookieCache: { enabled: false } },
    trustedOrigins: [env.BETTER_AUTH_URL, env.CORS_ORIGIN],
  });

export type Session = ReturnType<typeof createAuth>["$Infer"]["Session"];
