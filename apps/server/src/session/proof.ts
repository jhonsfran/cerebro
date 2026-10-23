import type { EventAddress } from "@cerebro/contracts/events";
import { Denied } from "@cerebro/contracts/failures";
import { id } from "@cerebro/contracts/identity";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import {
  canonicalToolArguments,
  digestToolArguments,
} from "@cerebro/contracts/tools";
import { z } from "zod";

const identifier = z.string().trim().min(1).max(512);
const identitySchema = z.strictObject({
  organizationId: identifier.transform(id.organization),
  ownerPrincipalId: identifier.transform(id.principal),
});
export type SessionIdentity = z.infer<typeof identitySchema>;
const principal = z.strictObject({
  id: identifier.transform(id.principal),
  kind: z.enum(["human", "service", "agent"]),
  organizationId: identifier.transform(id.organization),
  state: z.enum(["active", "disabled"]),
});
export const contextSchema = z.union([
  z.strictObject({ actor: principal }),
  z.strictObject({
    actor: principal,
    delegation: z.strictObject({
      actorId: identifier.transform(id.principal),
      expiresAt: z.number().finite(),
      id: identifier.transform(id.delegation),
      organizationId: identifier.transform(id.organization),
      representedId: identifier.transform(id.principal),
    }),
    represented: principal,
  }),
]);
const proofSchema = z.strictObject({
  address: z.strictObject({
    agentId: identifier.transform(id.agent),
    conversationId: identifier.transform(id.conversation),
    organizationId: identifier.transform(id.organization),
    sessionId: identifier.transform(id.session),
  }),
  context: contextSchema,
  digest: z.string(),
  expiresAt: z.number().finite(),
  identity: identitySchema,
  path: z.enum([
    "/send",
    "/read",
    "/observe",
    "/decide",
    "/stop",
    "/fork",
    "/control",
  ]),
});
const signedSchema = z.strictObject({
  proof: proofSchema,
  signature: z.string(),
});
const key = (secret: string) =>
  crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"]
  );
const encode = (bytes: Uint8Array) => btoa(String.fromCodePoint(...bytes));
const sign = async (secret: string, proof: z.infer<typeof proofSchema>) =>
  encode(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await key(secret),
        new TextEncoder().encode(canonicalToolArguments(proof))
      )
    )
  );

export const authenticateSessionRequest = async (
  request: Request,
  secret: string,
  identity: SessionIdentity
): Promise<{
  readonly address: EventAddress;
  readonly context: ExecutionContext;
}> => {
  try {
    const signed = signedSchema.parse(
      JSON.parse(request.headers.get("x-cerebro-session-proof") ?? "null")
    );
    const { proof } = signed;
    const signature = Uint8Array.from(
      atob(signed.signature),
      (value) => value.codePointAt(0) ?? 0
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      await key(secret),
      signature,
      new TextEncoder().encode(canonicalToolArguments(proof))
    );
    if (
      !valid ||
      proof.expiresAt <= Date.now() ||
      proof.expiresAt > Date.now() + 60_000 ||
      proof.path !== new URL(request.url).pathname ||
      canonicalToolArguments(proof.identity) !==
        canonicalToolArguments(identity) ||
      proof.address.organizationId !== identity.organizationId ||
      proof.digest !== (await digestToolArguments(await request.clone().text()))
    ) {
      throw new Error("Invalid private session credential");
    }
    return { address: proof.address, context: proof.context };
  } catch {
    throw new Denied({
      code: "unauthorized",
      reason: "The private session credential is invalid.",
    });
  }
};

export const signSessionRequest = async (
  address: EventAddress,
  context: ExecutionContext,
  path: z.infer<typeof proofSchema>["path"],
  body: string,
  secret: string,
  identity: SessionIdentity
): Promise<string> => {
  const proof = {
    address: {
      agentId: address.agentId,
      conversationId: address.conversationId,
      organizationId: address.organizationId,
      sessionId: address.sessionId,
    },
    context,
    digest: await digestToolArguments(body),
    expiresAt: Date.now() + 50_000,
    identity,
    path,
  };
  return JSON.stringify({ proof, signature: await sign(secret, proof) });
};
