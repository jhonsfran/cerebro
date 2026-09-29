import { createAuthorizationPolicy } from "@cerebro/authorization";
import { id } from "@cerebro/contracts";
import type { ExecutionContext, Resource } from "@cerebro/contracts";
import type { Database } from "@cerebro/db";
import { createIdentityRepository } from "@cerebro/db/repositories/identity";
import type { IdentityRepository } from "@cerebro/db/repositories/identity";
import { ORPCError } from "@orpc/server";
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
      const principal = await requireCurrentPrincipal(
        repository,
        input.organizationId,
        requireSessionUserId(context.session)
      );
      const executionContext: ExecutionContext = {
        actor: {
          id: id.principal(principal.id),
          kind: principal.kind,
          organizationId: id.organization(principal.organizationId),
          state: principal.state,
        },
      };
      const resource: Resource = {
        id: input.organizationId,
        kind: input.kind === "audit" ? "audit" : "budget",
        organizationId: id.organization(input.organizationId),
      };
      const result = await createAuthorizationPolicy(repository, now).evaluate(
        executionContext,
        "export",
        resource,
        { deadlineAt: now() + AUTHORIZATION_DEADLINE_MS }
      );
      if (result.status !== "ok") {
        throw new ORPCError("SERVICE_UNAVAILABLE", {
          message: "The export authorization check is unavailable.",
        });
      }
      if (result.value.decision !== "allow") {
        throw new ORPCError("FORBIDDEN", {
          message: "Export is not permitted for this organization.",
        });
      }
      return {
        authorized: true as const,
        policyVersion: result.value.policyVersion,
      };
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
});

export const identityRouter = createIdentityRouter();
