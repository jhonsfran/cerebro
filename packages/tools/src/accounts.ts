import { z } from "zod";

import type { ConnectorCredentials } from "./connector.ts";

// Accounts are sealed with AES-GCM. The additional data binds a ciphertext to
// its organization and account, so a sealed value cannot be moved to another row.
const VERSION = "v1";
const credentialsSchema = z.strictObject({
  headers: z.record(z.string(), z.string()),
  secrets: z.array(z.string()),
});
export interface AccountScope {
  readonly organizationId: string;
  readonly accountId: string;
}

// Until the catalog links connectors to accounts, each connector has one account.
export const connectorAccountId = (connectorId: string): string =>
  `connector:${connectorId}`;

const encoder = new TextEncoder();
const aesKey = async (secret: string): Promise<CryptoKey> => {
  if (secret.length < 32) {
    throw new Error("The account key must have at least 32 characters.");
  }
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return await crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
};
const additionalData = (scope: AccountScope) =>
  encoder.encode(JSON.stringify([scope.organizationId, scope.accountId]));
const toBase64 = (bytes: Uint8Array): string =>
  btoa(Array.from(bytes, (byte) => String.fromCodePoint(byte)).join(""));
const fromBase64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (character) => character.codePointAt(0) ?? 0);

export const sealCredentials = async (
  secret: string,
  scope: AccountScope,
  credentials: ConnectorCredentials
): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { additionalData: additionalData(scope), iv, name: "AES-GCM" },
    await aesKey(secret),
    encoder.encode(JSON.stringify(credentialsSchema.parse(credentials)))
  );
  const sealed = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  sealed.set(iv);
  sealed.set(new Uint8Array(ciphertext), iv.byteLength);
  return `${VERSION}.${toBase64(sealed)}`;
};

export const openCredentials = async (
  secret: string,
  scope: AccountScope,
  sealed: string
): Promise<ConnectorCredentials> => {
  const [version, payload] = sealed.split(".");
  if (version !== VERSION || !payload) {
    throw new Error("Unsupported sealed account format.");
  }
  const bytes = fromBase64(payload);
  const plaintext = await crypto.subtle.decrypt(
    {
      additionalData: additionalData(scope),
      iv: bytes.slice(0, 12),
      name: "AES-GCM",
    },
    await aesKey(secret),
    bytes.slice(12)
  );
  return credentialsSchema.parse(
    JSON.parse(new TextDecoder().decode(plaintext))
  );
};
