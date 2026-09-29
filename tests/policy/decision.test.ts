import assert from "node:assert/strict";
import test from "node:test";

import { id } from "../../packages/contracts/src/identity.ts";
import type {
  DecisionProposal,
  DecisionRequest,
} from "../../packages/contracts/src/policy.ts";
import { createPaidWork } from "../../packages/policy/src/authorization-gate.ts";
import {
  createDecisionRouter,
  createPolicyEventDispatcher,
} from "../../packages/policy/src/decision-router.ts";
import type { ControlEvent } from "../../packages/policy/src/decision-router.ts";
import { createJevAdapter } from "../../packages/policy/src/jev-adapter.ts";
import { createLocalBudget } from "../../packages/policy/src/local-budget.ts";
import { SqliteOperationJournal } from "./fixtures/journal.ts";
import { effect, withJournal, withPolicyFixture } from "./fixtures/policy.ts";

const authorization = {
  evaluate: () =>
    Promise.resolve({
      status: "ok" as const,
      value: { decision: "allow" as const, policyVersion: "fixture" },
    }),
};
const entitlements = {
  check: () =>
    Promise.resolve({
      status: "ok" as const,
      value: { decision: "allow" as const, policyVersion: "fixture" },
    }),
};
const requestFor = (
  organizationId: DecisionRequest["organizationId"]
): DecisionRequest => ({
  allowedChoices: ["run", "defer"],
  eventSummary: "Local fixture request.",
  inputDigest: id.digest("input-fixture"),
  modelVersion: "jev-1.13.0",
  organizationId,
});
test("actual Jev SDK accepts bounded choices and durable replay does no paid work", async () =>
  await withPolicyFixture(
    async (fixture) =>
      await withJournal<DecisionProposal>(async (path, journal) => {
        await fixture.repository.configureAccount(fixture.organizationId, {
          unit: "usd-cent",
          units: 10,
        });
        const budget = createLocalBudget(fixture.repository, "usd-cent");
        let providerCalls = 0;
        let hardChecks = 0;
        let hardAllowed = true;
        const provider = createJevAdapter({
          apiKey: "local-fixture-only",
          currency: "USD",
          fetch: (_url, init) => {
            providerCalls += 1;
            const wire = JSON.parse(String(init?.body));
            assert.equal(wire.model, "jev-1.13.0");
            assert.deepEqual(Object.keys(wire.questions.next_action.criteria), [
              "run",
              "defer",
            ]);
            assert.equal("maxTokens" in wire, false);
            return Promise.resolve(
              Response.json({
                answers: {
                  next_action: {
                    choice: "run",
                    confidence: 0.8,
                    probabilities: { defer: 0.2, run: 0.8 },
                    type: "choice",
                  },
                },
                model: "jev-1.13.0",
                usage: { input_tokens: 1000, output_tokens: 1 },
              })
            );
          },
          inputUsdPerMillion: 0.042,
          minorUnit: "usd-cent",
          modelVersion: "jev-1.13.0",
          outputUsdPerMillion: 0,
          verifiedPricing: true,
        });
        assert.deepEqual(provider.maximum, { unit: "usd-cent", units: 1 });
        const make = (ledger: SqliteOperationJournal<DecisionProposal>) =>
          createDecisionRouter({
            address: { session: "fixture-session" },
            agentId: fixture.agentId,
            context: fixture.context,
            hardPolicy: () => {
              hardChecks += 1;
              return Promise.resolve(
                hardAllowed
                  ? { status: "ok", value: undefined }
                  : {
                      code: "unauthorized",
                      reason: "Current hard policy rejects run.",
                      status: "denied",
                    }
              );
            },
            paidWork: createPaidWork({
              authorization,
              budget,
              entitlements,
              journal: ledger,
            }),
            provider,
          });
        const request = requestFor(fixture.organizationId);
        const options = effect("decision-accepted");
        const accepted = await make(journal).propose(request, options);
        assert.deepEqual(accepted, {
          status: "ok",
          value: {
            choice: "run",
            inputDigest: "input-fixture",
            modelVersion: "jev-1.13.0",
            usage: { unit: "usd-cent", units: 1 },
          },
        });
        const reopened = new SqliteOperationJournal<DecisionProposal>(
          path,
          "paid-work"
        );
        try {
          assert.deepEqual(
            await make(reopened).propose(request, options),
            accepted
          );
          const result1 = await make(reopened).propose(
            { ...request, eventSummary: "Changed input." },
            options
          );
          assert.equal(result1.status, "conflict");
          hardAllowed = false;
          const result2 = await make(reopened).propose(request, options);
          assert.equal(result2.status, "denied");
        } finally {
          reopened.close();
        }
        assert.equal(providerCalls, 1);
        assert.equal(hardChecks, 3);
        assert.deepEqual(
          await budget.inspect(fixture.organizationId, {
            deadlineAt: Date.now() + 1000,
          }),
          { status: "ok", value: { unit: "usd-cent", units: 9 } }
        );
      })
  ));
test("Jev SDK rejects exact model mismatch with known usage and never retries transport errors", async () => {
  let calls = 0;
  const configuration = {
    apiKey: "local-fixture-only",
    currency: "USD" as const,
    inputUsdPerMillion: 0.042 as const,
    minorUnit: "usd-cent",
    modelVersion: "jev-1.13.0" as const,
    outputUsdPerMillion: 0 as const,
    verifiedPricing: true as const,
  };
  const request = requestFor(id.organization("fixture-company"));
  const wrongModel = createJevAdapter({
    ...configuration,
    fetch: () => {
      calls += 1;
      return Promise.resolve(
        Response.json({
          answers: {
            next_action: {
              choice: "run",
              confidence: 1,
              probabilities: { defer: 0, run: 1 },
              type: "choice",
            },
          },
          model: "jev-latest",
          usage: { input_tokens: 1000, output_tokens: 1 },
        })
      );
    },
  });
  const result = await wrongModel.propose(request, effect("wrong-model"));
  assert.equal(result.result.status, "invalid-input");
  assert.deepEqual(result.usage, {
    incurred: { unit: "usd-cent", units: 1 },
    state: "known",
  });
  const unavailable = createJevAdapter({
    ...configuration,
    fetch: () => {
      calls += 1;
      return Promise.reject(new Error("Local transport fixture."));
    },
  });
  const result3 = await unavailable.propose(
    request,
    effect("transport-failure")
  );
  assert.equal(result3.usage.state, "unknown");
  assert.equal(calls, 2);
  const result4 = await createJevAdapter().propose(
    request,
    effect("unconfigured")
  );
  assert.equal(result4.result.status, "denied");
  const result5 = await wrongModel.propose(
    { ...request, eventSummary: "x".repeat(16_385) },
    effect("oversized")
  );
  assert.equal(result5.result.status, "invalid-input");
  assert.equal(calls, 2);
});
test("same event dispatcher sends user events to decisions and persists controls without paid work", async () =>
  await withPolicyFixture(
    async (fixture) =>
      await withJournal<DecisionProposal>(async (path, journal) => {
        let providerCalls = 0;
        let controlCalls = 0;
        const provider = {
          maximum: { unit: "fixture-units", units: 0 },
          modelVersion: "fixture-no-cost",
          propose: (request: DecisionRequest) => {
            providerCalls += 1;
            const proposal: DecisionProposal = {
              choice: "defer",
              inputDigest: request.inputDigest,
              modelVersion: request.modelVersion,
              usage: { unit: "fixture-units", units: 0 },
            };
            return Promise.resolve({
              result: { status: "ok" as const, value: proposal },
              usage: { incurred: proposal.usage, state: "known" as const },
            });
          },
        };
        const decisions = createDecisionRouter({
          address: { session: "event-fixture" },
          agentId: fixture.agentId,
          context: fixture.context,
          hardPolicy: () => Promise.resolve({ status: "ok", value: undefined }),
          paidWork: createPaidWork({
            authorization,
            budget: fixture.budget,
            entitlements,
            journal,
          }),
          provider,
        });
        const controls = new SqliteOperationJournal<unknown>(path, "controls");
        const make = (ledger: SqliteOperationJournal<unknown>) =>
          createPolicyEventDispatcher({
            context: fixture.context,
            controls: ledger,
            decisions,
            handleControl: (event) => {
              controlCalls += 1;
              return Promise.resolve({
                status: "ok",
                value: { handled: event.type },
              });
            },
            organizationId: fixture.organizationId,
          });
        try {
          const dispatcher = make(controls);
          const result6 = await dispatcher.dispatch(
            {
              event: {
                payload: { text: "Fixture event." },
                type: "user.message",
              },
              request: {
                ...requestFor(fixture.organizationId),
                allowedChoices: ["defer"],
                modelVersion: "fixture-no-cost",
              },
            },
            effect("event-decision")
          );
          assert.equal(result6.status, "ok");
          const events: ControlEvent[] = [
            {
              payload: {
                approvalId: "fixture-approval",
                operationId: id.operation("fixture-tool"),
              },
              type: "approval.granted",
            },
            {
              payload: {
                approvalId: "fixture-approval",
                operationId: id.operation("fixture-tool"),
              },
              type: "approval.rejected",
            },
            {
              payload: { runId: id.run("fixture-run") },
              type: "run.cancelled",
            },
            {
              payload: { principalId: "fixture-principal" },
              type: "identity.revoked",
            },
            {
              payload: { task: "Reconcile known usage." },
              type: "maintenance",
            },
          ];
          const resumed = new SqliteOperationJournal<unknown>(path, "controls");
          try {
            await Promise.all(
              events.map(async (event) => {
                const options = effect(`control-${event.type}`);
                const expected = {
                  status: "ok",
                  value: { kind: "control", value: { handled: event.type } },
                };
                assert.deepEqual(
                  await dispatcher.dispatch({ event }, options),
                  expected
                );
                assert.deepEqual(
                  await make(resumed).dispatch({ event }, options),
                  expected
                );
              })
            );
          } finally {
            resumed.close();
          }
          assert.equal(providerCalls, 1);
          assert.equal(controlCalls, 5);
          assert.deepEqual(
            await fixture.budget.inspect(fixture.organizationId, {
              deadlineAt: Date.now() + 1000,
            }),
            { status: "ok", value: { unit: "fixture-units", units: 10 } }
          );
        } finally {
          controls.close();
        }
      })
  ));
test("caller changes during authorization cannot change decision choices or reserved maximum", async () =>
  await withPolicyFixture(
    async (fixture) =>
      await withJournal<DecisionProposal>(async (_path, journal) => {
        const entered = Promise.withResolvers<boolean>();
        const resume = Promise.withResolvers<boolean>();
        let checks = 0;
        const choices: DecisionRequest["allowedChoices"][number][] = [
          "run",
          "defer",
        ];
        const request = {
          ...requestFor(fixture.organizationId),
          allowedChoices: choices,
        };
        const originalRequest = structuredClone(request);
        const maximum = { unit: "fixture-units", units: 6 };
        let providerCalls = 0;
        const router = createDecisionRouter({
          address: { session: "mutation-fixture" },
          agentId: fixture.agentId,
          context: fixture.context,
          hardPolicy: () => Promise.resolve({ status: "ok", value: undefined }),
          paidWork: createPaidWork({
            authorization: {
              async evaluate() {
                checks += 1;
                if (checks === 1) {
                  entered.resolve(true);
                  await resume.promise;
                }
                return {
                  status: "ok",
                  value: { decision: "allow", policyVersion: "fixture" },
                };
              },
            },
            budget: fixture.budget,
            entitlements,
            journal,
          }),
          provider: {
            maximum,
            modelVersion: "jev-1.13.0",
            propose(observed) {
              providerCalls += 1;
              assert.deepEqual(observed, originalRequest);
              return Promise.resolve({
                result: {
                  status: "ok",
                  value: {
                    choice: "run",
                    inputDigest: observed.inputDigest,
                    modelVersion: observed.modelVersion,
                    usage: { unit: "fixture-units", units: 3 },
                  },
                },
                usage: {
                  incurred: { unit: "fixture-units", units: 3 },
                  state: "known",
                },
              });
            },
          },
        });
        const options = effect("decision-input-mutation");
        const pending = router.propose(request, options);
        await entered.promise;
        choices.splice(0, choices.length, "clarify");
        request.eventSummary = "Changed after dispatch began.";
        maximum.units = 1;
        resume.resolve(true);
        const result7 = await pending;
        assert.equal(result7.status, "ok");
        assert.equal(providerCalls, 1);
        const saved = await journal.read(
          fixture.organizationId,
          options.operationId,
          {
            deadlineAt: Date.now() + 1000,
          }
        );
        assert.equal(saved.status, "ok");
        if (saved.status !== "ok") {
          throw new Error("Expected the saved immutable decision intent.");
        }
        assert.deepEqual(saved.value.intent.request, {
          action: "execute",
          context: fixture.context,
          entitlement: {
            agentId: fixture.agentId,
            capability: "decision",
            model: "jev-1.13.0",
            organizationId: fixture.organizationId,
          },
          input: {
            address: { session: "mutation-fixture" },
            context: fixture.context,
            request: originalRequest,
          },
          maximum: { unit: "fixture-units", units: 6 },
          resource: {
            id: fixture.agentId,
            kind: "agent",
            organizationId: fixture.organizationId,
          },
        });
        assert.deepEqual(
          await fixture.budget.inspect(fixture.organizationId, {
            deadlineAt: Date.now() + 1000,
          }),
          { status: "ok", value: { unit: "fixture-units", units: 7 } }
        );
      })
  ));
