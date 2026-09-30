import { createAuthorizationPolicy } from "@cerebro/authorization";
import { id } from "@cerebro/contracts";
import type {
  Action,
  ExecutionContext,
  ContentDependencies,
  PortResult,
  Resource,
} from "@cerebro/contracts";
import type { Database } from "@cerebro/db";
import { createIdentityRepository } from "@cerebro/db/repositories/identity";
import { identityPrincipal } from "@cerebro/db/schema/identity";
import { and, eq } from "drizzle-orm";

import { ChannelError, EFFECT_DEADLINE_MS } from "./types";
import type { ChannelOptions } from "./types";

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)])
    );
  }
  return value;
};
export const digest = async (value: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(
    typeof value === "string" ? value : JSON.stringify(canonical(value))
  );
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
};
export const unwrap = <T>(result: PortResult<T>): T => {
  if (result.status === "ok") {
    return result.value;
  }
  const statuses = {
    conflict: 409,
    denied: 403,
    "invalid-input": 422,
    "not-found": 404,
    unavailable: 503,
    "unknown-outcome": 503,
  };
  throw new ChannelError(
    statuses[result.status],
    "code" in result ? result.code : result.status,
    "reason" in result ? result.reason : "The resource was not found."
  );
};
export const principalContext = async (
  database: Database,
  organizationId: string,
  userId: string
): Promise<ExecutionContext> => {
  const principal = await createIdentityRepository(
    database
  ).findPrincipalByUser(organizationId, userId);
  if (
    !principal ||
    principal.state !== "active" ||
    principal.kind !== "human"
  ) {
    throw new ChannelError(
      403,
      "forbidden",
      "The user has no active company principal."
    );
  }
  return {
    actor: {
      id: id.principal(principal.id),
      kind: principal.kind,
      organizationId: id.organization(organizationId),
      state: principal.state,
    },
  };
};
export const contextByPrincipal = async (
  database: Database,
  organizationId: string,
  principalId: string
): Promise<ExecutionContext> => {
  const [principal] = await database
    .select()
    .from(identityPrincipal)
    .where(
      and(
        eq(identityPrincipal.organizationId, organizationId),
        eq(identityPrincipal.id, principalId)
      )
    );
  if (!principal || principal.state !== "active") {
    throw new ChannelError(
      403,
      "forbidden",
      "The principal is no longer active."
    );
  }
  return {
    actor: {
      id: id.principal(principal.id),
      kind: principal.kind,
      organizationId: id.organization(organizationId),
      state: principal.state,
    },
  };
};
export const authorize = async (
  database: Database,
  options: ChannelOptions,
  context: ExecutionContext,
  action: Action,
  kind: Resource["kind"],
  resourceId: string
): Promise<void> => {
  const policy =
    options.authorization?.(database) ??
    createAuthorizationPolicy(createIdentityRepository(database), options.now);
  const result = unwrap(
    await policy.evaluate(
      context,
      action,
      {
        id: resourceId,
        kind,
        organizationId: id.organization(options.organizationId),
      },
      { deadlineAt: (options.now?.() ?? Date.now()) + EFFECT_DEADLINE_MS }
    )
  );
  if (result.decision !== "allow") {
    throw new ChannelError(403, "forbidden", result.reason);
  }
};

export const authorizeContent = async (
  database: Database,
  options: ChannelOptions,
  context: ExecutionContext,
  item: { readonly type: string; readonly dependencies?: ContentDependencies }
): Promise<void> => {
  if (!["output", "citation", "tool", "user"].includes(item.type)) {
    return;
  }
  if (!item.dependencies) {
    if (
      item.type !== "user" &&
      (options.mode !== "fixture" || options.checkContentDependencies)
    ) {
      throw new ChannelError(
        403,
        "unauthorized",
        "Content dependencies are not available."
      );
    }
    return;
  }
  await Promise.all([
    ...item.dependencies.sourceIds.map((sourceId) =>
      authorize(database, options, context, "read", "memory", sourceId)
    ),
    ...item.dependencies.toolIds.map((toolId) =>
      authorize(database, options, context, "read", "tool", toolId)
    ),
  ]);
  if (options.checkContentDependencies) {
    unwrap(
      await options.checkContentDependencies(
        database,
        context,
        item.dependencies
      )
    );
  } else if (
    options.mode !== "fixture" &&
    item.dependencies.sourceIds.length > 0
  ) {
    throw new ChannelError(
      503,
      "provider-unavailable",
      "Current source access is not configured."
    );
  }
};

export const equalToken = async (
  provided: string,
  configured: string
): Promise<boolean> => {
  const key = await crypto.subtle.importKey(
    "raw",
    crypto.getRandomValues(new Uint8Array(32)),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(configured)
  );
  return await crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(provided)
  );
};
export const trustedSetupCredential = async (
  options: ChannelOptions,
  userId: string,
  bootstrapToken?: string
): Promise<boolean> => {
  if (options.trustedOwnerUserId === userId) {
    return true;
  }
  if (!options.bootstrapToken || !bootstrapToken) {
    return false;
  }
  return await equalToken(bootstrapToken, options.bootstrapToken);
};
