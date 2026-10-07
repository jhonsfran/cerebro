import {
  Conflict,
  Denied,
  InvalidInput,
  NotFound,
  Unavailable,
  UnknownOutcome,
} from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import type { AuthorizationPolicy } from "@cerebro/contracts/policy";
import { preflightEffect } from "@cerebro/contracts/port";
import type { PortResult } from "@cerebro/contracts/port";
import { ToolExecutor as EffectToolExecutor } from "@cerebro/contracts/tool-service";
import {
  canonicalToolArguments,
  digestToolArguments,
  toolCapabilityMatches,
} from "@cerebro/contracts/tools";
import type {
  ToolCall,
  ToolCapability,
  ToolExecution,
  ToolExecutor,
} from "@cerebro/contracts/tools";
import { Effect, Layer } from "effect";
import { z } from "zod";

import { readBoundedJson } from "./bounded-json.ts";
import {
  boundCapabilitySchema,
  boundToolCallSchema,
  toolCallSchema,
  gatewayInvocation,
} from "./capability.ts";
import type { CapabilitySigner } from "./capability.ts";
import type { ToolRegistry } from "./registry.ts";
import { bindRegisteredTool } from "./registry.ts";

export interface FetchCapability {
  readonly fetch: (request: Request | string) => Promise<Response>;
}
export interface RestrictedWorkerCode {
  readonly compatibilityDate: string;
  readonly mainModule: string;
  readonly modules: Record<string, string>;
  readonly globalOutbound: null;
  readonly env: { readonly GATEWAY: FetchCapability };
}
export interface WorkerLoader {
  readonly get: (
    id: string,
    code: () => RestrictedWorkerCode
  ) => { readonly getEntrypoint: () => FetchCapability };
}
const wrapperSource = `export default {
  async fetch(request, env) {
    return await env.GATEWAY.fetch(new Request("https://tool-gateway.invalid/invoke", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: await request.text(), signal: request.signal,
    }));
  },
};`;
const resultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ok"),
    value: z.strictObject({
      output: z.unknown(),
      providerReceipt: z.string().optional(),
    }),
  }),
  z.strictObject({
    code: z.enum([
      "unauthorized",
      "expired-delegation",
      "entitlement",
      "budget-exhausted",
      "approval-required",
    ]),
    reason: z.string(),
    status: z.literal("denied"),
  }),
  z.strictObject({
    code: z.enum(["digest-mismatch", "version-mismatch", "already-final"]),
    reason: z.string(),
    status: z.literal("conflict"),
  }),
  z.strictObject({
    code: z.enum(["provider-unavailable", "deadline-exceeded", "cancelled"]),
    reason: z.string(),
    retryAfter: z.number().optional(),
    status: z.literal("unavailable"),
  }),
  z.strictObject({ resource: z.string(), status: z.literal("not-found") }),
  z.strictObject({ reason: z.string(), status: z.literal("invalid-input") }),
  z.strictObject({
    operationId: z.string().transform((value) => value),
    reason: z.string(),
    reconcileAfter: z.number().optional(),
    status: z.literal("unknown-outcome"),
  }),
]);
const capabilityIsBound = async (
  call: ToolCall,
  capability: ToolCapability,
  registry: ToolRegistry,
  policyVersion: string
): Promise<boolean> => {
  const bound = boundToolCallSchema.safeParse(call);
  if (!bound.success) {
    return toolCallSchema.safeParse(call).success;
  }
  const claims = boundCapabilitySchema.safeParse(capability);
  const entry = registry.get(call.tool.id);
  if (!claims.success || !entry) {
    return false;
  }
  const registered = await Effect.runPromise(bindRegisteredTool(entry));
  return (
    claims.data.runId === bound.data.runId &&
    claims.data.connectorFingerprint === registered.connectorFingerprint &&
    bound.data.tool.connectorFingerprint === registered.connectorFingerprint &&
    claims.data.policyVersion === policyVersion
  );
};

export const createDynamicToolExecutor = (dependencies: {
  readonly loader: WorkerLoader;
  readonly gateway: FetchCapability;
  readonly signer: CapabilitySigner;
  readonly audience: string;
  readonly registry: ToolRegistry;
  readonly authorizationPolicy: AuthorizationPolicy;
  readonly reconcile: ToolExecutor["reconcile"];
  readonly now?: () => number;
}): ToolExecutor => {
  const now = dependencies.now ?? Date.now;
  return {
    async execute(call, capability, options) {
      const preflight = preflightEffect(options, now());
      if (preflight.status !== "ok") {
        return preflight;
      }
      if (!(await toolCapabilityMatches(capability, call, options, now()))) {
        return {
          code: "unauthorized",
          reason: "The capability does not match the normalized call.",
          status: "denied",
        };
      }
      let prepared;
      try {
        prepared = dependencies.registry.prepare(call);
      } catch {
        return {
          reason: "Tool arguments or metadata are invalid.",
          status: "invalid-input",
        };
      }
      if (canonicalToolArguments(prepared) !== canonicalToolArguments(call)) {
        return {
          reason: "Executor arguments must already be normalized.",
          status: "invalid-input",
        };
      }
      const allowed = await dependencies.authorizationPolicy.evaluate(
        call.context,
        "execute",
        {
          id: call.tool.id,
          kind: "tool",
          organizationId: call.organizationId,
        },
        options
      );
      if (allowed.status !== "ok") {
        return allowed;
      }
      if (allowed.value.decision !== "allow") {
        return {
          code: "unauthorized",
          reason: "Current policy denies this tool.",
          status: "denied",
        };
      }
      const registered = dependencies.registry.get(call.tool.id);
      if (!registered) {
        return { reason: "Tool is not registered.", status: "invalid-input" };
      }
      if (
        !(await capabilityIsBound(
          call,
          capability,
          dependencies.registry,
          allowed.value.policyVersion
        ))
      ) {
        return {
          code: "unauthorized",
          reason: "The bound capability or registration is stale.",
          status: "denied",
        };
      }
      const signed = await dependencies.signer.sign(
        gatewayInvocation(
          dependencies.audience,
          call,
          capability,
          options,
          allowed.value.policyVersion,
          await digestToolArguments(registered.fingerprint)
        )
      );
      const worker = dependencies.loader.get("cerebro-tool-wrapper-v1", () => ({
        compatibilityDate: "2026-09-28",
        env: { GATEWAY: dependencies.gateway },
        globalOutbound: null,
        mainModule: "tool.js",
        modules: { "tool.js": wrapperSource },
      }));
      const timeout = AbortSignal.timeout(
        Math.max(1, Math.ceil(options.deadlineAt - now()))
      );
      const signal = options.signal
        ? AbortSignal.any([timeout, options.signal])
        : timeout;
      try {
        const current = await dependencies.authorizationPolicy.evaluate(
          call.context,
          "execute",
          {
            id: call.tool.id,
            kind: "tool",
            organizationId: call.organizationId,
          },
          options
        );
        if (current.status !== "ok") {
          return current;
        }
        if (
          current.value.decision !== "allow" ||
          current.value.policyVersion !== allowed.value.policyVersion
        ) {
          return {
            code: "unauthorized",
            reason: "Authority changed before gateway dispatch.",
            status: "denied",
          };
        }
        const ready = preflightEffect(options, now());
        if (ready.status !== "ok") {
          return ready;
        }
        const response = await worker.getEntrypoint().fetch(
          new Request("https://tool-wrapper.invalid/invoke", {
            body: JSON.stringify(signed),
            headers: { "Content-Type": "application/json" },
            method: "POST",
            signal,
          })
        );
        const entry = dependencies.registry.get(call.tool.id);
        if (!entry) {
          return { reason: "Tool is not registered.", status: "invalid-input" };
        }
        const parsed = resultSchema.parse(
          await readBoundedJson(response, entry.maxOutputBytes + 8192, signal)
        );
        if (parsed.status === "unknown-outcome") {
          return { ...parsed, operationId: options.operationId };
        }
        if (parsed.status !== "ok") {
          return parsed;
        }
        const value: ToolExecution = {
          ...parsed.value,
          output: entry.output.parse(parsed.value.output),
        };
        return { status: "ok", value };
      } catch {
        const result: PortResult<ToolExecution> = {
          operationId: options.operationId,
          reason: "The isolated tool outcome is unknown after dispatch.",
          status: "unknown-outcome",
        };
        return result;
      }
    },
    reconcile: dependencies.reconcile,
  };
};

const effectResult = <A>(
  result: PortResult<A>
): Effect.Effect<A, ContractFailure> => {
  switch (result.status) {
    case "ok": {
      return Effect.succeed(result.value);
    }
    case "denied": {
      return Effect.fail(
        new Denied({
          code:
            result.code === "approval-required"
              ? "approval-required"
              : "unauthorized",
          reason: result.reason,
        })
      );
    }
    case "conflict": {
      return Effect.fail(
        new Conflict({ code: result.code, reason: result.reason })
      );
    }
    case "invalid-input": {
      return Effect.fail(new InvalidInput({ reason: result.reason }));
    }
    case "not-found": {
      return Effect.fail(new NotFound({ resource: result.resource }));
    }
    case "unavailable": {
      return Effect.fail(
        new Unavailable({
          reason: result.reason,
          retryAfter: result.retryAfter,
        })
      );
    }
    case "unknown-outcome": {
      return Effect.fail(
        new UnknownOutcome({
          operationId: result.operationId,
          reason: result.reason,
        })
      );
    }
    default: {
      throw new Error("Invalid gateway result.");
    }
  }
};

export const createDynamicToolExecutorService = (
  dependencies: Parameters<typeof createDynamicToolExecutor>[0]
): EffectToolExecutor => {
  const adapter = createDynamicToolExecutor(dependencies);
  return {
    execute: (call, capability, options) =>
      Effect.tryPromise({
        catch: () =>
          new UnknownOutcome({
            operationId: options.operationId,
            reason: "The gateway did not confirm the tool outcome.",
          }),
        try: (signal) =>
          adapter.execute(call, capability, {
            ...options,
            signal: options.signal
              ? AbortSignal.any([signal, options.signal])
              : signal,
          }),
      }).pipe(Effect.flatMap(effectResult)),
    reconcile: (operationId, context, options) =>
      Effect.tryPromise({
        catch: () =>
          new Unavailable({
            reason: "Provider receipt evidence is unavailable.",
          }),
        try: (signal) =>
          adapter.reconcile(operationId, context, {
            ...options,
            signal: options.signal
              ? AbortSignal.any([signal, options.signal])
              : signal,
          }),
      }).pipe(Effect.flatMap(effectResult)),
  };
};

export const dynamicToolExecutorLayer = (
  dependencies: Parameters<typeof createDynamicToolExecutor>[0]
) =>
  Layer.succeed(
    EffectToolExecutor,
    createDynamicToolExecutorService(dependencies)
  );
