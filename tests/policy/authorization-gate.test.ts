import assert from "node:assert/strict";
import test from "node:test";

import type { PaidWorkRequest } from "../../packages/policy/src/authorization-gate.ts";
import { createPaidWork } from "../../packages/policy/src/authorization-gate.ts";
import { SqliteOperationJournal } from "./fixtures/journal.ts";
import { effect, withJournal, withPolicyFixture } from "./fixtures/policy.ts";

const allowAuthorization = {
  evaluate: () =>
    Promise.resolve({
      status: "ok" as const,
      value: { decision: "allow" as const, policyVersion: "fixture" },
    }),
};
const allowEntitlements = {
  check: () =>
    Promise.resolve({
      status: "ok" as const,
      value: { decision: "allow" as const, policyVersion: "fixture" },
    }),
};
const invalidWork = () => Promise.reject(new Error("Invalid input dispatch."));
test("current authorization and entitlements deny before budget reservation", async () =>
  await withPolicyFixture(
    async (fixture) =>
      await withJournal<string>(async (_path, journal) => {
        const request: PaidWorkRequest = {
          action: "execute",
          context: fixture.context,
          entitlement: {
            agentId: fixture.agentId,
            capability: "decision",
            organizationId: fixture.organizationId,
          },
          input: { summary: "known local fixture" },
          maximum: { unit: "fixture-units", units: 6 },
          resource: {
            id: fixture.agentId,
            kind: "agent",
            organizationId: fixture.organizationId,
          },
        };
        let calls = 0;
        const deniedWork = () => {
          calls += 1;
          return Promise.resolve({
            result: { status: "ok" as const, value: "bad" },
            usage: {
              incurred: { unit: "fixture-units", units: 1 },
              state: "known" as const,
            },
          });
        };
        await Promise.all(
          ["authorization", "entitlement"].map(async (deniedLayer) => {
            const paid = createPaidWork<string>({
              authorization:
                deniedLayer === "authorization"
                  ? {
                      evaluate: () =>
                        Promise.resolve({
                          status: "ok",
                          value: {
                            decision: "deny",
                            policyVersion: "fixture",
                            reason: "revoked",
                          },
                        }),
                    }
                  : allowAuthorization,
              budget: fixture.budget,
              entitlements:
                deniedLayer === "entitlement"
                  ? {
                      check: () =>
                        Promise.resolve({
                          status: "ok",
                          value: {
                            decision: "deny",
                            policyVersion: "fixture",
                            reason: "not purchased",
                          },
                        }),
                    }
                  : allowEntitlements,
              journal,
            });
            const result = await paid.run(
              request,
              effect(`denied-${deniedLayer}`),
              deniedWork
            );
            assert.equal(result.status, "denied");
          })
        );
        assert.equal(calls, 0);
        assert.deepEqual(
          await fixture.budget.inspect(fixture.organizationId, {
            deadlineAt: Date.now() + 1000,
          }),
          { status: "ok", value: { unit: "fixture-units", units: 10 } }
        );
      })
  ));
test("known incurred failure settles after cancellation and replay never dispatches", async () =>
  await withPolicyFixture(
    async (fixture) =>
      await withJournal<string>(async (path, journal) => {
        const request: PaidWorkRequest = {
          action: "execute",
          context: fixture.context,
          entitlement: {
            agentId: fixture.agentId,
            capability: "decision",
            organizationId: fixture.organizationId,
          },
          input: { summary: "fixture failure" },
          maximum: { unit: "fixture-units", units: 6 },
          resource: {
            id: fixture.agentId,
            kind: "agent",
            organizationId: fixture.organizationId,
          },
        };
        const paid = createPaidWork<string>({
          authorization: allowAuthorization,
          budget: fixture.budget,
          entitlements: allowEntitlements,
          journal,
        });
        const controller = new AbortController();
        const options = effect("known-failure");
        let calls = 0;
        const result = await paid.run(
          request,
          { ...options, signal: controller.signal },
          () => {
            calls += 1;
            controller.abort();
            return Promise.resolve({
              result: {
                code: "cancelled",
                reason: "Canceled after provider usage.",
                status: "unavailable",
              },
              usage: {
                incurred: { unit: "fixture-units", units: 3 },
                state: "known",
              },
            });
          }
        );
        assert.equal(result.status, "unavailable");
        assert.deepEqual(
          await fixture.budget.inspect(fixture.organizationId, {
            deadlineAt: Date.now() + 1000,
          }),
          { status: "ok", value: { unit: "fixture-units", units: 7 } }
        );
        const reopened = new SqliteOperationJournal<string>(path, "paid-work");
        try {
          const resumed = createPaidWork<string>({
            authorization: allowAuthorization,
            budget: fixture.budget,
            entitlements: allowEntitlements,
            journal: reopened,
          });
          assert.deepEqual(
            await resumed.run(request, options, () => {
              calls += 1;
              return Promise.reject(new Error("Duplicate dispatch."));
            }),
            result
          );
          const result1 = await resumed.run(
            { ...request, input: { summary: "changed" } },
            options,
            () => Promise.reject(new Error("Conflict dispatch."))
          );
          assert.equal(result1.status, "conflict");
        } finally {
          reopened.close();
        }
        assert.equal(calls, 1);
      })
  ));
test("exceptions retain maximum and a reconstructed owner cannot dispatch again", async () =>
  await withPolicyFixture(
    async (fixture) =>
      await withJournal<string>(async (path, journal) => {
        const request: PaidWorkRequest = {
          action: "execute",
          context: fixture.context,
          entitlement: {
            agentId: fixture.agentId,
            capability: "decision",
            organizationId: fixture.organizationId,
          },
          input: { summary: "fixture unknown" },
          maximum: { unit: "fixture-units", units: 6 },
          resource: {
            id: fixture.agentId,
            kind: "agent",
            organizationId: fixture.organizationId,
          },
        };
        const dependencies = {
          authorization: allowAuthorization,
          budget: fixture.budget,
          entitlements: allowEntitlements,
          journal,
        };
        let calls = 0;
        const options = effect("unknown-failure");
        const result2 = await createPaidWork<string>(dependencies).run(
          request,
          options,
          () => {
            calls += 1;
            return Promise.reject(new Error("No usage receipt."));
          }
        );
        assert.equal(result2.status, "unknown-outcome");
        const reopened = new SqliteOperationJournal<string>(path, "paid-work");
        try {
          const result3 = await createPaidWork<string>({
            ...dependencies,
            journal: reopened,
          }).run(request, options, () => {
            calls += 1;
            return Promise.reject(new Error("Duplicate dispatch."));
          });
          assert.equal(result3.status, "unknown-outcome");
        } finally {
          reopened.close();
        }
        assert.equal(calls, 1);
        assert.deepEqual(
          await fixture.budget.inspect(fixture.organizationId, {
            deadlineAt: Date.now() + 1000,
          }),
          { status: "ok", value: { unit: "fixture-units", units: 4 } }
        );

        await Promise.all(
          [
            { bad: undefined },
            { bad: Number.POSITIVE_INFINITY },
            new Date(),
          ].map(async (input) => {
            const result4 = await createPaidWork<string>(dependencies).run(
              { ...request, input },
              effect(`bad-${crypto.randomUUID()}`),
              invalidWork
            );
            assert.equal(result4.status, "invalid-input");
          })
        );
      })
  ));
test("recorded known outcome resumes settlement after reconstruction without another provider call", async () =>
  await withPolicyFixture(
    async (fixture) =>
      await withJournal<string>(async (path, journal) => {
        const request: PaidWorkRequest = {
          action: "execute",
          context: fixture.context,
          entitlement: {
            agentId: fixture.agentId,
            capability: "decision",
            organizationId: fixture.organizationId,
          },
          input: { summary: "known outcome with lost settlement" },
          maximum: { unit: "fixture-units", units: 6 },
          resource: {
            id: fixture.agentId,
            kind: "agent",
            organizationId: fixture.organizationId,
          },
        };
        let providerCalls = 0;
        let settlementCalls = 0;
        const budget = {
          ...fixture.budget,
          settle: async (...args: Parameters<typeof fixture.budget.settle>) => {
            settlementCalls += 1;
            if (settlementCalls === 1) {
              return {
                operationId: args[2].operationId,
                reason: "Local settlement response fixture.",
                status: "unknown-outcome" as const,
              };
            }
            return await fixture.budget.settle(...args);
          },
        };
        const options = effect("known-outcome");
        const first = createPaidWork<string>({
          authorization: allowAuthorization,
          budget,
          entitlements: allowEntitlements,
          journal,
        });
        const result5 = await first.run(request, options, () => {
          providerCalls += 1;
          return Promise.resolve({
            result: { status: "ok", value: "durable provider result" },
            usage: {
              incurred: { unit: "fixture-units", units: 3 },
              state: "known",
            },
          });
        });
        assert.equal(result5.status, "unknown-outcome");
        const pending = await journal.read(
          fixture.organizationId,
          options.operationId,
          options
        );
        assert.equal(pending.status, "ok");
        if (pending.status === "ok") {
          assert.equal(pending.value.state, "outcome-recorded");
        }
        const reopened = new SqliteOperationJournal<string>(path, "paid-work");
        try {
          const resumed = createPaidWork<string>({
            authorization: allowAuthorization,
            budget,
            entitlements: allowEntitlements,
            journal: reopened,
          });
          assert.deepEqual(
            await resumed.run(request, options, () => {
              providerCalls += 1;
              return Promise.reject(new Error("Provider replay is forbidden."));
            }),
            { status: "ok", value: "durable provider result" }
          );
        } finally {
          reopened.close();
        }
        const revoked = createPaidWork<string>({
          authorization: {
            evaluate: () =>
              Promise.resolve({
                status: "ok",
                value: {
                  decision: "deny",
                  policyVersion: "revoked",
                  reason: "revoked before recovery",
                },
              }),
          },
          budget,
          entitlements: allowEntitlements,
          journal,
        });
        const result6 = await revoked.run(request, options, () =>
          Promise.reject(new Error("Revoked replay dispatch."))
        );
        assert.equal(result6.status, "denied");
        assert.equal(providerCalls, 1);
        assert.equal(settlementCalls, 2);
        assert.deepEqual(
          await fixture.budget.inspect(fixture.organizationId, {
            deadlineAt: Date.now() + 1000,
          }),
          { status: "ok", value: { unit: "fixture-units", units: 7 } }
        );
      })
  ));
test("reserve intent recovery selects one paid dispatcher across concurrent retries", async () =>
  await withPolicyFixture(
    async (fixture) =>
      await withJournal<string>(async (path, journal) => {
        const request: PaidWorkRequest = {
          action: "execute",
          context: fixture.context,
          entitlement: {
            agentId: fixture.agentId,
            capability: "decision",
            organizationId: fixture.organizationId,
          },
          input: { summary: "unknown reserve fixture" },
          maximum: { unit: "fixture-units", units: 6 },
          resource: {
            id: fixture.agentId,
            kind: "agent",
            organizationId: fixture.organizationId,
          },
        };
        let reserveCalls = 0;
        let workCalls = 0;
        const budget = {
          ...fixture.budget,
          reserve: async (
            ...args: Parameters<typeof fixture.budget.reserve>
          ) => {
            reserveCalls += 1;
            const result = await fixture.budget.reserve(...args);
            return reserveCalls === 1
              ? {
                  operationId: args[2].operationId,
                  reason: "Reserve response lost.",
                  status: "unknown-outcome" as const,
                }
              : result;
          },
        };
        const options = effect("unknown-reserve");
        const make = (ledger: SqliteOperationJournal<string>) =>
          createPaidWork<string>({
            authorization: allowAuthorization,
            budget,
            entitlements: allowEntitlements,
            journal: ledger,
          });
        const work = () => {
          workCalls += 1;
          return Promise.resolve({
            result: { status: "ok" as const, value: "one paid result" },
            usage: {
              incurred: { unit: "fixture-units", units: 2 },
              state: "known" as const,
            },
          });
        };
        const result7 = await make(journal).run(request, options, work);
        assert.equal(result7.status, "unknown-outcome");
        const independent = new SqliteOperationJournal<string>(
          path,
          "paid-work"
        );
        try {
          const results = await Promise.all([
            make(journal).run(request, options, work),
            make(independent).run(request, options, work),
          ]);
          assert.equal(
            results.filter((result) => result.status === "ok").length,
            1
          );
          assert.equal(
            results.filter((result) => result.status === "unknown-outcome")
              .length,
            1
          );
          assert.equal(workCalls, 1);
          assert.deepEqual(
            await make(independent).run(request, options, work),
            { status: "ok", value: "one paid result" }
          );
        } finally {
          independent.close();
        }
        assert.equal(workCalls, 1);
        assert.deepEqual(
          await fixture.budget.inspect(fixture.organizationId, {
            deadlineAt: Date.now() + 1000,
          }),
          { status: "ok", value: { unit: "fixture-units", units: 8 } }
        );
      })
  ));
test("revocation while reserve awaits releases unused capacity before provider dispatch", async () =>
  await withPolicyFixture(
    async (fixture) =>
      await withJournal<string>(async (_path, journal) => {
        const request: PaidWorkRequest = {
          action: "execute",
          context: fixture.context,
          entitlement: {
            agentId: fixture.agentId,
            capability: "decision",
            organizationId: fixture.organizationId,
          },
          input: { summary: "revocation race" },
          maximum: { unit: "fixture-units", units: 6 },
          resource: {
            id: fixture.agentId,
            kind: "agent",
            organizationId: fixture.organizationId,
          },
        };
        let allowed = true;
        let calls = 0;
        const authorization = {
          evaluate: () =>
            Promise.resolve({
              status: "ok" as const,
              value: allowed
                ? { decision: "allow" as const, policyVersion: "fixture" }
                : {
                    decision: "deny" as const,
                    policyVersion: "fixture",
                    reason: "revoked during reserve",
                  },
            }),
        };
        const budget = {
          ...fixture.budget,
          reserve: async (
            ...args: Parameters<typeof fixture.budget.reserve>
          ) => {
            const result = await fixture.budget.reserve(...args);
            allowed = false;
            return result;
          },
        };
        const paid = createPaidWork<string>({
          authorization,
          budget,
          entitlements: allowEntitlements,
          journal,
        });
        const result8 = await paid.run(
          request,
          effect("revoke-reserve"),
          () => {
            calls += 1;
            return Promise.reject(new Error("Revoked provider dispatch."));
          }
        );
        assert.equal(result8.status, "denied");
        assert.equal(calls, 0);
        assert.deepEqual(
          await fixture.budget.inspect(fixture.organizationId, {
            deadlineAt: Date.now() + 1000,
          }),
          { status: "ok", value: { unit: "fixture-units", units: 10 } }
        );
      })
  ));
test("revoked recorded failure still settles before denying its saved output", async () =>
  await withPolicyFixture(
    async (fixture) =>
      await withJournal<string>(async (path, journal) => {
        const request: PaidWorkRequest = {
          action: "execute",
          context: fixture.context,
          entitlement: {
            agentId: fixture.agentId,
            capability: "decision",
            organizationId: fixture.organizationId,
          },
          input: { summary: "failure and revocation" },
          maximum: { unit: "fixture-units", units: 6 },
          resource: {
            id: fixture.agentId,
            kind: "agent",
            organizationId: fixture.organizationId,
          },
        };
        let allowed = true;
        let providerCalls = 0;
        let settleCalls = 0;
        const authorization = {
          evaluate: () =>
            Promise.resolve({
              status: "ok" as const,
              value: allowed
                ? { decision: "allow" as const, policyVersion: "fixture" }
                : {
                    decision: "deny" as const,
                    policyVersion: "fixture",
                    reason: "revoked before accounting recovery",
                  },
            }),
        };
        const budget = {
          ...fixture.budget,
          settle: async (...args: Parameters<typeof fixture.budget.settle>) => {
            settleCalls += 1;
            return settleCalls === 1
              ? {
                  operationId: args[2].operationId,
                  reason: "Settlement receipt unavailable.",
                  status: "unknown-outcome" as const,
                }
              : await fixture.budget.settle(...args);
          },
        };
        const options = effect("revoked-recorded-failure");
        const make = (ledger: SqliteOperationJournal<string>) =>
          createPaidWork<string>({
            authorization,
            budget,
            entitlements: allowEntitlements,
            journal: ledger,
          });
        const result9 = await make(journal).run(request, options, () => {
          providerCalls += 1;
          return Promise.resolve({
            result: {
              code: "provider-unavailable",
              reason: "Private provider failure details.",
              status: "unavailable",
            },
            usage: {
              incurred: { unit: "fixture-units", units: 3 },
              state: "known",
            },
          });
        });
        assert.equal(result9.status, "unknown-outcome");
        allowed = false;
        const reopened = new SqliteOperationJournal<string>(path, "paid-work");
        try {
          assert.deepEqual(
            await make(reopened).run(request, options, () => {
              providerCalls += 1;
              return Promise.reject(new Error("Provider replay is forbidden."));
            }),
            {
              code: "unauthorized",
              reason: "revoked before accounting recovery",
              status: "denied",
            }
          );
        } finally {
          reopened.close();
        }
        assert.equal(providerCalls, 1);
        assert.equal(settleCalls, 2);
        assert.deepEqual(
          await fixture.budget.inspect(fixture.organizationId, {
            deadlineAt: Date.now() + 1000,
          }),
          { status: "ok", value: { unit: "fixture-units", units: 7 } }
        );
      })
  ));
test("unknown committed reserve reconciles after revocation and lost release replay never dispatches", async () =>
  await withPolicyFixture(
    async (fixture) =>
      await withJournal<string>(async (path, journal) => {
        const request: PaidWorkRequest = {
          action: "execute",
          context: fixture.context,
          entitlement: {
            agentId: fixture.agentId,
            capability: "decision",
            organizationId: fixture.organizationId,
          },
          input: { summary: "unknown reserve then revocation" },
          maximum: { unit: "fixture-units", units: 6 },
          resource: {
            id: fixture.agentId,
            kind: "agent",
            organizationId: fixture.organizationId,
          },
        };
        let allowed = true;
        let reserveCalls = 0;
        let releaseCalls = 0;
        let providerCalls = 0;
        const authorization = {
          evaluate: () =>
            Promise.resolve({
              status: "ok" as const,
              value: allowed
                ? { decision: "allow" as const, policyVersion: "fixture" }
                : {
                    decision: "deny" as const,
                    policyVersion: "fixture",
                    reason: "revoked before reserve recovery",
                  },
            }),
        };
        const budget = {
          ...fixture.budget,
          release: async (
            ...args: Parameters<typeof fixture.budget.release>
          ) => {
            releaseCalls += 1;
            const result = await fixture.budget.release(...args);
            return releaseCalls === 1
              ? {
                  operationId: args[1].operationId,
                  reason: "Committed release response lost.",
                  status: "unknown-outcome" as const,
                }
              : result;
          },
          reserve: async (
            ...args: Parameters<typeof fixture.budget.reserve>
          ) => {
            reserveCalls += 1;
            const result = await fixture.budget.reserve(...args);
            if (reserveCalls > 1) {
              assert.equal(args[2].signal, undefined);
            }
            return reserveCalls === 1
              ? {
                  operationId: args[2].operationId,
                  reason: "Committed reserve response lost.",
                  status: "unknown-outcome" as const,
                }
              : result;
          },
        };
        const options = effect("revoked-reserve");
        const make = (ledger: SqliteOperationJournal<string>) =>
          createPaidWork<string>({
            authorization,
            budget,
            entitlements: allowEntitlements,
            journal: ledger,
          });
        const work = () => {
          providerCalls += 1;
          return Promise.reject(new Error("Revoked paid work is forbidden."));
        };
        const result10 = await make(journal).run(request, options, work);
        assert.equal(result10.status, "unknown-outcome");
        allowed = false;
        const result11 = await make(journal).run(request, options, work);
        assert.equal(result11.status, "unknown-outcome");
        const state = await journal.read(
          fixture.organizationId,
          options.operationId,
          options
        );
        assert.equal(state.status, "ok");
        if (state.status === "ok") {
          assert.equal(state.value.state, "release-intent");
        }
        const reopened = new SqliteOperationJournal<string>(path, "paid-work");
        try {
          const result12 = await make(reopened).run(request, options, work);
          assert.equal(result12.status, "denied");
        } finally {
          reopened.close();
        }
        assert.equal(providerCalls, 0);
        assert.equal(reserveCalls, 2);
        assert.equal(releaseCalls, 2);
        assert.deepEqual(
          await fixture.budget.inspect(fixture.organizationId, {
            deadlineAt: Date.now() + 1000,
          }),
          { status: "ok", value: { unit: "fixture-units", units: 10 } }
        );
      })
  ));

test("failed reserve retry cannot complete another owner's dispatched paid work", async () =>
  await withPolicyFixture(
    async (fixture) =>
      await withJournal<string>(async (_path, journal) => {
        const request: PaidWorkRequest = {
          action: "execute",
          context: fixture.context,
          entitlement: {
            agentId: fixture.agentId,
            capability: "decision",
            organizationId: fixture.organizationId,
          },
          input: { summary: "Concurrent configuration failure" },
          maximum: { unit: "fixture-units", units: 6 },
          resource: {
            id: fixture.agentId,
            kind: "agent",
            organizationId: fixture.organizationId,
          },
        };
        const reserved = Promise.withResolvers<boolean>();
        const started = Promise.withResolvers<boolean>();
        const finish = Promise.withResolvers<boolean>();
        const options = effect("reserve-owner-race");
        let reserveCalls = 0;
        let providerCalls = 0;
        const budget = {
          ...fixture.budget,
          reserve: async (
            ...args: Parameters<typeof fixture.budget.reserve>
          ) => {
            reserveCalls += 1;
            if (reserveCalls === 1) {
              reserved.resolve(true);
              return await fixture.budget.reserve(...args);
            }
            await started.promise;
            return {
              code: "entitlement" as const,
              reason: "Retry adapter configuration is unavailable.",
              status: "denied" as const,
            };
          },
        };
        const paid = createPaidWork<string>({
          authorization: allowAuthorization,
          budget,
          entitlements: allowEntitlements,
          journal,
        });
        const first = paid.run(request, options, async () => {
          providerCalls += 1;
          started.resolve(true);
          await finish.promise;
          return {
            result: { status: "ok", value: "authoritative owner result" },
            usage: {
              incurred: { unit: "fixture-units", units: 3 },
              state: "known",
            },
          };
        });
        await reserved.promise;
        const second = await paid.run(request, options, () =>
          Promise.reject(new Error("Retry provider dispatch is forbidden."))
        );
        assert.equal(second.status, "denied");
        finish.resolve(true);
        assert.deepEqual(await first, {
          status: "ok",
          value: "authoritative owner result",
        });
        assert.equal(providerCalls, 1);
        const durable = await journal.read(
          fixture.organizationId,
          options.operationId,
          options
        );
        assert.equal(durable.status, "ok");
        if (durable.status === "ok") {
          assert.equal(durable.value.state, "completed");
        }
        assert.deepEqual(
          await fixture.budget.inspect(fixture.organizationId, {
            deadlineAt: Date.now() + 1000,
          }),
          { status: "ok", value: { unit: "fixture-units", units: 7 } }
        );
      })
  ));
