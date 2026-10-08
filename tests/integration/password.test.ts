import assert from "node:assert/strict";
import { scrypt } from "node:crypto";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  hashPassword,
  verifyPassword,
} from "../../packages/auth/src/password.ts";

const nativeScrypt = promisify(scrypt);
const nativeKey = async (password: string, salt: string): Promise<Buffer> =>
  await nativeScrypt(password.normalize("NFKC"), salt, 64, {
    N: 16_384,
    maxmem: 67_108_864,
    p: 1,
    r: 16,
  });
test("celld password adapter preserves Better Auth's native scrypt hashes", async () => {
  const password = "Cerebro-\u212B-compatibility";
  const salt = "0123456789abcdef0123456789abcdef";
  const native = await nativeKey(password, salt);
  assert.equal(
    await verifyPassword({
      hash: `${salt}:${native.toString("hex")}`,
      password,
    }),
    true
  );
  assert.equal(
    await verifyPassword({
      hash: `${salt}:${native.toString("hex")}`,
      password: "wrong",
    }),
    false
  );
  const hash = await hashPassword(password);
  const [createdSalt, key] = hash.split(":");
  assert.ok(createdSalt);
  const createdKey = await nativeKey(password, createdSalt);
  assert.equal(createdKey.toString("hex"), key);
  assert.equal(
    await verifyPassword({ hash, password: "Cerebro-A\u030A-compatibility" }),
    true
  );
});
test("malformed password hashes fail verification", async () => {
  await Promise.all(
    [
      "",
      "salt:key",
      `${"0".repeat(32)}:00`,
      ":",
      `${"0".repeat(32)}:${"ff".repeat(64)}:extra`,
    ].map(async (hash) => {
      assert.equal(
        await verifyPassword({ hash, password: "Cerebro-test" }),
        false
      );
    })
  );
});
