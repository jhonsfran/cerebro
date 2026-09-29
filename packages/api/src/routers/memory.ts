import { id } from "@cerebro/contracts";
import type {
  ArtifactStore,
  ExecutionContext,
  MemoryRecord,
  MemoryScope,
  Visibility,
} from "@cerebro/contracts";
import type { Database } from "@cerebro/db";
import type { IdentityRepository } from "@cerebro/db/repositories/identity";
import type { MemoryService } from "@cerebro/memory";
import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { protectedProcedure } from "../index";

export interface MemoryApiServices {
  readonly memory: MemoryService;
  readonly artifacts: ArtifactStore;
  readonly identity: Pick<
    IdentityRepository,
    "findPrincipalByUser" | "readSnapshot"
  >;
}
export type MemoryApiFactory = (database: Database) => MemoryApiServices;
const scopeInput = z.object({
  delegationId: z.string().trim().min(1).optional(),
  organizationId: z.string().trim().min(1),
});
const visibility = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("private"), ownerId: z.string().trim().min(1) }),
  z.object({ kind: z.literal("organization") }),
  z.object({ grantId: z.string().trim().min(1), kind: z.literal("grant") }),
]);
const provenance = z.object({
  observedAt: z.number().finite(),
  sourceId: z.string().trim().min(1),
  sourceUri: z.string().trim().min(1),
  sourceVersion: z.string().trim().min(1),
});
const effectInput = {
  operationId: z.string().trim().min(1),
  requestDigest: z.string().trim().min(1),
};
const recordBase = {
  id: z.string().trim().min(1),
  provenance,
  text: z.string().min(1),
  visibility,
};
const memoryRecordInput = z.discriminatedUnion("kind", [
  z.object({ ...recordBase, kind: z.literal("source-chunk") }),
  z.object({ ...recordBase, kind: z.literal("remembered-fact") }),
  z.object({
    ...recordBase,
    dependentSourceIds: z.array(z.string().trim().min(1)),
    kind: z.literal("conversation-summary"),
  }),
]);
const artifactInput = z.object({
  artifactId: z.string().trim().min(1),
  organizationId: z.string().trim().min(1),
  provenance,
  visibility,
});
const publicVisibility = (input: z.infer<typeof visibility>): Visibility =>
  input.kind === "private"
    ? { kind: "private", ownerId: id.principal(input.ownerId) }
    : input;
const publicProvenance = (input: z.infer<typeof provenance>) => ({
  ...input,
  sourceId: id.source(input.sourceId),
});
const effect = (
  input: { operationId: string; requestDigest: string },
  now: () => number
) => ({
  deadlineAt: now() + 30_000,
  operationId: id.operation(input.operationId),
  requestDigest: id.digest(input.requestDigest),
});
const unavailable: MemoryApiFactory = () => {
  throw new ORPCError("SERVICE_UNAVAILABLE", {
    message:
      "Memory providers have not been configured by trusted server composition.",
  });
};

export const createMemoryRouter = (
  factory: MemoryApiFactory = unavailable,
  now: () => number = Date.now
) => {
  const resolve = async (
    database: Database,
    session: { user: { id: string } } | null,
    input: z.infer<typeof scopeInput>
  ): Promise<{ services: MemoryApiServices; scope: MemoryScope }> => {
    if (!session?.user.id) {
      throw new ORPCError("UNAUTHORIZED");
    }
    const services = factory(database);
    const principal = await services.identity.findPrincipalByUser(
      input.organizationId,
      session.user.id
    );
    if (
      !principal ||
      principal.kind !== "human" ||
      principal.state !== "active"
    ) {
      throw new ORPCError("FORBIDDEN");
    }
    const actor = {
      id: id.principal(principal.id),
      kind: principal.kind,
      organizationId: id.organization(principal.organizationId),
      state: principal.state,
    };
    let execution: ExecutionContext = { actor };
    if (input.delegationId) {
      const snapshot = await services.identity.readSnapshot(
        input.organizationId,
        principal.id,
        input.delegationId
      );
      if (
        !snapshot.delegation ||
        !snapshot.represented ||
        snapshot.delegation.actorId !== principal.id ||
        snapshot.delegation.revokedAt ||
        snapshot.delegation.expiresAt.getTime() <= now()
      ) {
        throw new ORPCError("FORBIDDEN");
      }
      execution = {
        actor,
        delegation: {
          actorId: id.principal(snapshot.delegation.actorId),
          expiresAt: snapshot.delegation.expiresAt.getTime(),
          id: id.delegation(snapshot.delegation.id),
          organizationId: id.organization(snapshot.delegation.organizationId),
          representedId: id.principal(snapshot.delegation.representedId),
        },
        represented: {
          id: id.principal(snapshot.represented.id),
          kind: snapshot.represented.kind,
          organizationId: id.organization(snapshot.represented.organizationId),
          state: snapshot.represented.state,
        },
      };
    }
    return {
      scope: {
        context: execution,
        organizationId: id.organization(input.organizationId),
      },
      services,
    };
  };
  return {
    deleteArtifact: protectedProcedure
      .input(scopeInput.extend({ ...effectInput, ref: artifactInput }))
      .handler(async ({ context, input }) => {
        const { services, scope } = await resolve(
          context.db,
          context.session,
          input
        );
        return await services.artifacts.delete(
          scope,
          {
            artifactId: id.artifact(input.ref.artifactId),
            organizationId: id.organization(input.ref.organizationId),
            provenance: publicProvenance(input.ref.provenance),
            visibility: publicVisibility(input.ref.visibility),
          },
          effect(input, now)
        );
      }),
    forget: protectedProcedure
      .input(
        scopeInput.extend({
          ...effectInput,
          sourceId: z.string().trim().min(1),
        })
      )
      .handler(async ({ context, input }) => {
        const { services, scope } = await resolve(
          context.db,
          context.session,
          input
        );
        return await services.memory.forget(
          scope,
          id.source(input.sourceId),
          effect(input, now)
        );
      }),
    ingest: protectedProcedure
      .input(
        scopeInput.extend({
          ...effectInput,
          source: z.object({
            chunks: z
              .array(
                z.object({
                  id: z.string().trim().min(1),
                  text: z.string().min(1),
                })
              )
              .min(1),
            document: z.string().min(1),
            expectedGeneration: z.number().int().positive().nullable(),
            expiresAt: z.number().finite().optional(),
            observedAt: z.number().finite(),
            sourceId: z.string().trim().min(1),
            uri: z.string().trim().min(1),
            version: z.string().trim().min(1),
            visibility,
          }),
        })
      )
      .handler(async ({ context, input }) => {
        const { services, scope } = await resolve(
          context.db,
          context.session,
          input
        );
        return await services.memory.ingest(
          scope,
          {
            ...input.source,
            sourceId: id.source(input.source.sourceId),
            visibility: publicVisibility(input.source.visibility),
          },
          effect(input, now)
        );
      }),
    putArtifact: protectedProcedure
      .input(
        scopeInput.extend({
          ...effectInput,
          bytes: z.array(z.number().int().min(0).max(255)),
          metadata: artifactInput.omit({ artifactId: true }),
        })
      )
      .handler(async ({ context, input }) => {
        const { services, scope } = await resolve(
          context.db,
          context.session,
          input
        );
        return await services.artifacts.put(
          scope,
          new Uint8Array(input.bytes),
          {
            organizationId: id.organization(input.metadata.organizationId),
            provenance: publicProvenance(input.metadata.provenance),
            visibility: publicVisibility(input.metadata.visibility),
          },
          effect(input, now)
        );
      }),
    readArtifact: protectedProcedure
      .input(scopeInput.extend({ ref: artifactInput }))
      .handler(async ({ context, input }) => {
        const { services, scope } = await resolve(
          context.db,
          context.session,
          input
        );
        const result = await services.artifacts.read(
          scope,
          {
            artifactId: id.artifact(input.ref.artifactId),
            organizationId: id.organization(input.ref.organizationId),
            provenance: publicProvenance(input.ref.provenance),
            visibility: publicVisibility(input.ref.visibility),
          },
          { deadlineAt: now() + 30_000 }
        );
        return result.status === "ok"
          ? { status: "ok" as const, value: [...result.value] }
          : result;
      }),
    remember: protectedProcedure
      .input(scopeInput.extend({ ...effectInput, record: memoryRecordInput }))
      .handler(async ({ context, input }) => {
        const { services, scope } = await resolve(
          context.db,
          context.session,
          input
        );
        const base = {
          ...input.record,
          provenance: publicProvenance(input.record.provenance),
          visibility: publicVisibility(input.record.visibility),
        };
        const record: MemoryRecord =
          input.record.kind === "conversation-summary"
            ? {
                ...base,
                dependentSourceIds: input.record.dependentSourceIds.map(
                  id.source
                ),
                kind: "conversation-summary",
              }
            : { ...base, kind: input.record.kind };
        return await services.memory.remember(
          scope,
          record,
          effect(input, now)
        );
      }),
    retrieve: protectedProcedure
      .input(
        scopeInput.extend({
          limit: z.number().int().min(1).max(100),
          text: z.string().min(1),
        })
      )
      .handler(async ({ context, input }) => {
        const { services, scope } = await resolve(
          context.db,
          context.session,
          input
        );
        return await services.memory.retrieve(
          { ...scope, limit: input.limit, text: input.text },
          { deadlineAt: now() + 30_000 }
        );
      }),
    revoke: protectedProcedure
      .input(
        scopeInput.extend({
          ...effectInput,
          sourceId: z.string().trim().min(1),
        })
      )
      .handler(async ({ context, input }) => {
        const { services, scope } = await resolve(
          context.db,
          context.session,
          input
        );
        return await services.memory.revoke(
          scope,
          id.source(input.sourceId),
          effect(input, now)
        );
      }),
  };
};
export const memoryRouter = createMemoryRouter();
