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
import { mcpToolRequest, readMcpToolResult } from "./mcp-transport.ts";
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

const dispatch = async (
  providerFetch: typeof fetch,
  entry: RegisteredTool,
  call: BoundToolCall,
  credentials: ConnectorCredentials,
  options: EffectOptions
): Promise<ToolExecution> => {
  const mcp =
    entry.target.kind === "mcp-read"
      ? mcpToolRequest(entry.target.method, call.arguments, options.operationId)
      : undefined;
  const body = mcp?.body ?? {
    arguments: call.arguments,
    operationId: options.operationId,
    tool: entry.target.method,
  };
  const headers = new Headers(credentials.headers);
  for (const [name, value] of Object.entries({
    "Content-Type": "application/json",
    "Idempotency-Key": options.operationId,
    "X-Cerebro-Operation-Id": options.operationId,
    ...mcp?.headers,
  })) {
    headers.set(name, value);
  }
  const response = await providerFetch(entry.target.url, {
    body: JSON.stringify(body),
    headers,
    method: "POST",
    redirect: "error",
    signal: deadlineSignal(options),
  });
  return await output(
    response,
    entry,
    credentials.secrets,
    options.operationId,
    deadlineSignal(options)
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
