import { scim } from "@better-auth/scim";
import { sso } from "@better-auth/sso";
import type { Database } from "@cerebro/db";
import { authSchema } from "@cerebro/db/schema/auth";
import {
  identityDelegation,
  identityPrincipal,
  identitySlackLinkChallenge,
} from "@cerebro/db/schema/identity";
import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import {
  enterpriseSCIM,
  enterpriseSSO,
  principalPlugin,
  parseEnterpriseIdentityConfig,
  parseEnterpriseIdentityJSON,
} from "./enterprise";
import type { EnterpriseIdentityConfig } from "./enterprise";
import { hashPassword, verifyPassword } from "./password";

export { enterpriseSCIM, enterpriseSSO } from "./enterprise";
export type { EnterpriseIdentityConfig } from "./enterprise";

export interface AuthConfig {
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  CORS_ORIGIN: string;
  ENTERPRISE_IDENTITY?: EnterpriseIdentityConfig;
  ENTERPRISE_IDENTITY_JSON?: string;
}

export const createAuth = (
  env: AuthConfig,
  database: Database
): ReturnType<typeof betterAuth> => {
  if (env.ENTERPRISE_IDENTITY && env.ENTERPRISE_IDENTITY_JSON) {
    throw new Error("Configure one enterprise identity source");
  }
  let enterprise: EnterpriseIdentityConfig | undefined;
  if (env.ENTERPRISE_IDENTITY) {
    enterprise = parseEnterpriseIdentityConfig(env.ENTERPRISE_IDENTITY);
  } else if (env.ENTERPRISE_IDENTITY_JSON) {
    enterprise = parseEnterpriseIdentityJSON(env.ENTERPRISE_IDENTITY_JSON);
  }
  const options: BetterAuthOptions = {
    advanced: {
      useSecureCookies: new URL(env.BETTER_AUTH_URL).protocol === "https:",
    },
    baseURL: env.BETTER_AUTH_URL,
    database: drizzleAdapter(database, {
      provider: "pg",
      schema: {
        ...authSchema,
        identityDelegation,
        identityPrincipal,
        identitySlackLinkChallenge,
      },
      transaction: true,
    }),
    emailAndPassword: {
      enabled: true,
      password: { hash: hashPassword, verify: verifyPassword },
    },
    plugins: enterprise
      ? [
          principalPlugin,
          sso(enterpriseSSO(enterprise)),
          scim(enterpriseSCIM(enterprise)),
        ]
      : [],
    secret: env.BETTER_AUTH_SECRET,
    session: { cookieCache: { enabled: false } },
    trustedOrigins: [
      env.BETTER_AUTH_URL,
      env.CORS_ORIGIN,
      ...(enterprise ? [new URL(enterprise.issuer).origin] : []),
    ],
  };
  return betterAuth(options);
};

export type Session = ReturnType<typeof createAuth>["$Infer"]["Session"];
