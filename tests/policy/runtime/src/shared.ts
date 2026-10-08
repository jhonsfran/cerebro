import { id } from "@cerebro/contracts/identity";
import type {
  AuthorizationPolicy,
  EntitlementPolicy,
} from "@cerebro/contracts/policy";
import type { EffectOptions } from "@cerebro/contracts/port";
import type { BoundToolCall } from "@cerebro/contracts/tool-service";
import { digestToolArguments } from "@cerebro/contracts/tools";
import type {
  WorkerLoader,
  FetchCapability,
} from "@cerebro/tools/dynamic-worker";
import {
  bindRegisteredTool,
  createToolRegistry,
} from "@cerebro/tools/registry";
import { Effect } from "effect";
import { z } from "zod";

import {
  agentId,
  context,
  organizationId,
  principalId,
} from "./fixture-identity.ts";

export {
  agentId,
  context,
  fixtureToken,
  organizationId,
  principalId,
} from "./fixture-identity.ts";

export interface Environment {
  readonly [key: string]: unknown;
  RUNTIME: DurableObjectNamespace;
  GATEWAY_JOURNAL: DurableObjectNamespace;
  GATEWAY: FetchCapability;
  LOADER: WorkerLoader;
  FIXTURE_URL: string;
}
export const policyVersion = "s4-policy-v1";
export const signerSecret = "s4-local-fixture-capability-signing-secret";
export const gatewayProof = "s4-local-private-gateway-control-proof";
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
export const createAuthorizationPolicy = (
  enabled: () => boolean
): AuthorizationPolicy => ({
  evaluate(caller, _action, resource) {
    if (
      !enabled() ||
      caller.actor.id !== principalId ||
      caller.actor.organizationId !== organizationId ||
      caller.actor.state !== "active" ||
      resource.organizationId !== organizationId ||
      ![
        "controlled_read",
        "controlled_write",
        "s4-connector",
        agentId,
      ].includes(resource.id)
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
});
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
): Promise<{ call: BoundToolCall; options: EffectOptions }> => {
  const entry = registry.get(id.tool(input.tool));
  if (!entry) {
    throw new Error("Fixture tool missing");
  }
  const call: BoundToolCall = {
    agentId,
    arguments: { value: input.value },
    context,
    organizationId,
    runId: id.run(`run:${input.operationId}`),
    tool: await Effect.runPromise(bindRegisteredTool(entry)),
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
export const gatewayObject = (env: Environment) =>
  env.GATEWAY_JOURNAL.get(env.GATEWAY_JOURNAL.idFromName("s4-gateway"));
