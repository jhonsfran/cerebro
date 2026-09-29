import { sameExecutionContext } from "@cerebro/contracts/identity";
import type { OrganizationId } from "@cerebro/contracts/identity";
import type { ToolOperationJournal } from "@cerebro/contracts/operation-journal";
import { preflightEffect } from "@cerebro/contracts/port";
import type { EffectOptions, PortResult } from "@cerebro/contracts/port";
import {
  canonicalToolArguments,
  digestToolArguments,
  toolCapabilityMatches,
} from "@cerebro/contracts/tools";
import type {
  ToolCall,
  ToolExecution,
  ToolExecutor,
} from "@cerebro/contracts/tools";
import { z } from "zod";

import { readBoundedJson, redactSecrets } from "./bounded-json.ts";
import { authorizeTool, checkToolApproval } from "./broker.ts";
import type { ToolAuthority } from "./broker.ts";
import { toolCallSchema } from "./capability.ts";
import type { CapabilitySigner } from "./capability.ts";
import { mcpToolRequest, readMcpToolResult } from "./mcp-transport.ts";
import type { RegisteredTool, ToolRegistry } from "./registry.ts";

export interface ConnectorCredentials {
  readonly headers: Readonly<Record<string, string>>;
  readonly secrets: readonly string[];
}
export interface McpGateway {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly reconcile: ToolExecutor["reconcile"];
}
const gatewayIntent = z.strictObject({
  call: toolCallSchema,
  fingerprint: z.string(),
  kind: z.literal("gateway"),
});
const deadlineSignal = (options: EffectOptions): AbortSignal => {
  const timeout = AbortSignal.timeout(
    Math.max(1, Math.ceil(options.deadlineAt - Date.now()))
  );
  return options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
};
const persistedOptions = (options: EffectOptions): EffectOptions => ({
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
    readonly journal: ToolOperationJournal;
    readonly approvals: ToolOperationJournal;
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
    if (entry.requiresApproval) {
      const approved = await checkToolApproval(
        dependencies.approvals,
        call,
        options,
        allowed.value.policyVersion,
        now()
      );
      if (approved.status !== "ok") {
        return approved;
      }
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
    return { call, entry: allowed.value.entry, options };
  };
  return {
    async fetch(request) {
      const validated = await validateRequest(request);
      if (validated instanceof Response) {
        return validated;
      }
      const { call, options, entry } = validated;
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
      const claimed = await dependencies.journal.claim(
        {
          operationId: options.operationId,
          organizationId: call.organizationId,
          request: {
            call,
            fingerprint: entry.fingerprint,
            kind: "gateway",
          },
          requestDigest: options.requestDigest,
        },
        options
      );
      if (claimed.status !== "ok") {
        return Response.json(claimed);
      }
      if (claimed.value.state === "completed") {
        return Response.json(claimed.value.result);
      }
      if (claimed.value.state === "pending") {
        return Response.json({
          operationId: options.operationId,
          reason: "The connector dispatch requires reconciliation.",
          status: "unknown-outcome",
        });
      }
      const { claimToken } = claimed.value;
      const dispatched = await dependencies.journal.dispatch(
        claimToken,
        { connectorId: call.tool.connectorId },
        options
      );
      if (dispatched.status !== "ok") {
        return Response.json(dispatched);
      }
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
        const preDispatch = preflightEffect(options, now());
        if (preDispatch.status !== "ok") {
          const saved = await dependencies.journal.complete(
            claimToken,
            preDispatch,
            persistedOptions(options)
          );
          return Response.json(saved.status === "ok" ? preDispatch : saved);
        }
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
      const saved =
        result.status === "unknown-outcome"
          ? await dependencies.journal.unknown(
              claimToken,
              result.reason,
              persistedOptions(options)
            )
          : await dependencies.journal.complete(
              claimToken,
              result,
              persistedOptions(options)
            );
      return Response.json(saved.status === "ok" ? result : saved);
    },
    async reconcile(operationId, context, options) {
      const record = await dependencies.journal.read(
        context.actor.organizationId,
        operationId,
        options
      );
      if (record.status !== "ok") {
        return record;
      }
      const intent = gatewayIntent.safeParse(record.value.intent.request);
      if (
        !intent.success ||
        !sameExecutionContext(intent.data.call.context, context)
      ) {
        return {
          code: "unauthorized",
          reason: "The caller does not own this connector operation.",
          status: "denied",
        };
      }
      if (
        intent.data.fingerprint !==
        dependencies.registry.get(intent.data.call.tool.id)?.fingerprint
      ) {
        return {
          code: "version-mismatch",
          reason: "The connector registration changed after dispatch.",
          status: "conflict",
        };
      }
      const effect = {
        ...options,
        operationId,
        requestDigest: record.value.intent.requestDigest,
      };
      const allowed = await permitted(intent.data.call, effect);
      if (allowed.status !== "ok") {
        return allowed;
      }
      if (record.value.state === "completed") {
        return structuredClone(record.value.result);
      }
      const { entry } = allowed.value;
      if (entry.target.kind !== "fixture-write") {
        return {
          operationId,
          reason: "This connector has no receipt lookup.",
          status: "unknown-outcome",
        };
      }
      const credentials = await dependencies.credentials(
        intent.data.call.organizationId,
        intent.data.call.tool.connectorId
      );
      if (!credentials) {
        return {
          code: "unauthorized",
          reason: "Connector access is unavailable.",
          status: "denied",
        };
      }
      try {
        const url = new URL(entry.target.url);
        url.searchParams.set("operationId", operationId);
        const response = await providerFetch(url, {
          headers: {
            ...credentials.headers,
            "X-Cerebro-Operation-Id": operationId,
          },
          method: "GET",
          redirect: "error",
          signal: deadlineSignal(effect),
        });
        if (response.status === 404) {
          await response.body?.cancel();
          return {
            operationId,
            reason: "The fixture has no confirmed receipt.",
            status: "unknown-outcome",
          };
        }
        const result: PortResult<ToolExecution> = {
          status: "ok",
          value: await output(
            response,
            entry,
            credentials.secrets,
            operationId,
            deadlineSignal(effect)
          ),
        };
        const saved = await dependencies.journal.complete(
          record.value.claimToken,
          result,
          persistedOptions(effect)
        );
        return saved.status === "ok" ? result : saved;
      } catch {
        return {
          operationId,
          reason: "Receipt lookup could not establish the connector outcome.",
          status: "unknown-outcome",
        };
      }
    },
  };
};
