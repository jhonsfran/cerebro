import { id } from "@cerebro/contracts/identity";
import type { EffectOptions } from "@cerebro/contracts/port";
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import type { ToolCall, ToolCapability } from "@cerebro/contracts/tools";
import { z } from "zod";

const identifier = z.string().min(1).max(512);
const digestSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/u)
  .transform(id.digest);
const principal = z.strictObject({
  id: identifier.transform(id.principal),
  kind: z.enum(["human", "service", "agent"]),
  organizationId: identifier.transform(id.organization),
  state: z.enum(["active", "disabled"]),
});
const delegation = z.strictObject({
  actorId: identifier.transform(id.principal),
  expiresAt: z.number().finite(),
  id: identifier.transform(id.delegation),
  organizationId: identifier.transform(id.organization),
  representedId: identifier.transform(id.principal),
});
const context = z.union([
  z.strictObject({ actor: principal }),
  z.strictObject({ actor: principal, delegation, represented: principal }),
]);
const tool = z.strictObject({
  connectorId: identifier,
  effect: z.enum(["read", "write"]),
  id: identifier.transform(id.tool),
  version: identifier,
});
export const toolCallSchema = z.strictObject({
  agentId: identifier.transform(id.agent),
  arguments: z.unknown(),
  context,
  organizationId: identifier.transform(id.organization),
  tool,
});
const capabilitySchema = z.strictObject({
  actorPrincipalId: identifier.transform(id.principal),
  agentId: identifier.transform(id.agent),
  argumentDigest: digestSchema,
  connectorId: identifier,
  delegationId: identifier.transform(id.delegation).optional(),
  effect: z.enum(["read", "write"]),
  expiresAt: z.number().finite(),
  operationId: identifier.transform(id.operation),
  organizationId: identifier.transform(id.organization),
  principalId: identifier.transform(id.principal),
  toolId: identifier.transform(id.tool),
  toolVersion: identifier,
});
export const invocationSchema = z.strictObject({
  audience: identifier,
  call: toolCallSchema,
  capability: capabilitySchema,
  options: z.strictObject({
    deadlineAt: z.number().finite(),
    operationId: identifier.transform(id.operation),
    requestDigest: digestSchema,
  }),
  policyVersion: identifier,
  registryDigest: digestSchema,
});
export type GatewayInvocation = z.infer<typeof invocationSchema>;
export const signedInvocationSchema = z.strictObject({
  payload: z.string(),
  signature: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type SignedInvocation = z.infer<typeof signedInvocationSchema>;
export interface CapabilitySigner {
  readonly sign: (invocation: GatewayInvocation) => Promise<SignedInvocation>;
  readonly verify: (
    envelope: unknown
  ) => Promise<GatewayInvocation | undefined>;
}
const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
export const createCapabilitySigner = async (
  secret: string
): Promise<CapabilitySigner> => {
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error("A capability signing secret must have at least 32 bytes.");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"]
  );
  return {
    async sign(invocation) {
      const payload = canonicalToolArguments(
        invocationSchema.parse(invocation)
      );
      const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(payload)
      );
      return { payload, signature: hex(new Uint8Array(signature)) };
    },
    async verify(envelope) {
      const parsed = signedInvocationSchema.safeParse(envelope);
      if (!parsed.success) {
        return;
      }
      const signature = new Uint8Array(
        parsed.data.signature
          .match(/.{2}/gu)
          ?.map((byte) => Number.parseInt(byte, 16)) ?? []
      );
      if (
        !(await crypto.subtle.verify(
          "HMAC",
          key,
          signature,
          new TextEncoder().encode(parsed.data.payload)
        ))
      ) {
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(parsed.data.payload);
      } catch {
        return;
      }
      const invocation = invocationSchema.safeParse(payload);
      return invocation.success ? invocation.data : undefined;
    },
  };
};
export const gatewayInvocation = (
  audience: string,
  call: ToolCall,
  capability: ToolCapability,
  options: EffectOptions,
  policyVersion: string,
  registryDigest: GatewayInvocation["registryDigest"]
): GatewayInvocation => ({
  audience,
  call,
  capability,
  options: {
    deadlineAt: options.deadlineAt,
    operationId: options.operationId,
    requestDigest: options.requestDigest,
  },
  policyVersion,
  registryDigest,
});
