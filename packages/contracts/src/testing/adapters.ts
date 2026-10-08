// oxlint-disable eslint/require-await -- Fixture ports keep state changes synchronous and expose the asynchronous port signatures.
import { id, isExecutionContextActiveAt } from "../identity.ts";
import type {
  Digest,
  ExecutionContext,
  OperationId,
  PrincipalId,
} from "../identity.ts";
import type {
  ArtifactRef,
  ArtifactStore,
  MemoryRecord,
  MemoryStore,
  Visibility,
} from "../memory.ts";
import type {
  AuthorizationDecision,
  AuthorizationPolicy,
  EntitlementDecision,
  EntitlementPolicy,
} from "../policy.ts";
import { preflightEffect } from "../port.ts";
import type { EffectOptions, PortResult, ReadOptions } from "../port.ts";
import type { AgentDefinition, AgentRepository } from "../session.ts";
import { canonicalToolArguments, toolCapabilityMatches } from "../tools.ts";
import type { ToolExecution, ToolExecutor } from "../tools.ts";
import {
  allowedUser,
  fixtureAgentId,
  fixtureOrganizationId,
  serviceActor,
  unknownToolOutcome,
  unknownOutcomeInvocation,
} from "./fixtures.ts";

type PortFailure = Exclude<PortResult<never>, { readonly status: "ok" }>;

export interface FixtureOptions {
  readonly mode: "local" | "fixture" | "production";
  readonly now?: number;
  readonly grantIdsByPrincipal?: ReadonlyMap<PrincipalId, ReadonlySet<string>>;
}

export interface FixtureAdapters {
  readonly agentRepository: AgentRepository;
  readonly artifactStore: ArtifactStore;
  readonly authorizationPolicy: AuthorizationPolicy;
  readonly entitlementPolicy: EntitlementPolicy;
  readonly toolExecutor: ToolExecutor;
  readonly memoryStore: MemoryStore;
}

const requestKey = (...fields: readonly unknown[]): string =>
  canonicalToolArguments(fields);

const copyFixture = <T>(value: T): T => structuredClone(value);

const conflict = (reason: string): PortFailure => ({
  code: "digest-mismatch",
  reason,
  status: "conflict",
});

const denied = (reason: string): PortFailure => ({
  code: "unauthorized",
  reason,
  status: "denied",
});

const readFailure = (
  options: ReadOptions,
  now: number
): PortFailure | undefined => {
  if (options.signal?.aborted) {
    return {
      code: "cancelled",
      reason: "The caller cancelled the operation.",
      status: "unavailable",
    };
  }
  if (!Number.isFinite(options.deadlineAt) || options.deadlineAt <= now) {
    return {
      code: "deadline-exceeded",
      reason: "The operation deadline has passed.",
      status: "unavailable",
    };
  }
  return undefined;
};

const effectFailure = (
  options: EffectOptions,
  now: number
): PortFailure | undefined => {
  const result = preflightEffect(options, now);
  return result.status === "ok" ? undefined : result;
};

const sameVisibility = (first: Visibility, second: Visibility): boolean => {
  if (first.kind === "organization") {
    return second.kind === "organization";
  }
  if (first.kind === "private") {
    return second.kind === "private" && first.ownerId === second.ownerId;
  }
  return second.kind === "grant" && first.grantId === second.grantId;
};

export const createFixtureAdapters = (
  options: FixtureOptions
): FixtureAdapters => {
  if (options.mode !== "fixture") {
    throw new Error("Fixture adapters cannot run in production mode.");
  }

  const now = options.now ?? 1_800_000_000_000;
  const allowedPrincipalIds = new Set([allowedUser.id, serviceActor.id]);
  const hasGrant = (
    context: ExecutionContext,
    organizationId: typeof fixtureOrganizationId
  ): boolean =>
    isExecutionContextActiveAt(context, organizationId, now) &&
    allowedPrincipalIds.has(context.actor.id) &&
    (!context.represented || allowedPrincipalIds.has(context.represented.id));

  const hasVisibilityGrant = (
    context: ExecutionContext,
    grantId: string
  ): boolean => {
    const grants = options.grantIdsByPrincipal;
    if (!grants?.get(context.actor.id)?.has(grantId)) {
      return false;
    }
    return (
      !context.represented ||
      grants.get(context.represented.id)?.has(grantId) === true
    );
  };

  const canReadVisibility = (
    context: ExecutionContext,
    visibility: Visibility
  ): boolean => {
    if (visibility.kind === "organization") {
      return true;
    }
    if (visibility.kind === "private") {
      return (
        visibility.ownerId === (context.represented?.id ?? context.actor.id)
      );
    }
    return hasVisibilityGrant(context, visibility.grantId);
  };

  const authorizationPolicy: AuthorizationPolicy = {
    evaluate: async (context, _action, resource, readOptions) => {
      const failure = readFailure(readOptions, now);
      if (failure) {
        return failure;
      }
      const value: AuthorizationDecision = hasGrant(
        context,
        resource.organizationId
      )
        ? { decision: "allow", policyVersion: "fixture-v1" }
        : {
            decision: "deny",
            policyVersion: "fixture-v1",
            reason: "The principal has no current grant.",
          };
      return { status: "ok", value };
    },
  };

  const entitlementPolicy: EntitlementPolicy = {
    check: async (request, readOptions) => {
      const failure = readFailure(readOptions, now);
      if (failure) {
        return failure;
      }
      const allowed =
        request.organizationId === fixtureOrganizationId &&
        request.agentId === fixtureAgentId &&
        request.capability === "fixture-capability";
      const value: EntitlementDecision = allowed
        ? { decision: "allow", policyVersion: "fixture-v1" }
        : {
            decision: "deny",
            policyVersion: "fixture-v1",
            reason: "The capability is not enabled.",
          };
      return { status: "ok", value };
    },
  };

  const agentVersions = new Map<number, AgentDefinition>([
    [
      1,
      {
        agentId: fixtureAgentId,
        enabledToolIds: ["tool-1"],
        grants: [
          {
            action: "execute",
            resource: {
              id: "tool-1",
              kind: "tool",
              organizationId: fixtureOrganizationId,
            },
          },
        ],
        instructions: "Use the fixture tools.",
        model: "fixture-model",
        organizationId: fixtureOrganizationId,
        version: 1,
      },
    ],
  ]);
  const publishedAgents = new Map<
    OperationId,
    {
      readonly digest: Digest;
      readonly request: string;
      readonly result: PortResult<AgentDefinition>;
    }
  >();
  const agentRepository: AgentRepository = {
    get: async (organizationId, agentId, version, readOptions) => {
      const failure = readFailure(readOptions, now);
      if (failure) {
        return failure;
      }
      if (
        organizationId !== fixtureOrganizationId ||
        agentId !== fixtureAgentId
      ) {
        return { resource: "agent", status: "not-found" };
      }
      const selected =
        version === "latest" ? Math.max(...agentVersions.keys()) : version;
      const value = agentVersions.get(selected);
      return value
        ? { status: "ok", value: copyFixture(value) }
        : { resource: "agent version", status: "not-found" };
    },
    publish: async (definition, expectedVersion, effect) => {
      if (
        !Number.isFinite(definition.version) ||
        (expectedVersion !== undefined && !Number.isFinite(expectedVersion))
      ) {
        return {
          reason: "The agent version must be finite.",
          status: "invalid-input",
        };
      }
      const request = requestKey(definition, expectedVersion ?? null);
      const prior = publishedAgents.get(effect.operationId);
      if (prior) {
        return prior.digest === effect.requestDigest &&
          prior.request === request
          ? copyFixture(prior.result)
          : conflict(
              "The operation ID already has a different agent definition."
            );
      }
      const failure = effectFailure(effect, now);
      if (failure) {
        return failure;
      }
      if (
        definition.organizationId !== fixtureOrganizationId ||
        definition.agentId !== fixtureAgentId
      ) {
        return {
          reason: "The agent is outside the fixture organization.",
          status: "invalid-input",
        };
      }
      const latest = Math.max(...agentVersions.keys());
      if (expectedVersion !== latest || definition.version !== latest + 1) {
        return {
          code: "version-mismatch",
          reason: "The expected agent version is stale.",
          status: "conflict",
        };
      }
      const snapshot = copyFixture(definition);
      agentVersions.set(snapshot.version, snapshot);
      const result: PortResult<AgentDefinition> = {
        status: "ok",
        value: copyFixture(snapshot),
      };
      publishedAgents.set(effect.operationId, {
        digest: effect.requestDigest,
        request,
        result: copyFixture(result),
      });
      return result;
    },
  };

  const toolResults = new Map<
    OperationId,
    {
      readonly digest: Digest;
      readonly request: string;
      readonly result: PortResult<ToolExecution>;
    }
  >();
  const toolExecutor: ToolExecutor = {
    execute: async (call, capability, effect) => {
      if (
        !hasGrant(call.context, call.organizationId) ||
        !(await toolCapabilityMatches(capability, call, effect, now))
      ) {
        return denied("The tool capability does not authorize this call.");
      }
      const request = requestKey(call, capability);
      const prior = toolResults.get(effect.operationId);
      if (prior) {
        return prior.digest === effect.requestDigest &&
          prior.request === request
          ? copyFixture(prior.result)
          : conflict("The operation ID already has different tool arguments.");
      }
      const failure = effectFailure(effect, now);
      if (failure) {
        return failure;
      }
      const result: PortResult<ToolExecution> =
        effect.operationId === unknownOutcomeInvocation.operationId
          ? unknownToolOutcome
          : {
              status: "ok",
              value: {
                output: {
                  arguments: copyFixture(call.arguments),
                  toolId: call.tool.id,
                },
              },
            };
      toolResults.set(effect.operationId, {
        digest: effect.requestDigest,
        request,
        result: copyFixture(result),
      });
      return result;
    },
    reconcile: async (operationId, context, readOptions) => {
      const failure = readFailure(readOptions, now);
      if (failure) {
        return failure;
      }
      if (!hasGrant(context, fixtureOrganizationId)) {
        return denied("The principal has no current grant.");
      }
      return (
        copyFixture(toolResults.get(operationId)?.result) ?? {
          resource: "tool operation",
          status: "not-found",
        }
      );
    },
  };

  const records = new Map<string, MemoryRecord>();
  type MemoryEffect =
    | {
        readonly kind: "remember";
        readonly digest: Digest;
        readonly request: string;
        readonly result: PortResult<MemoryRecord>;
      }
    | {
        readonly kind: "forget";
        readonly digest: Digest;
        readonly request: string;
        readonly result: PortResult<{ readonly removed: number }>;
      };
  const memoryEffects = new Map<OperationId, MemoryEffect>();
  const memoryStore: MemoryStore = {
    forget: async (scope, sourceId, effect) => {
      const request = requestKey(scope, sourceId);
      if (!hasGrant(scope.context, scope.organizationId)) {
        return denied("The principal has no current grant.");
      }
      const prior = memoryEffects.get(effect.operationId);
      if (prior) {
        return prior.kind === "forget" &&
          prior.digest === effect.requestDigest &&
          prior.request === request
          ? copyFixture(prior.result)
          : conflict("The operation ID already has a different memory effect.");
      }
      const failure = effectFailure(effect, now);
      if (failure) {
        return failure;
      }
      let removed = 0;
      for (const [recordId, record] of records) {
        if (
          record.provenance.sourceId === sourceId ||
          (record.kind === "conversation-summary" &&
            record.dependentSourceIds.includes(sourceId))
        ) {
          records.delete(recordId);
          removed += 1;
        }
      }
      const result: PortResult<{ readonly removed: number }> = {
        status: "ok",
        value: { removed },
      };
      memoryEffects.set(effect.operationId, {
        digest: effect.requestDigest,
        kind: "forget",
        request,
        result: copyFixture(result),
      });
      return result;
    },
    remember: async (scope, record, effect) => {
      const request = requestKey(scope, record);
      if (!hasGrant(scope.context, scope.organizationId)) {
        return denied("The principal has no current grant.");
      }
      const prior = memoryEffects.get(effect.operationId);
      if (prior) {
        return prior.kind === "remember" &&
          prior.digest === effect.requestDigest &&
          prior.request === request
          ? copyFixture(prior.result)
          : conflict("The operation ID already has a different memory effect.");
      }
      const failure = effectFailure(effect, now);
      if (failure) {
        return failure;
      }
      const snapshot = copyFixture(record);
      records.set(snapshot.id, snapshot);
      const result: PortResult<MemoryRecord> = {
        status: "ok",
        value: copyFixture(snapshot),
      };
      memoryEffects.set(effect.operationId, {
        digest: effect.requestDigest,
        kind: "remember",
        request,
        result: copyFixture(result),
      });
      return result;
    },
    retrieve: async (query, readOptions) => {
      const failure = readFailure(readOptions, now);
      if (failure) {
        return failure;
      }
      if (!hasGrant(query.context, query.organizationId)) {
        return denied("The principal has no current grant.");
      }
      if (!Number.isSafeInteger(query.limit) || query.limit < 0) {
        return {
          reason: "The memory limit must be a nonnegative integer.",
          status: "invalid-input",
        };
      }
      const search = query.text.toLowerCase();
      const hits = [...records.values()]
        .filter(
          (record) =>
            record.text.toLowerCase().includes(search) &&
            canReadVisibility(query.context, record.visibility)
        )
        .slice(0, query.limit)
        .map((record) => ({
          citation: copyFixture(record.provenance),
          record: copyFixture(record),
        }));
      return { status: "ok", value: hits };
    },
  };

  interface ArtifactEntry {
    readonly ref: ArtifactRef;
    readonly bytes: Uint8Array;
  }
  const artifacts = new Map<ArtifactRef["artifactId"], ArtifactEntry>();
  const artifactPuts = new Map<
    OperationId,
    {
      readonly digest: Digest;
      readonly request: string;
      readonly entry: ArtifactEntry;
    }
  >();
  const artifactDeletes = new Map<
    OperationId,
    { readonly digest: Digest; readonly request: string }
  >();
  const artifactStore: ArtifactStore = {
    delete: async (scope, ref, effect) => {
      const request = requestKey(scope, ref);
      if (!hasGrant(scope.context, scope.organizationId)) {
        return denied("The principal has no current grant.");
      }
      const prior = artifactDeletes.get(effect.operationId);
      if (prior) {
        return prior.digest === effect.requestDigest &&
          prior.request === request
          ? { status: "ok", value: undefined }
          : conflict(
              "The operation ID already has a different artifact delete."
            );
      }
      if (artifactPuts.has(effect.operationId)) {
        return conflict("The operation ID already identifies a put.");
      }
      const failure = effectFailure(effect, now);
      if (failure) {
        return failure;
      }
      const entry = artifacts.get(ref.artifactId);
      if (!entry || entry.ref.organizationId !== scope.organizationId) {
        return { resource: "artifact", status: "not-found" };
      }
      if (!canReadVisibility(scope.context, entry.ref.visibility)) {
        return denied("The principal cannot delete this artifact.");
      }
      artifacts.delete(ref.artifactId);
      artifactDeletes.set(effect.operationId, {
        digest: effect.requestDigest,
        request,
      });
      return { status: "ok", value: undefined };
    },
    put: async (scope, bytes, metadata, effect) => {
      const request = requestKey(scope, [...bytes], metadata);
      if (
        !hasGrant(scope.context, scope.organizationId) ||
        !canReadVisibility(scope.context, metadata.visibility)
      ) {
        return denied("The principal cannot write this artifact.");
      }
      if (metadata.organizationId !== scope.organizationId) {
        return {
          reason: "Artifact organization does not match scope.",
          status: "invalid-input",
        };
      }
      const prior = artifactPuts.get(effect.operationId);
      if (prior) {
        const sameBytes =
          prior.entry.bytes.length === bytes.length &&
          prior.entry.bytes.every((byte, index) => byte === bytes[index]);
        return prior.digest === effect.requestDigest &&
          prior.request === request &&
          sameBytes &&
          prior.entry.ref.organizationId === metadata.organizationId &&
          prior.entry.ref.provenance.sourceId ===
            metadata.provenance.sourceId &&
          prior.entry.ref.provenance.sourceVersion ===
            metadata.provenance.sourceVersion &&
          prior.entry.ref.provenance.sourceUri ===
            metadata.provenance.sourceUri &&
          prior.entry.ref.provenance.observedAt ===
            metadata.provenance.observedAt &&
          sameVisibility(prior.entry.ref.visibility, metadata.visibility)
          ? { status: "ok", value: copyFixture(prior.entry.ref) }
          : conflict("The operation ID already has a different artifact.");
      }
      if (artifactDeletes.has(effect.operationId)) {
        return conflict("The operation ID already identifies a delete.");
      }
      const failure = effectFailure(effect, now);
      if (failure) {
        return failure;
      }
      const ref: ArtifactRef = copyFixture({
        ...metadata,
        artifactId: id.artifact(`artifact:${effect.operationId}`),
      });
      const entry: ArtifactEntry = { bytes: new Uint8Array(bytes), ref };
      artifacts.set(ref.artifactId, entry);
      artifactPuts.set(effect.operationId, {
        digest: effect.requestDigest,
        entry,
        request,
      });
      return { status: "ok", value: copyFixture(ref) };
    },
    read: async (scope, ref, readOptions) => {
      const failure = readFailure(readOptions, now);
      if (failure) {
        return failure;
      }
      if (!hasGrant(scope.context, scope.organizationId)) {
        return denied("The principal has no current grant.");
      }
      const entry = artifacts.get(ref.artifactId);
      if (!entry || entry.ref.organizationId !== scope.organizationId) {
        return { resource: "artifact", status: "not-found" };
      }
      if (!canReadVisibility(scope.context, entry.ref.visibility)) {
        return denied("The principal cannot read this artifact.");
      }
      return { status: "ok", value: new Uint8Array(entry.bytes) };
    },
  };

  return {
    agentRepository,
    artifactStore,
    authorizationPolicy,
    entitlementPolicy,
    memoryStore,
    toolExecutor,
  };
};
