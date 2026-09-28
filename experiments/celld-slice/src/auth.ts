import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { authSchema } from "./database";
import type { Database } from "./database";

export interface AuthSettings {
  AUTH_SECRET: string;
  AUTH_URL: string;
}

export const createAuth = (db: Database, settings: AuthSettings) =>
  betterAuth({
    advanced: {
      useSecureCookies: new URL(settings.AUTH_URL).protocol === "https:",
    },
    appName: "Cerebro compatibility experiment",
    baseURL: settings.AUTH_URL,
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    emailAndPassword: { enabled: true },
    logger: { disabled: true },
    secret: settings.AUTH_SECRET,
    session: { cookieCache: { enabled: false } },
    trustedOrigins: [settings.AUTH_URL],
  });
