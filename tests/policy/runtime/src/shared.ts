import { id } from "@cerebro/contracts/identity";
import type {
  AuthorizationPolicy,
  EntitlementPolicy,
} from "@cerebro/contracts/policy";
import type { EffectOptions } from "@cerebro/contracts/port";
import type { Approval, ToolCall } from "@cerebro/contracts/tools";
import { digestToolArguments } from "@cerebro/contracts/tools";
import type {
  WorkerLoader,
  FetchCapability,
} from "@cerebro/tools/dynamic-worker";
import { createToolRegistry } from "@cerebro/tools/registry";
import { z } from "zod";

export interface Environment {
  RUNTIME: DurableObjectNamespace;
  GATEWAY_JOURNAL: DurableObjectNamespace;
  GATEWAY: FetchCapability;
  LOADER: WorkerLoader;
  FIXTURE_URL: string;
}
export const organizationId = id.organization("s4-company");
export const agentId = id.agent("s4-agent");
export const principalId = id.principal("s4-human");
export const context = {
  actor: {
    id: principalId,
    kind: "human" as const,
    organizationId,
    state: "active" as const,
  },
};
export const policyVersion = "s4-policy-v1";
export const signerSecret = "s4-local-fixture-capability-signing-secret";
export const providerSecret = "s4-provider-secret-never-in-model";
export const audience = "s4-local-gateway";
export const definition = (name: "controlled_read" | "controlled_write") => ({
  connectorId: "s4-connector",
  effect: name === "controlled_read" ? ("read" as const) : ("write" as const),
  id: id.tool(name),
  version: "1",
});
export const registry = createToolRegistry(
  [
    {
      definition: definition("controlled_read"),
      description: "Read controlled fixture data.",
      input: z.strictObject({ value: z.string().max(100) }),
      maxInputBytes: 1024,
      maxOutputBytes: 4096,
      output: z.strictObject({
        secret: z.string(),
        source: z.literal("controlled-read"),
        value: z.string(),
      }),
      requiresApproval: false,
      retryMode: "reconcile-only",
      target: {
        kind: "mcp-read",
        method: "controlled_read",
        url: "https://fixture.invalid/mcp",
      },
    },
    {
      definition: definition("controlled_write"),
      description: "Write controlled fixture data with approval.",
      input: z.strictObject({ value: z.string().max(100) }),
      maxInputBytes: 1024,
      maxOutputBytes: 4096,
      output: z.strictObject({
        receipt: z.string(),
        source: z.literal("controlled-write"),
        value: z.string(),
      }),
      requiresApproval: true,
      retryMode: "reconcile-only",
      target: {
        kind: "fixture-write",
        method: "controlled_write",
        url: "http://fixture:8090/write",
      },
    },
  ],
  "fixture"
);
export const authorizationPolicy: AuthorizationPolicy = {
  evaluate(caller, _action, resource) {
    if (
      caller.actor.organizationId !== organizationId ||
      caller.actor.state !== "active" ||
      resource.organizationId !== organizationId ||
      !["controlled_read", "controlled_write", "s4-connector"].includes(
        resource.id
      )
    ) {
      return Promise.resolve({
        status: "ok",
        value: {
          decision: "deny",
          policyVersion,
          reason: "Fixture grant does not match.",
        },
      });
    }
    return Promise.resolve({
      status: "ok",
      value: { decision: "allow", policyVersion },
    });
  },
};
export const entitlementPolicy: EntitlementPolicy = {
  check(request) {
    return Promise.resolve(
      request.organizationId === organizationId && request.agentId === agentId
        ? { status: "ok", value: { decision: "allow", policyVersion } }
        : {
            status: "ok",
            value: {
              decision: "deny",
              policyVersion,
              reason: "Fixture entitlement does not match.",
            },
          }
    );
  },
};

export const invocationInput = z.strictObject({
  operationId: z.string().min(1).max(200),
  tool: z.enum(["controlled_read", "controlled_write"]),
  value: z.string().max(100).default("runtime-value"),
});
export const invocation = async (
  input: z.infer<typeof invocationInput>
): Promise<{ call: ToolCall; options: EffectOptions }> => {
  const call: ToolCall = {
    agentId,
    arguments: { value: input.value },
    context,
    organizationId,
    tool: definition(input.tool),
  };
  return {
    call,
    options: {
      deadlineAt: Date.now() + 60_000,
      operationId: id.operation(input.operationId),
      requestDigest: await digestToolArguments(call.arguments),
    },
  };
};
export const boundApproval = (
  call: ToolCall,
  options: EffectOptions
): Approval => ({
  actorPrincipalId: principalId,
  agentId,
  approverId: principalId,
  argumentDigest: options.requestDigest,
  connectorId: call.tool.connectorId,
  effect: call.tool.effect,
  expiresAt: Date.now() + 3_600_000,
  id: `approval:${options.operationId}`,
  operationId: options.operationId,
  organizationId,
  policyVersion,
  principalId,
  toolId: call.tool.id,
  toolVersion: call.tool.version,
});
export const gatewayObject = (env: Environment) =>
  env.GATEWAY_JOURNAL.get(env.GATEWAY_JOURNAL.idFromName("s4-gateway"));
