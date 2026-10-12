import type { OrganizationId } from "@cerebro/contracts/identity";
import { preflightEffect } from "@cerebro/contracts/port";
import type { EffectOptions, PortResult } from "@cerebro/contracts/port";
import {
  canonicalToolArguments,
  digestToolArguments,
  toolCapabilityMatches,
} from "@cerebro/contracts/tools";
import type { ToolCall, ToolExecution } from "@cerebro/contracts/tools";
import { Effect } from "effect";

import { readBoundedJson, redactSecrets } from "./bounded-json.ts";
import { authorizeTool } from "./broker.ts";
import type { ToolAuthority } from "./broker.ts";
import type { CapabilitySigner, GatewayInvocation } from "./capability.ts";
import { mcpToolRequest, readMcpToolResult } from "./mcp-transport.ts";
import type { RegisteredTool, ToolRegistry } from "./registry.ts";
import { bindRegisteredTool } from "./registry.ts";

export interface ConnectorCredentials {
  readonly headers: Readonly<Record<string, string>>;
  readonly secrets: readonly string[];
}
export interface McpGateway {
  readonly fetch: (request: Request) => Promise<Response>;
}
const deadlineSignal = (options: EffectOptions): AbortSignal => {
  const timeout = AbortSignal.timeout(
    Math.max(1, Math.ceil(options.deadlineAt - Date.now()))
  );
  return options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
};
const afterDispatch = (options: EffectOptions): EffectOptions => ({
  deadlineAt: Date.now() + 5000,
  operationId: options.operationId,
  requestDigest: options.requestDigest,
});
const output = async (
  response: Response,
  entry: RegisteredTool,
  secrets: readonly string[],
  operationId: string,
  signal: AbortSignal
): Promise<ToolExecution> => {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Connector provider rejected the operation.");
  }
  const parsed =
    entry.target.kind === "mcp-read"
      ? await readMcpToolResult(
          response,
          entry.maxOutputBytes,
          operationId,
          signal
        )
      : await readBoundedJson(response, entry.maxOutputBytes, signal);
  const validated = entry.output.parse(redactSecrets(parsed, secrets));
  if (
    new TextEncoder().encode(JSON.stringify(validated)).byteLength >
    entry.maxOutputBytes
  ) {
    throw new Error("Redacted tool output exceeds the byte limit.");
  }
  const receipt = response.headers.get("x-provider-receipt");
  const safeReceipt = receipt
    ? String(redactSecrets(receipt, secrets)).slice(0, 512)
    : undefined;
  return {
    output: validated,
    ...(safeReceipt ? { providerReceipt: safeReceipt } : {}),
  };
};

export const createMcpGateway = (
  dependencies: ToolAuthority & {
    readonly registry: ToolRegistry;
    readonly signer: CapabilitySigner;
    readonly audience: string;
    readonly credentials: (
      organizationId: OrganizationId,
      connectorId: string
    ) => Promise<ConnectorCredentials | undefined>;
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
  }
): McpGateway => {
  const now = dependencies.now ?? Date.now;
  const providerFetch = dependencies.fetch ?? fetch;
  const permitted = async (call: ToolCall, options: EffectOptions) => {
    const allowed = await authorizeTool(dependencies, call, options, now());
    if (allowed.status !== "ok") {
      return allowed;
    }
    const entry = dependencies.registry.get(call.tool.id);
    if (!entry) {
      return {
        reason: "Tool is not registered.",
        status: "invalid-input",
      } as const;
    }
    const connector = await dependencies.authorizationPolicy.evaluate(
      call.context,
      "execute",
      {
        id: call.tool.connectorId,
        kind: "tool",
        organizationId: call.organizationId,
      },
      options
    );
    if (connector.status !== "ok") {
      return connector;
    }
    if (connector.value.decision !== "allow") {
      return {
        code: "unauthorized",
        reason: "Current policy denies connector access.",
        status: "denied",
      } as const;
    }
    return {
      status: "ok",
      value: { entry, policyVersion: allowed.value.policyVersion },
    } as const;
  };
  const boundRegistrationMatches = async (
    invocation: GatewayInvocation
  ): Promise<boolean> => {
    if (!("runId" in invocation.call) || !("runId" in invocation.capability)) {
      return true;
    }
    const entry = dependencies.registry.get(invocation.call.tool.id);
    if (!entry) {
      return false;
    }
    const bound = await Effect.runPromise(bindRegisteredTool(entry));
    return (
      invocation.call.runId === invocation.capability.runId &&
      invocation.call.tool.connectorFingerprint ===
        bound.connectorFingerprint &&
      invocation.capability.connectorFingerprint ===
        bound.connectorFingerprint &&
      invocation.capability.policyVersion === invocation.policyVersion
    );
  };
  const beforeDispatch = async (
    call: ToolCall,
    options: EffectOptions,
    policyVersion: string
  ): Promise<PortResult<void>> => {
    const preflight = preflightEffect(options, now());
    if (preflight.status !== "ok") {
      return preflight;
    }
    const current = await permitted(call, options);
    if (current.status !== "ok") {
      return current;
    }
    if (current.value.policyVersion !== policyVersion) {
      return {
        code: "unauthorized",
        reason: "Authority changed before connector dispatch.",
        status: "denied",
      };
    }
    return preflightEffect(options, now());
  };

  const validateRequest = async (request: Request) => {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/invoke"
    ) {
      return Response.json(
        { reason: "Unknown gateway route.", status: "invalid-input" },
        { status: 404 }
      );
    }
    let envelope: unknown;
    try {
      envelope = await readBoundedJson(
        new Response(request.body),
        2_200_000,
        request.signal
      );
    } catch {
      return Response.json(
        { reason: "Invalid capability envelope.", status: "invalid-input" },
        { status: 400 }
      );
    }
    const invocation = await dependencies.signer.verify(envelope);
    if (!invocation || invocation.audience !== dependencies.audience) {
      return Response.json(
        {
          code: "unauthorized",
          reason: "The capability signature or audience is invalid.",
          status: "denied",
        },
        { status: 403 }
      );
    }
    const { capability } = invocation;
    const options = { ...invocation.options, signal: request.signal };
    const preflight = preflightEffect(options, now());
    if (preflight.status !== "ok") {
      return Response.json(preflight);
    }
    let call: ToolCall;
    try {
      call = dependencies.registry.prepare(invocation.call);
      if (
        canonicalToolArguments(call) !== canonicalToolArguments(invocation.call)
      ) {
        throw new Error("Gateway arguments must already be normalized.");
      }
    } catch {
      return Response.json({
        reason: "Registered tool metadata or arguments are invalid.",
        status: "invalid-input",
      });
    }
    if (!(await toolCapabilityMatches(capability, call, options, now()))) {
      return Response.json(
        {
          code: "unauthorized",
          reason: "The capability does not match the tool request.",
          status: "denied",
        },
        { status: 403 }
      );
    }
    if (!(await boundRegistrationMatches(invocation))) {
      return Response.json(
        {
          code: "unauthorized",
          reason: "The bound capability differs from the current registration.",
          status: "denied",
        },
        { status: 403 }
      );
    }
    const allowed = await permitted(call, options);
    if (allowed.status !== "ok") {
      return Response.json(allowed);
    }
    if (
      (await digestToolArguments(allowed.value.entry.fingerprint)) !==
      invocation.registryDigest
    ) {
      return Response.json({
        code: "version-mismatch",
        reason:
          "The signed tool registration differs from the gateway registry.",
        status: "conflict",
      });
    }
    if (allowed.value.policyVersion !== invocation.policyVersion) {
      return Response.json({
        code: "unauthorized",
        reason: "The capability policy version is stale.",
        status: "denied",
      });
    }
    return {
      call,
      entry: allowed.value.entry,
      options,
      policyVersion: invocation.policyVersion,
    };
  };
  return {
    async fetch(request) {
      const validated = await validateRequest(request);
      if (validated instanceof Response) {
        return validated;
      }
      const { call, options, entry, policyVersion } = validated;
      const credentials = await dependencies.credentials(
        call.organizationId,
        call.tool.connectorId
      );
      if (!credentials) {
        return Response.json({
          code: "unauthorized",
          reason:
            "Connector credentials are unavailable for this organization.",
          status: "denied",
        });
      }
      const afterCredentials = await beforeDispatch(
        call,
        options,
        policyVersion
      );
      if (afterCredentials.status !== "ok") {
        return Response.json(afterCredentials);
      }
      // The trusted runtime signs a capability only after approval. Pi never
      // re-dispatches an at-most-once call, so the gateway keeps no journal.
      let result: PortResult<ToolExecution>;
      try {
        const mcp =
          entry.target.kind === "mcp-read"
            ? mcpToolRequest(
                entry.target.method,
                call.arguments,
                options.operationId
              )
            : undefined;
        const body = mcp?.body ?? {
          arguments: call.arguments,
          operationId: options.operationId,
          tool: entry.target.method,
        };
        const providerHeaders = new Headers(credentials.headers);
        for (const [name, value] of Object.entries({
          "Content-Type": "application/json",
          "Idempotency-Key": options.operationId,
          "X-Cerebro-Operation-Id": options.operationId,
          ...mcp?.headers,
        })) {
          providerHeaders.set(name, value);
        }
        const response = await providerFetch(entry.target.url, {
          body: JSON.stringify(body),
          headers: providerHeaders,
          method: "POST",
          redirect: "error",
          signal: deadlineSignal(options),
        });
        result = {
          status: "ok",
          value: await output(
            response,
            entry,
            credentials.secrets,
            options.operationId,
            deadlineSignal(options)
          ),
        };
      } catch {
        result = {
          operationId: options.operationId,
          reason: "The connector outcome is unknown after dispatch.",
          status: "unknown-outcome",
        };
      }
      // A revocation during dispatch withholds the output. A write may already
      // have happened, so it is an unknown outcome, never a definite failure.
      const current = await permitted(call, afterDispatch(options));
      if (current.status === "ok" || result.status !== "ok") {
        return Response.json(result);
      }
      return Response.json(
        call.tool.effect === "write"
          ? {
              operationId: options.operationId,
              reason:
                "Access changed while the connector call ran. Its outcome is unknown.",
              status: "unknown-outcome",
            }
          : current
      );
    },
  };
};
