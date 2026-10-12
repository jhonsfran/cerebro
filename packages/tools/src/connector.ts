import {
  Denied,
  InvalidInput,
  Unavailable,
  UnknownOutcome,
} from "@cerebro/contracts/failures";
import type { OrganizationId } from "@cerebro/contracts/identity";
import type { EffectOptions } from "@cerebro/contracts/port";
import type {
  BoundToolCall,
  ToolExecutor,
} from "@cerebro/contracts/tool-service";
import type { ToolExecution } from "@cerebro/contracts/tools";
import { Effect } from "effect";

import { readBoundedJson, redactSecrets } from "./bounded-json.ts";
import { callMcpTool } from "./mcp.ts";
import type { RegisteredTool, ToolRegistry } from "./registry.ts";

export interface ConnectorCredentials {
  readonly headers: Readonly<Record<string, string>>;
  readonly secrets: readonly string[];
}
const deadlineSignal = (options: EffectOptions): AbortSignal => {
  const timeout = AbortSignal.timeout(
    Math.max(1, Math.ceil(options.deadlineAt - Date.now()))
  );
  return options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
};
// Every result is redacted, validated, and bounded the same way, whatever the
// protocol that produced it.
const finish = (
  value: unknown,
  entry: RegisteredTool,
  secrets: readonly string[],
  receipt: string | null
): ToolExecution => {
  const validated = entry.output.parse(redactSecrets(value, secrets));
  if (
    new TextEncoder().encode(JSON.stringify(validated)).byteLength >
    entry.maxOutputBytes
  ) {
    throw new Error("Redacted tool output exceeds the byte limit.");
  }
  const safeReceipt = receipt
    ? String(redactSecrets(receipt, secrets)).slice(0, 512)
    : undefined;
  return {
    output: validated,
    ...(safeReceipt ? { providerReceipt: safeReceipt } : {}),
  };
};

const dispatch = async (
  providerFetch: typeof fetch,
  entry: RegisteredTool,
  call: BoundToolCall,
  credentials: ConnectorCredentials,
  options: EffectOptions
): Promise<ToolExecution> => {
  const headers = {
    ...credentials.headers,
    "Idempotency-Key": options.operationId,
    "X-Cerebro-Operation-Id": options.operationId,
  };
  const signal = deadlineSignal(options);
  // Redirects could carry credentials to another origin.
  const fetchWithoutRedirects: typeof fetch = (input, init) =>
    providerFetch(input, { ...init, redirect: "error" });
  if (entry.target.kind === "mcp") {
    const value = await callMcpTool(
      {
        fetch: fetchWithoutRedirects,
        headers,
        maxMessageBytes: entry.maxOutputBytes + 65_536,
        signal,
        url: entry.target.url,
      },
      entry.target.method,
      call.arguments as Record<string, unknown>
    );
    return finish(value, entry, credentials.secrets, null);
  }
  const response = await fetchWithoutRedirects(entry.target.url, {
    body: JSON.stringify({
      arguments: call.arguments,
      operationId: options.operationId,
      tool: entry.target.method,
    }),
    headers: { ...headers, "Content-Type": "application/json" },
    method: "POST",
    signal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Connector provider rejected the operation.");
  }
  return finish(
    await readBoundedJson(response, entry.maxOutputBytes, signal),
    entry,
    credentials.secrets,
    response.headers.get("x-provider-receipt")
  );
};

// Calls one connector with its credentials. Callers check authority and approval
// first. Any failure after the request is sent is an unknown outcome.
export const createConnectorExecutor = (dependencies: {
  readonly registry: ToolRegistry;
  readonly credentials: (
    organizationId: OrganizationId,
    connectorId: string
  ) => Promise<ConnectorCredentials | undefined>;
  readonly fetch?: typeof fetch;
}): ToolExecutor => ({
  execute: (call, options) =>
    Effect.gen(function* executeConnector() {
      const entry = dependencies.registry.get(call.tool.id);
      if (!entry) {
        return yield* Effect.fail(
          new InvalidInput({ reason: "Tool is not registered." })
        );
      }
      const credentials = yield* Effect.tryPromise({
        catch: () =>
          new Unavailable({ reason: "Connector credentials are unavailable." }),
        try: () =>
          dependencies.credentials(call.organizationId, call.tool.connectorId),
      });
      if (!credentials) {
        return yield* Effect.fail(
          new Denied({
            code: "unauthorized",
            reason:
              "Connector credentials are unavailable for this organization.",
          })
        );
      }
      return yield* Effect.tryPromise({
        catch: () =>
          new UnknownOutcome({
            operationId: options.operationId,
            reason: "The connector outcome is unknown after dispatch.",
          }),
        try: () =>
          dispatch(
            dependencies.fetch ?? fetch,
            entry,
            call,
            credentials,
            options
          ),
      });
    }),
});
