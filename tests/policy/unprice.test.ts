import assert from "node:assert/strict";
import test from "node:test";

import { createUnpriceAdapter } from "../../packages/policy/src/unprice-adapter.ts";
import type { UnpriceConfiguration } from "../../packages/policy/src/unprice-adapter.ts";
import { effect, withPolicyFixture } from "./fixtures/policy.ts";

const remoteFixture = () => {
  const counts = { end: 0, get: 0, settle: 0, start: 0, usage: 0 };
  let loseStart = false;
  let loseEnd = false;
  let loseSettlement = false;
  let metered = 0;
  const settlementReceipts = new Map<string, unknown>();
  let rejectBudget = false;
  let mismatchedCustomer = false;
  let underfunded = false;
  let run = {
    budgetAmountMinor: 6,
    consumedAmountMinor: 0,
    currency: "USD",
    customerId: "fixture-customer",
    endedAt: null as number | null,
    parentRunId: null,
    remainingAmountMinor: 6,
    runId: "fixture-remote-run",
    status: "running",
    traceId: null,
    workloadId: null,
    workloadType: null,
  };
  const fetch = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const body = request.method === "POST" ? await request.json() : {};
    if (path === "/v1/runs/start") {
      counts.start += 1;
      assert.ok(body.idempotencyKey.startsWith("remote-reserve-"));
      assert.equal(body.customerId, "fixture-customer");
      assert.equal(body.budgetAmountMinor, 6);
      if (loseStart) {
        loseStart = false;
        throw new Error("Start response lost after provider commit.");
      }
      return Response.json({
        ...run,
        ...(rejectBudget ? { status: "budget_exceeded" } : {}),
        ...(mismatchedCustomer ? { customerId: "foreign-customer" } : {}),
      });
    }
    if (path.startsWith("/v1/runs/settle/")) {
      counts.settle += 1;
      assert.equal(body.featureSlug, "fixture-spend");
      assert.equal(body.eventSlug, "fixture-billable");
      assert.deepEqual(body.properties, { amountMinor: 3 });
      let receipt = settlementReceipts.get(body.idempotencyKey);
      if (!receipt) {
        metered += 3;
        run = { ...run, consumedAmountMinor: 3, remainingAmountMinor: 3 };
        receipt = {
          accepted: true,
          fundedAmountMinor: underfunded ? 2 : 3,
          fundingStatus: underfunded ? "partially_funded" : "fully_funded",
          reason: "accepted",
          run,
          unfundedAmountMinor: underfunded ? 1 : 0,
        };
        settlementReceipts.set(body.idempotencyKey, receipt);
      }
      if (loseSettlement) {
        loseSettlement = false;
        throw new Error("Settlement response lost after provider accounting.");
      }
      return Response.json(receipt);
    }
    if (path.startsWith("/v1/runs/get/")) {
      counts.get += 1;
      return Response.json(run);
    }
    if (path.startsWith("/v1/runs/end/")) {
      counts.end += 1;
      run = { ...run, endedAt: Date.now(), status: body.status };
      if (loseEnd) {
        loseEnd = false;
        throw new Error("End response lost after provider commit.");
      }
      return Response.json(run);
    }
    if (path === "/v1/wallet/balance") {
      return Response.json({
        available: {
          amount: "0.12999999",
          currency: "USD",
          display_amount: "$0.12",
          ledger_amount: 12_999_999,
        },
        credits: [],
        currency: "USD",
        held: {
          amount: "0",
          currency: "USD",
          display_amount: "$0",
          ledger_amount: 0,
        },
      });
    }
    if (path === "/v1/access/check") {
      return Response.json({ allowed: true, featureSlug: body.featureSlug });
    }
    if (path === "/v1/usage/record") {
      counts.usage += 1;
      return Response.json({ accepted: true }, { status: 202 });
    }
    throw new Error(`Unexpected SDK route ${path}.`);
  };
  return {
    counts,
    fetch,
    loseEnd: () => {
      loseEnd = true;
    },
    loseSettlement: () => {
      loseSettlement = true;
    },
    loseStart: () => {
      loseStart = true;
    },
    metered: () => metered,
    mismatchedCustomer: () => {
      mismatchedCustomer = true;
    },
    rejectBudget: () => {
      rejectBudget = true;
    },
    underfunded: () => {
      underfunded = true;
    },
  };
};
const configuration = (
  organizationId: string,
  fetch: (input: Request) => Promise<Response>
): UnpriceConfiguration => ({
  companies: {
    [organizationId]: {
      currency: "USD",
      customerId: "fixture-customer",
      featureSlugs: { decision: "fixture-decision" },
      meter: {
        eventSlug: "fixture-billable",
        featureSlug: "fixture-spend",
        properties: (amount) => ({ amountMinor: amount.units }),
        verified: true,
        version: "fixture-meter-v1",
      },
      minorPerUnit: 1,
      unit: "usd-cent",
    },
  },
  fetch,
  token: "local-fixture-only",
});
test("actual Unprice SDK recovers unknown start and resumes recorded settlement after reconstruction", async () =>
  await withPolicyFixture(async (fixture) => {
    const remote = remoteFixture();
    remote.loseStart();
    const config = configuration(fixture.organizationId, remote.fetch);
    const options = effect("remote-reserve");
    const first = createUnpriceAdapter(fixture.repository, config);
    const result1 = await first.budget.reserve(
      fixture.organizationId,
      { unit: "usd-cent", units: 6 },
      options
    );
    assert.equal(result1.status, "unknown-outcome");
    const resumed = createUnpriceAdapter(fixture.repository, config);
    const reserved = await resumed.budget.reserve(
      fixture.organizationId,
      { unit: "usd-cent", units: 6 },
      options
    );
    assert.equal(reserved.status, "ok");
    if (reserved.status !== "ok") {
      throw new Error("Expected a remote reservation.");
    }
    remote.loseEnd();
    const settlement = effect("remote-settle");
    const result2 = await resumed.budget.settle(
      reserved.value.id,
      { unit: "usd-cent", units: 3 },
      settlement
    );
    assert.equal(result2.status, "unknown-outcome");
    assert.equal(
      (
        (await fixture.repository.readRemote(options.operationId)) as {
          phase: string;
        }
      ).phase,
      "end-intent"
    );
    const reconstructed = createUnpriceAdapter(fixture.repository, config);
    const finished = await reconstructed.budget.settle(
      reserved.value.id,
      { unit: "usd-cent", units: 3 },
      settlement
    );
    assert.equal(finished.status, "ok");
    if (finished.status === "ok") {
      assert.equal(finished.value.state, "settled");
    }
    assert.deepEqual(
      await reconstructed.budget.settle(
        reserved.value.id,
        { unit: "usd-cent", units: 3 },
        settlement
      ),
      finished
    );
    const result3 = await reconstructed.budget.settle(
      reserved.value.id,
      { unit: "usd-cent", units: 2 },
      settlement
    );
    assert.equal(result3.status, "conflict");
    const result4 = await reconstructed.exportUsage(
      fixture.organizationId,
      "fixture-billable",
      { amountMinor: 3 },
      effect("duplicate-export")
    );
    assert.equal(result4.status, "invalid-input");
    assert.deepEqual(remote.counts, {
      end: 1,
      get: 2,
      settle: 1,
      start: 2,
      usage: 0,
    });
    assert.deepEqual(
      await reconstructed.budget.inspect(fixture.organizationId, {
        deadlineAt: Date.now() + 1000,
      }),
      { status: "ok", value: { unit: "usd-cent", units: 12 } }
    );
    const result5 = await reconstructed.entitlements.check(
      {
        agentId: fixture.agentId,
        capability: "decision",
        organizationId: fixture.organizationId,
      },
      { deadlineAt: Date.now() + 1000 }
    );
    assert.equal(result5.status, "ok");
  }));
test("authoritative remote commercial denial differs from ambiguous receipts and funding failures", async () => {
  await Promise.all(
    (["rejectBudget", "mismatchedCustomer", "underfunded"] as const).map(
      async (mode) => {
        await withPolicyFixture(async (fixture) => {
          const remote = remoteFixture();
          remote[mode]();
          const adapter = createUnpriceAdapter(
            fixture.repository,
            configuration(fixture.organizationId, remote.fetch)
          );
          const options = effect("remote-reserve");
          const reserved = await adapter.budget.reserve(
            fixture.organizationId,
            { unit: "usd-cent", units: 6 },
            options
          );
          if (mode === "rejectBudget") {
            assert.deepEqual(reserved, {
              code: "budget-exhausted",
              reason: "Unprice denied the requested capacity.",
              status: "denied",
            });
            assert.deepEqual(
              await adapter.budget.reserve(
                fixture.organizationId,
                { unit: "usd-cent", units: 6 },
                options
              ),
              reserved
            );
            assert.equal(remote.counts.start, 1);
          } else if (mode === "mismatchedCustomer") {
            assert.equal(reserved.status, "unknown-outcome");
          } else {
            if (reserved.status !== "ok") {
              throw new Error("Expected reservation.");
            }
            const result6 = await adapter.budget.settle(
              reserved.value.id,
              { unit: "usd-cent", units: 3 },
              effect("remote-settle")
            );
            assert.equal(result6.status, "unknown-outcome");
            assert.equal(remote.counts.end, 0);
          }
        });
      }
    )
  );
});
test("remote known failure ends failed and configuration prevents guessed monetary conversions", async () =>
  await withPolicyFixture(async (fixture) => {
    const remote = remoteFixture();
    const adapter = createUnpriceAdapter(
      fixture.repository,
      configuration(fixture.organizationId, remote.fetch)
    );
    const result7 = await adapter.budget.reserve(
      fixture.organizationId,
      { unit: "credits", units: 6 },
      effect("unsupported")
    );
    assert.equal(result7.status, "invalid-input");
    const result8 = await createUnpriceAdapter(
      fixture.repository
    ).budget.reserve(
      fixture.organizationId,
      { unit: "usd-cent", units: 6 },
      effect("unconfigured")
    );
    assert.equal(result8.status, "denied");
    assert.equal(remote.counts.start, 0);
    const reserveOptions = effect("remote-reserve");
    const reserved = await adapter.budget.reserve(
      fixture.organizationId,
      { unit: "usd-cent", units: 6 },
      reserveOptions
    );
    if (reserved.status !== "ok") {
      throw new Error("Expected a reservation.");
    }
    const settled = await adapter.budget.settle(
      reserved.value.id,
      { unit: "usd-cent", units: 3 },
      effect("remote-failed"),
      "failed"
    );
    assert.equal(settled.status, "ok");
    const state = (await fixture.repository.readRemote(
      reserveOptions.operationId
    )) as {
      run: {
        status: string;
      };
    };
    assert.equal(state.run.status, "failed");
  }));
test("lost settlement receipt repeats its original key and meters incurred usage once", async () =>
  await withPolicyFixture(async (fixture) => {
    const remote = remoteFixture();
    const config = configuration(fixture.organizationId, remote.fetch);
    const reserveOptions = effect("remote-reserve");
    const adapter = createUnpriceAdapter(fixture.repository, config);
    const reserved = await adapter.budget.reserve(
      fixture.organizationId,
      { unit: "usd-cent", units: 6 },
      reserveOptions
    );
    if (reserved.status !== "ok") {
      throw new Error("Expected a remote reservation.");
    }
    remote.loseSettlement();
    const options = effect("lost-settlement");
    const result9 = await adapter.budget.settle(
      reserved.value.id,
      { unit: "usd-cent", units: 3 },
      options
    );
    assert.equal(result9.status, "unknown-outcome");
    const result10 = await createUnpriceAdapter(
      fixture.repository,
      config
    ).budget.settle(reserved.value.id, { unit: "usd-cent", units: 3 }, options);
    assert.equal(result10.status, "ok");
    assert.equal(remote.metered(), 3);
    assert.equal(remote.counts.settle, 2);
    assert.equal(remote.counts.end, 1);
  }));
test("reserve intent rejects currency conversion or meter drift before settlement", async () =>
  await withPolicyFixture(async (fixture) => {
    const remote = remoteFixture();
    const config = configuration(fixture.organizationId, remote.fetch);
    const options = effect("remote-reserve");
    const reserved = await createUnpriceAdapter(
      fixture.repository,
      config
    ).budget.reserve(
      fixture.organizationId,
      { unit: "usd-cent", units: 6 },
      options
    );
    if (reserved.status !== "ok") {
      throw new Error("Expected a remote reservation.");
    }
    const mapping = config.companies[fixture.organizationId];
    if (!mapping) {
      throw new Error("Expected a company mapping.");
    }
    const changed = {
      ...config,
      companies: { [fixture.organizationId]: { ...mapping, minorPerUnit: 2 } },
    };
    const adapter = createUnpriceAdapter(fixture.repository, changed);
    const result11 = await adapter.budget.reserve(
      fixture.organizationId,
      { unit: "usd-cent", units: 6 },
      options
    );
    assert.equal(result11.status, "conflict");
    const result12 = await adapter.budget.settle(
      reserved.value.id,
      { unit: "usd-cent", units: 3 },
      effect("mapping-drift")
    );
    assert.equal(result12.status, "denied");
    assert.equal(remote.counts.settle, 0);
  }));
