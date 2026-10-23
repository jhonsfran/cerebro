import assert from "node:assert/strict";

import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import type { StorageConformanceProvider } from "@earendil-works/pi-durable/testing";

export const assertPartialDeepEqual = (
  actual: unknown,
  expected: unknown
): void => {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual));
    assert.equal(actual.length, expected.length);
    for (const [index, value] of expected.entries()) {
      assertPartialDeepEqual(actual[index], value);
    }
    return;
  }
  if (
    typeof expected === "object" &&
    expected !== null &&
    (Object.getPrototypeOf(expected) === Object.prototype ||
      Object.getPrototypeOf(expected) === null)
  ) {
    assert.ok(typeof actual === "object" && actual !== null);
    assert.equal(Array.isArray(actual), false);
    for (const key of Object.keys(expected)) {
      assert.ok(Object.hasOwn(actual, key), `Missing expected property ${key}`);
      assertPartialDeepEqual(
        Reflect.get(actual, key),
        Reflect.get(expected, key)
      );
    }
    return;
  }
  assert.deepEqual(actual, expected);
};

export const storageConformanceCases = (
  withStorage: StorageConformanceProvider
) =>
  createStorageConformance({
    assertions: {
      deepEqual: assert.deepEqual,
      greaterThan: (actual, expected) => assert.ok(actual > expected),
      ok: assert.ok,
      partialDeepEqual: assertPartialDeepEqual,
      rejects: async (operation, messageIncludes) => {
        await assert.rejects(operation, (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes(messageIncludes));
          return true;
        });
      },
      strictEqual: assert.equal,
    },
    withStorage,
  });
