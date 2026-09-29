import { id, isExecutionContextActiveAt } from "@cerebro/contracts/identity";
import { preflightEffect } from "@cerebro/contracts/port";
import type { PortResult } from "@cerebro/contracts/port";
import { toolCapabilityMatches } from "@cerebro/contracts/tools";
import type {
  ToolDefinition,
  ToolExecution,
  ToolExecutor,
} from "@cerebro/contracts/tools";

export interface FixtureToolEnvironment {
  readonly TOOL_GATEWAY: Fetcher;
  readonly TOOL_EFFECT_MODE: "idempotent" | "non-idempotent";
  readonly HOLD_AFTER_EFFECT?: "0" | "1";
}

export const fixturePolicyVersion = "fixture-policy-v1";

export const fixtureTool: ToolDefinition = {
  connectorId: "fixture",
  effect: "write",
  id: id.tool("fixture_effect"),
  version: "1",
};

export const isFixtureInput = (
  value: unknown
): value is { readonly value: "approved-fixture" } =>
  !!value &&
  typeof value === "object" &&
  "value" in value &&
  value.value === "approved-fixture" &&
  Object.keys(value).length === 1;

const unavailable = (): PortResult<never> => ({
  code: "provider-unavailable",
  reason: "Fixture effect gateway is unavailable",
  status: "unavailable",
});

const parseExecution = (value: unknown, operationId: string): ToolExecution => {
  if (
    !value ||
    typeof value !== "object" ||
    !("invocationId" in value) ||
    value.invocationId !== operationId ||
    !("receipt" in value) ||
    typeof value.receipt !== "string"
  ) {
    throw new Error("Fixture effect receipt is invalid");
  }
  return { output: value, providerReceipt: value.receipt };
};

export const createFixtureToolExecutor = (
  environment: FixtureToolEnvironment
): ToolExecutor => ({
  execute: async (call, capability, options) => {
    const preflight = preflightEffect(options, Date.now());
    if (preflight.status !== "ok") {
      return preflight;
    }
    if (
      call.tool.id !== fixtureTool.id ||
      !isFixtureInput(call.arguments) ||
      !(await toolCapabilityMatches(capability, call, options, Date.now()))
    ) {
      return {
        code: "unauthorized",
        reason: "Fixture tool capability does not match the call",
        status: "denied",
      };
    }
    try {
      const response = await environment.TOOL_GATEWAY.fetch(
        new Request("https://tool.internal/effect", {
          body: JSON.stringify({
            digest: options.requestDigest.replace(/^sha256:/u, ""),
            hold: environment.HOLD_AFTER_EFFECT === "1",
            invocationId: options.operationId,
            mode: environment.TOOL_EFFECT_MODE,
            value: call.arguments.value,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        })
      );
      if (!response.ok) {
        return unavailable();
      }
      return {
        status: "ok",
        value: parseExecution(await response.json(), options.operationId),
      };
    } catch {
      return unavailable();
    }
  },
  reconcile: async (operationId, context, options) => {
    if (
      !isExecutionContextActiveAt(
        context,
        context.actor.organizationId,
        Date.now()
      ) ||
      options.deadlineAt <= Date.now()
    ) {
      return {
        code: "unauthorized",
        reason: "Reconciliation context is inactive",
        status: "denied",
      };
    }
    try {
      const response = await environment.TOOL_GATEWAY.fetch(
        new Request(
          `https://tool.internal/effect/${encodeURIComponent(operationId)}`
        )
      );
      if (!response.ok) {
        return unavailable();
      }
      const record: unknown = await response.json();
      if (!record || typeof record !== "object" || !("result" in record)) {
        return { resource: "fixture effect", status: "not-found" };
      }
      if (!record.result) {
        return { resource: "fixture effect", status: "not-found" };
      }
      return {
        status: "ok",
        value: parseExecution(record.result, operationId),
      };
    } catch {
      return unavailable();
    }
  },
});
