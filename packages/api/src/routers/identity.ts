import { createAuthorizationPolicy } from "@cerebro/authorization";
import { id } from "@cerebro/contracts";
import type { Database } from "@cerebro/db";
import { createIdentityRepository } from "@cerebro/db/repositories/identity";
import type { IdentityRepository } from "@cerebro/db/repositories/identity";
import { auditEvent } from "@cerebro/db/schema/audit";
import { usageReservation } from "@cerebro/db/schema/usage";
import { ORPCError } from "@orpc/server";
import { and, asc, eq, gt } from "drizzle-orm";
import { z } from "zod";

import { protectedProcedure } from "../index";

type IdentityApiRepository = Pick<
  IdentityRepository,
  "createSlackLinkChallenge" | "findPrincipalByUser" | "readSnapshot"
>;

type RepositoryFactory = (database: Database) => IdentityApiRepository;

const SLACK_LINK_LIFETIME_MS = 10 * 60 * 1000;
const AUTHORIZATION_DEADLINE_MS = 5 * 1000;
const SLACK_LINK_CODE_BYTES = 32;

const organizationInput = z.object({
  organizationId: z.string().trim().min(1),
});

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const digestSlackLinkCode = async (code: string): Promise<string> =>
  hex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code))
    )
  );

const requireCurrentPrincipal = async (
  repository: IdentityApiRepository,
  organizationId: string,
  betterAuthUserId: string
) => {
  const principal = await repository.findPrincipalByUser(
    organizationId,
    betterAuthUserId
  );
  if (
    !principal ||
    principal.state !== "active" ||
    principal.kind !== "human"
  ) {
    throw new ORPCError("FORBIDDEN", {
      message: "The user has no active principal in this organization.",
    });
  }
  return principal;
};

const requireSessionUserId = (
  session: { user: { id: string } } | null
): string => {
  if (!session?.user.id) {
    throw new ORPCError("UNAUTHORIZED");
  }
  return session.user.id;
};

const exportInput = organizationInput.extend({
  cursor: z.string().min(1).max(1024).optional(),
  kind: z.enum(["audit", "usage"]),
  limit: z.number().int().min(1).max(200).default(100),
});
const requireExport = async (
  repository: IdentityApiRepository,
  organizationId: string,
  kind: "audit" | "usage",
  userId: string,
  now: () => number
) => {
  const principal = await requireCurrentPrincipal(
    repository,
    organizationId,
    userId
  );
  const result = await createAuthorizationPolicy(repository, now).evaluate(
    {
      actor: {
        id: id.principal(principal.id),
        kind: principal.kind,
        organizationId: id.organization(principal.organizationId),
        state: principal.state,
      },
    },
    "export",
    {
      id: organizationId,
      kind: kind === "audit" ? "audit" : "budget",
      organizationId: id.organization(organizationId),
    },
    { deadlineAt: now() + AUTHORIZATION_DEADLINE_MS }
  );
  if (result.status !== "ok") {
    throw new ORPCError(
      result.status === "denied" ? "FORBIDDEN" : "SERVICE_UNAVAILABLE",
      {
        message:
          "reason" in result ? result.reason : "The export check failed.",
      }
    );
  }
  if (result.value.decision !== "allow") {
    throw new ORPCError("FORBIDDEN", {
      message: "Export is not permitted for this organization.",
    });
  }
  return result.value.policyVersion;
};
export const createIdentityRouter = (
  repositoryFactory: RepositoryFactory = createIdentityRepository,
  now: () => number = Date.now
) => ({
  authorizeExport: protectedProcedure
    .input(
      organizationInput.extend({
        kind: z.enum(["audit", "usage"]),
      })
    )
    .handler(async ({ context, input }) => {
      const repository = repositoryFactory(context.db);
      const policyVersion = await requireExport(
        repository,
        input.organizationId,
        input.kind,
        requireSessionUserId(context.session),
        now
      );
      return { authorized: true as const, policyVersion };
    }),
  beginSlackLink: protectedProcedure
    .input(organizationInput)
    .handler(async ({ context, input }) => {
      const repository = repositoryFactory(context.db);
      const principal = await requireCurrentPrincipal(
        repository,
        input.organizationId,
        requireSessionUserId(context.session)
      );
      const code = hex(
        crypto.getRandomValues(new Uint8Array(SLACK_LINK_CODE_BYTES))
      );
      const digest = await digestSlackLinkCode(code);
      const expiresAt = new Date(now() + SLACK_LINK_LIFETIME_MS);
      await repository.createSlackLinkChallenge(
        input.organizationId,
        principal.id,
        digest,
        expiresAt
      );
      return { code, expiresAt: expiresAt.toISOString() };
    }),
  currentPrincipal: protectedProcedure
    .input(organizationInput)
    .handler(async ({ context, input }) => {
      const repository = repositoryFactory(context.db);
      const principal = await requireCurrentPrincipal(
        repository,
        input.organizationId,
        requireSessionUserId(context.session)
      );
      return {
        id: principal.id,
        kind: principal.kind,
        organizationId: principal.organizationId,
        state: principal.state,
      };
    }),
  exportData: protectedProcedure
    .input(exportInput)
    .handler(async ({ context, input }) => {
      const repository = repositoryFactory(context.db);
      const policyVersion = await requireExport(
        repository,
        input.organizationId,
        input.kind,
        requireSessionUserId(context.session),
        now
      );
      if (input.kind === "audit") {
        const rows = await context.db
          .select()
          .from(auditEvent)
          .where(
            and(
              eq(auditEvent.organizationId, input.organizationId),
              input.cursor ? gt(auditEvent.eventId, input.cursor) : undefined
            )
          )
          .orderBy(asc(auditEvent.eventId))
          .limit(input.limit + 1);
        const records = rows.slice(0, input.limit);
        return {
          kind: "audit" as const,
          nextCursor:
            rows.length > input.limit ? records.at(-1)?.eventId : null,
          policyVersion,
          records,
        };
      }
      const rows = await context.db
        .select()
        .from(usageReservation)
        .where(
          and(
            eq(usageReservation.organizationId, input.organizationId),
            input.cursor ? gt(usageReservation.id, input.cursor) : undefined
          )
        )
        .orderBy(asc(usageReservation.id))
        .limit(input.limit + 1);
      const records = rows.slice(0, input.limit);
      return {
        kind: "usage" as const,
        nextCursor: rows.length > input.limit ? records.at(-1)?.id : null,
        policyVersion,
        records,
      };
    }),
});

export const identityRouter = createIdentityRouter();
