/* oxlint-disable promise/avoid-new -- Explicit barriers test transaction serialization. */
import { createStorageConformance } from "@earendil-works/pi-durable/testing";
import { DurableObject } from "cloudflare:workers";

import { database, openStorage } from "./sqlite.mjs";

const emptyValues = new Map();
const fail = (message) => {
  throw new Error(message);
};
const equal = (a, b) => {
  if (Object.is(a, b)) {
    return true;
  }
  if (!a || !b || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return (
    ak.length === bk.length &&
    ak.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]))
  );
};
const subset = (a, b) => {
  if (equal(a, b)) {
    return true;
  }
  if (!a || !b || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  return Object.keys(b).every((k) => Object.hasOwn(a, k) && subset(a[k], b[k]));
};
const assertions = {
  deepEqual: (a, b) => {
    if (!equal(a, b)) {
      fail(`not deeply equal: ${JSON.stringify(a)} / ${JSON.stringify(b)}`);
    }
  },
  greaterThan: (a, b) => {
    if (!(a > b)) {
      fail("not greater");
    }
  },
  ok: (value, message) => {
    if (!value) {
      fail(message ?? "expected truthy");
    }
  },
  partialDeepEqual: (a, b) => {
    if (!subset(a, b)) {
      fail("not partial equal");
    }
  },
  rejects: async (promise, message) => {
    try {
      await promise;
    } catch (error) {
      if (!String(error).includes(message)) {
        fail(`wrong rejection: ${String(error)}`);
      }
      return;
    }
    fail("expected rejection");
  },
  strictEqual: (a, b) => {
    if (!Object.is(a, b)) {
      fail(`not equal: ${String(a)} / ${String(b)}`);
    }
  },
};
export class Qualification extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const index = Number(url.searchParams.get("index"));
    const cases = createStorageConformance({
      assertions,
      withStorage: async (testCase) => {
        const storage = await openStorage(this.ctx.storage);
        try {
          await testCase(storage);
        } finally {
          await storage.close({
            toString: () => "qualification",
            value: (key) => emptyValues.get(key),
          });
        }
      },
    });
    if (url.pathname === "/cases") {
      return Response.json(cases.map((c) => c.name));
    }
    if (url.pathname === "/transaction") {
      const db = database(this.ctx.storage);
      await db.exec("CREATE TABLE cerebro_serial (value INTEGER)");
      await assertions.rejects(
        db.transaction(async (tx) => {
          await tx.run("INSERT INTO cerebro_serial VALUES (?)", 1);
          throw new Error("rollback probe");
        }),
        "rollback probe"
      );
      assertions.deepEqual(await db.all("SELECT * FROM cerebro_serial"), []);
      let entered;
      let release;
      const ready = new Promise((resolve) => {
        entered = resolve;
      });
      const held = db.transaction(async (tx) => {
        await tx.run("INSERT INTO cerebro_serial VALUES (?)", 2);
        await new Promise((resolve) => {
          release = resolve;
          entered();
        });
      });
      await ready;
      const unrelated = db.run("INSERT INTO cerebro_serial VALUES (?)", 3);
      release();
      await held;
      await unrelated;
      assertions.deepEqual(
        await db.all("SELECT * FROM cerebro_serial ORDER BY rowid"),
        [{ value: 2 }, { value: 3 }]
      );
      return Response.json({ rollback: true, serialization: true });
    }
    try {
      await cases[index].run();
      return Response.json({ name: cases[index].name, status: "PASS" });
    } catch (error) {
      return Response.json(
        { name: cases[index]?.name, reason: String(error), status: "FAIL" },
        { status: 500 }
      );
    }
  }
}
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    return env.QUALIFICATION.getByName(
      url.pathname === "/transaction"
        ? "transaction-v2"
        : `case-${url.searchParams.get("index")}`
    ).fetch(request);
  },
};
