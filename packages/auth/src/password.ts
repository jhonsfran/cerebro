import { scryptAsync } from "@noble/hashes/scrypt.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

// These parameters and the salt:key format match Better Auth's existing hashes.
const SCRYPT_OPTIONS = {
  N: 16_384,
  dkLen: 64,
  maxmem: 67_108_864,
  p: 1,
  r: 16,
};
const HASH_PATTERN = /^[a-f0-9]{32}:[a-f0-9]{128}$/u;
const derive = (password: string, salt: string): Promise<Uint8Array> =>
  scryptAsync(password.normalize("NFKC"), salt, SCRYPT_OPTIONS);

export const hashPassword = async (password: string): Promise<string> => {
  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const key = await derive(password, salt);
  return `${salt}:${bytesToHex(key)}`;
};
export const verifyPassword = async ({
  hash,
  password,
}: {
  hash: string;
  password: string;
}): Promise<boolean> => {
  if (!HASH_PATTERN.test(hash)) {
    return false;
  }
  const [salt, key] = hash.split(":");
  if (!salt || !key) {
    return false;
  }
  const actual = await derive(password, salt);
  const expected = hexToBytes(key);
  let difference = 0;
  for (const [index, byte] of actual.entries()) {
    // oxlint-disable-next-line no-bitwise -- Compare all fixed-length key bytes without an early return.
    difference |= byte ^ (expected[index] ?? 0);
  }
  return difference === 0;
};
