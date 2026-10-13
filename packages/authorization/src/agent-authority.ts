import {
  AuthorityService,
  enforceDecision,
} from "@cerebro/contracts/authority-service";
import type { AuthorityRequest } from "@cerebro/contracts/authority-service";
import type { Denied } from "@cerebro/contracts/failures";
import { InvalidInput, Unavailable } from "@cerebro/contracts/failures";
import { isExecutionContextActiveAt } from "@cerebro/contracts/identity";
import type {
  AuthorizationDecision,
  EntitlementPolicy,
} from "@cerebro/contracts/policy";
import { preflightEffect } from "@cerebro/contracts/port";
import type { ReadOptions } from "@cerebro/contracts/port";
import type { RegisteredTool } from "@cerebro/contracts/tool-service";
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import { Effect, Layer } from "effect";

export interface AgentAuthorityDependencies {
  readonly current: AuthorityService;
  readonly entitlements: EntitlementPolicy;
  readonly enabledModels: readonly string[];
  readonly tools: readonly RegisteredTool[];
  // The composition adapter verifies the stored conversation/session owner.
  readonly checkSession: (
    request: AuthorityRequest,
    options: ReadOptions
  ) => Effect.Effect<void, Denied | InvalidInput | Unavailable>;
  readonly now?: () => number;
}

const pinnedDenial = (
  request: AuthorityRequest,
  now: number
): string | undefined => {
  const { address, context, pinnedAgent, resource, tool, model } = request;
  if (
    address.organizationId !== pinnedAgent.organizationId ||
    address.agentId !== pinnedAgent.agentId ||
    resource.organizationId !== address.organizationId ||
    !isExecutionContextActiveAt(context, address.organizationId, now)
  ) {
    return "The company, pinned agent, or execution context does not match the session.";
  }
  if (model !== undefined && model !== pinnedAgent.model) {
    return "The requested model differs from the pinned model.";
  }
  if (
    tool &&
    (resource.kind !== "tool" ||
      resource.id !== tool.id ||
      !pinnedAgent.enabledToolIds.includes(tool.id))
  ) {
    return "The tool is not enabled by the pinned agent.";
  }
  if (
    ["tool", "memory", "artifact"].includes(resource.kind) &&
    !pinnedAgent.grants.some(
      (grant) =>
        grant.action === request.action &&
        grant.resource.kind === resource.kind &&
        grant.resource.id === resource.id &&
        grant.resource.organizationId === resource.organizationId
    )
  ) {
    return "The pinned agent does not grant this resource.";
  }
  if (
    tool &&
    !pinnedAgent.grants.some(
      (grant) =>
        grant.action === "execute" &&
        grant.resource.kind === "tool" &&
        grant.resource.id === tool.connectorId &&
        grant.resource.organizationId === resource.organizationId
    )
  ) {
    return "The pinned agent does not grant this connector.";
  }
  return undefined;
};

const boundedAuthority = (
  program: Effect.Effect<AuthorizationDecision, InvalidInput | Unavailable>,
  options: ReadOptions,
  now: () => number
) =>
  Effect.suspend(() => {
    const preflight = preflightEffect(options, now());
    if (preflight.status !== "ok") {
      return Effect.fail(
        new Unavailable({
          reason:
            "The authority deadline or caller signal prevents evaluation.",
        })
      );
    }
    const bounded = program.pipe(
      Effect.timeoutOrElse({
        duration: Math.max(1, options.deadlineAt - now()),
        orElse: () =>
          Effect.fail(
            new Unavailable({ reason: "Authority deadline exceeded." })
          ),
      })
    );
    const { signal } = options;
    if (!signal) {
      return bounded;
    }
    const cancelled = Effect.callback<never, Unavailable>((resume) => {
      const abort = () =>
        resume(
          Effect.fail(
            new Unavailable({ reason: "Authority evaluation was cancelled." })
          )
        );
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
      }
      return Effect.sync(() => signal.removeEventListener("abort", abort));
    });
    return Effect.raceFirst(bounded, cancelled);
  });

export const createAgentAuthority = (
  dependencies: AgentAuthorityDependencies
): AuthorityService => {
  const now = dependencies.now ?? Date.now;
  const enabledModels = new Set(dependencies.enabledModels);
  const tools = structuredClone(dependencies.tools);
  const configuredDenial = (request: AuthorityRequest): string | undefined => {
    if (request.model && !enabledModels.has(request.model)) {
      return "The pinned model is not configured.";
    }
    if (request.resource.kind === "tool" && !request.tool) {
      return "Tool authority requires trusted registered metadata.";
    }
    if (
      request.tool &&
      !tools.some(
        (tool) =>
          canonicalToolArguments(tool) === canonicalToolArguments(request.tool)
      )
    ) {
      return "The tool registration changed or is not configured.";
    }
    return undefined;
  };
  const service: AuthorityService = {
    evaluate: (input, options) =>
      boundedAuthority(
        Effect.gen(function* evaluate() {
          const request = yield* Effect.try({
            catch: () =>
              new InvalidInput({ reason: "Invalid authority request." }),
            try: () => structuredClone(input),
          });
          const preflight = preflightEffect(options, now());
          if (preflight.status !== "ok") {
            return yield* Effect.fail(
              new Unavailable({
                reason:
                  "reason" in preflight
                    ? preflight.reason
                    : "The request is unavailable.",
              })
            );
          }
          const denial = (reason: string): AuthorizationDecision => ({
            decision: "deny",
            policyVersion: `agent:${request.pinnedAgent.version}`,
            reason,
          });
          const reason =
            pinnedDenial(request, now()) ?? configuredDenial(request);
          if (reason) {
            return denial(reason);
          }
          const session = yield* Effect.result(
            dependencies.checkSession(request, options)
          );
          if (session._tag === "Failure") {
            if (session.failure._tag === "Denied") {
              return denial(session.failure.reason);
            }
            return yield* Effect.fail(session.failure);
          }
          if (request.tool || request.model) {
            const entitled = yield* Effect.tryPromise({
              catch: () =>
                new Unavailable({
                  reason: "Current capabilities are unavailable.",
                }),
              try: (signal) =>
                dependencies.entitlements.check(
                  {
                    agentId: request.pinnedAgent.agentId,
                    organizationId: request.address.organizationId,
                    ...(request.tool
                      ? { kind: "tool" as const, tool: request.tool }
                      : {
                          kind: "model" as const,
                          model: request.model ?? request.pinnedAgent.model,
                        }),
                  },
                  {
                    ...options,
                    signal: options.signal
                      ? AbortSignal.any([signal, options.signal])
                      : signal,
                  }
                ),
            }).pipe(
              Effect.timeoutOrElse({
                duration: Math.max(1, options.deadlineAt - now()),
                orElse: () =>
                  Effect.fail(
                    new Unavailable({
                      reason: "Capability check deadline exceeded.",
                    })
                  ),
              })
            );
            if (entitled.status !== "ok") {
              if (entitled.status === "denied") {
                return denial(entitled.reason);
              }
              return yield* Effect.fail(
                new Unavailable({
                  reason: "Current capabilities are unavailable.",
                })
              );
            }
            if (entitled.value.decision === "deny") {
              return denial(entitled.value.reason);
            }
          }
          const current = yield* dependencies.current.evaluate(
            request,
            options
          );
          if (current.decision === "deny" || !request.tool) {
            return current;
          }
          const connector = yield* dependencies.current.evaluate(
            {
              ...request,
              action: "execute",
              model: undefined,
              resource: { ...request.resource, id: request.tool.connectorId },
              tool: undefined,
            },
            options
          );
          if (connector.decision === "deny") {
            return connector;
          }
          if (connector.policyVersion !== current.policyVersion) {
            return yield* Effect.fail(
              new Unavailable({
                reason: "Authority changed during connector evaluation.",
              })
            );
          }
          return current;
        }),
        options,
        now
      ),
    require: (request, options) =>
      Effect.flatMap(service.evaluate(request, options), (decision) =>
        enforceDecision(request, now(), decision)
      ),
  };
  return service;
};

export const agentAuthorityLayer = (dependencies: AgentAuthorityDependencies) =>
  Layer.succeed(AuthorityService, createAgentAuthority(dependencies));
