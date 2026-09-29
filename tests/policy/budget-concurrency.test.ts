import assert from "node:assert/strict";
import test from "node:test";

import type { Database } from "../../packages/db/src/index.ts";
import { withDatabase } from "../../packages/db/src/index.ts";
import { createUsageRepository } from "../../packages/db/src/repositories/usage.ts";
import { createLocalBudget } from "../../packages/policy/src/local-budget.ts";
import { databaseUrl, effect, withPolicyFixture } from "./fixtures/policy.ts";

test("separate PostgreSQL clients cannot each reserve the same shared capacity", async () =>
  await withPolicyFixture(async ({ organizationId, budget }) => {
    const results = await Promise.all(
      Array.from(
        { length: 8 },
        async (_, index) =>
          await withDatabase(
            { DATABASE_URL: databaseUrl() },
            async (database) =>
              await createLocalBudget(
                createUsageRepository(database),
                "fixture-units"
              ).reserve(
                organizationId,
                { unit: "fixture-units", units: 6 },
                effect(`contender-${organizationId}-${index}`)
              )
          )
      )
    );
    assert.equal(results.filter((result) => result.status === "ok").length, 1);
    assert.equal(
      results.filter((result) => result.status === "denied").length,
      7
    );
    assert.deepEqual(
      await budget.inspect(organizationId, { deadlineAt: Date.now() + 1000 }),
      { status: "ok", value: { unit: "fixture-units", units: 4 } }
    );
  }));
test("reservation and settlement replay survive client reconstruction with immutable snapshots", async () =>
  await withPolicyFixture(async ({ organizationId, budget }) => {
    const options = effect(`reserve-${organizationId}`);
    const reserved = await budget.reserve(
      organizationId,
      { unit: "fixture-units", units: 8 },
      options
    );
    assert.equal(reserved.status, "ok");
    if (reserved.status !== "ok") {
      throw new Error("Expected a reservation.");
    }
    assert.throws(() => {
      Object.assign(reserved.value.maximum, { units: 100 });
    }, TypeError);
    const settlement = effect(`settle-${organizationId}`);
    const result = await budget.settle(
      reserved.value.id,
      { unit: "fixture-units", units: 3 },
      settlement
    );
    assert.equal(result.status, "ok");
    await withDatabase({ DATABASE_URL: databaseUrl() }, async (database) => {
      const reconstructed = createLocalBudget(
        createUsageRepository(database),
        "fixture-units"
      );
      assert.deepEqual(
        await reconstructed.reserve(
          organizationId,
          { unit: "fixture-units", units: 8 },
          options
        ),
        reserved
      );
      assert.deepEqual(
        await reconstructed.settle(
          reserved.value.id,
          { unit: "fixture-units", units: 3 },
          settlement
        ),
        result
      );
      const result1 = await reconstructed.reserve(
        organizationId,
        { unit: "fixture-units", units: 7 },
        options
      );
      assert.equal(result1.status, "conflict");
      const result2 = await reconstructed.release(
        reserved.value.id,
        settlement
      );
      assert.equal(result2.status, "conflict");
      assert.deepEqual(
        await reconstructed.inspect(organizationId, {
          deadlineAt: Date.now() + 1000,
        }),
        { status: "ok", value: { unit: "fixture-units", units: 7 } }
      );
    });
  }));
test("concurrent terminal commands cannot return capacity twice or overspend", async () =>
  await withPolicyFixture(async ({ organizationId, budget }) => {
    const reserved = await budget.reserve(
      organizationId,
      { unit: "fixture-units", units: 10 },
      effect(`reserve-${organizationId}`)
    );
    if (reserved.status !== "ok") {
      throw new Error("Expected a reservation.");
    }
    const result3 = await budget.settle(
      reserved.value.id,
      { unit: "fixture-units", units: 11 },
      effect(`invalid-${organizationId}`)
    );
    assert.equal(result3.status, "invalid-input");
    const commands = await Promise.all(
      ["settle", "release"].map(
        async (kind) =>
          await withDatabase(
            { DATABASE_URL: databaseUrl() },
            async (database) => {
              const independent = createLocalBudget(
                createUsageRepository(database),
                "fixture-units"
              );
              return kind === "settle"
                ? await independent.settle(
                    reserved.value.id,
                    { unit: "fixture-units", units: 5 },
                    effect(`${kind}-${organizationId}`)
                  )
                : await independent.release(
                    reserved.value.id,
                    effect(`${kind}-${organizationId}`)
                  );
            }
          )
      )
    );
    assert.equal(commands.filter((result) => result.status === "ok").length, 1);
    assert.equal(
      commands.filter((result) => result.status === "conflict").length,
      1
    );
    const balance = await budget.inspect(organizationId, {
      deadlineAt: Date.now() + 1000,
    });
    assert.equal(balance.status, "ok");
    if (balance.status === "ok") {
      assert.ok(balance.value.units === 5 || balance.value.units === 10);
    }
    await Promise.all(
      [
        -1,
        Number.POSITIVE_INFINITY,
        Number.NaN,
        Number.MAX_SAFE_INTEGER + 1,
        0.5,
      ].map(async (units) => {
        const result4 = await budget.reserve(
          organizationId,
          { unit: "fixture-units", units },
          effect(`bad-${organizationId}-${String(units)}`)
        );
        assert.equal(result4.status, "invalid-input");
      })
    );
  }));

test("caller amount changes during a blocked transaction cannot change its canonical reservation", async () =>
  await withPolicyFixture(async ({ database, organizationId, budget }) => {
    const entered = Promise.withResolvers<boolean>();
    const resume = Promise.withResolvers<boolean>();
    const blockedDatabase = new Proxy(database, {
      get(target, property, receiver) {
        if (property === "transaction") {
          return async (
            transactionBody: Parameters<Database["transaction"]>[0]
          ) => {
            entered.resolve(true);
            await resume.promise;
            return await target.transaction(transactionBody);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const repository = createUsageRepository(blockedDatabase);
    const maximum = { unit: "fixture-units", units: 8 };
    const options = effect("blocked-reservation-input");
    const pending = repository.reserve(organizationId, maximum, options);
    await entered.promise;
    maximum.units = 1;
    resume.resolve(true);
    const reserved = await pending;
    assert.equal(reserved.status, "ok");
    if (reserved.status !== "ok") {
      throw new Error("Expected the original reservation.");
    }
    assert.deepEqual(reserved.value.maximum, {
      unit: "fixture-units",
      units: 8,
    });
    assert.deepEqual(
      await repository.reserve(
        organizationId,
        { unit: "fixture-units", units: 8 },
        options
      ),
      reserved
    );
    assert.deepEqual(
      await budget.inspect(organizationId, { deadlineAt: Date.now() + 1000 }),
      { status: "ok", value: { unit: "fixture-units", units: 2 } }
    );
  }));
