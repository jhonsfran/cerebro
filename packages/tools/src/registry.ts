import { InvalidInput } from "@cerebro/contracts/failures";
import type { ToolId } from "@cerebro/contracts/identity";
import { connectorFingerprint } from "@cerebro/contracts/tool-service";
import type { RegisteredTool as BoundToolDefinition } from "@cerebro/contracts/tool-service";
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import type { ToolCall, ToolDefinition } from "@cerebro/contracts/tools";
import { Effect } from "effect";
import { z } from "zod";

import { MCP_PROTOCOL_VERSION } from "./mcp-transport.ts";

export type ConnectorTarget =
  | { readonly kind: "mcp-read"; readonly url: string; readonly method: string }
  | {
      readonly kind: "http-write";
      readonly url: string;
      readonly method: string;
    };

export interface ToolRegistration {
  readonly connectorVersion?: string;
  readonly definition: ToolDefinition;
  readonly description: string;
  readonly input: z.ZodType;
  readonly output: z.ZodType;
  readonly normalize?: (input: unknown) => unknown;
  readonly target: ConnectorTarget;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly requiresApproval: boolean;
  // An at-most-once tool is never dispatched again after an interrupted attempt.
  readonly retryMode: "idempotent" | "at-most-once";
}

const freezeJson = (value: unknown): void => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      freezeJson(child);
    }
    Object.freeze(value);
  }
};
const rejectMcpHeaderAnnotations = (value: unknown): void => {
  if (value && typeof value === "object") {
    if (Object.hasOwn(value, "x-mcp-header")) {
      throw new Error(
        "Custom MCP parameter header annotations are unsupported."
      );
    }
    for (const child of Object.values(value)) {
      rejectMcpHeaderAnnotations(child);
    }
  }
};
const mcpProtocolFingerprint = (target: ConnectorTarget) =>
  target.kind === "mcp-read" ? { protocolVersion: MCP_PROTOCOL_VERSION } : {};
const jsonSchema = (schema: z.ZodType) =>
  structuredClone(z.toJSONSchema(schema));

export interface RegisteredTool extends Omit<ToolRegistration, "normalize"> {
  readonly fingerprint: string;
  readonly inputJsonSchema: ReturnType<typeof jsonSchema>;
  readonly prepareArguments: (input: unknown) => unknown;
}
export interface ToolRegistry {
  readonly list: () => readonly RegisteredTool[];
  readonly get: (toolId: ToolId) => RegisteredTool | undefined;
  readonly prepare: (call: ToolCall) => ToolCall;
}

const validateByteBounds = (registration: ToolRegistration): void => {
  for (const size of [
    registration.maxInputBytes,
    registration.maxOutputBytes,
  ]) {
    if (!Number.isSafeInteger(size) || size < 1 || size > 1_048_576) {
      throw new Error(
        "Tool byte bounds must be positive integers at most one MiB."
      );
    }
  }
};

const validateTarget = (
  target: ConnectorTarget,
  definition: ToolDefinition,
  requiresApproval: boolean,
  mode: "local" | "production"
) => {
  const url = new URL(target.url);
  if (url.username || url.password || url.hash || !target.method) {
    throw new Error(
      "Connector target must have no embedded credentials or fragment."
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Connector target must use HTTP or HTTPS.");
  }
  if (mode === "production" && url.protocol !== "https:") {
    throw new Error("Production connectors require HTTPS.");
  }
  if (target.kind === "mcp-read" && definition.effect !== "read") {
    throw new Error("MCP read connectors require read-only tool definitions.");
  }
  if (
    target.kind === "http-write" &&
    (definition.effect !== "write" || !requiresApproval)
  ) {
    throw new Error("Write connectors require write tools with approval.");
  }
};

export const createToolRegistry = (
  registrations: readonly ToolRegistration[],
  mode: "local" | "production"
): ToolRegistry => {
  const entries = new Map<ToolId, RegisteredTool>();
  for (const registration of registrations) {
    const definition = Object.freeze(structuredClone(registration.definition));
    const url = new URL(registration.target.url);
    const target = Object.freeze({
      ...structuredClone(registration.target),
      url: url.href,
    });
    validateTarget(target, definition, registration.requiresApproval, mode);
    validateByteBounds(registration);
    if (
      registration.connectorVersion !== undefined &&
      !registration.connectorVersion.trim()
    ) {
      throw new Error("A configured connector version must be nonempty.");
    }
    if (entries.has(definition.id)) {
      throw new Error("A registry cannot contain duplicate tool IDs.");
    }
    const { input, output, normalize } = registration;
    const { maxInputBytes } = registration;
    const inputJsonSchema = jsonSchema(input);
    if (target.kind === "mcp-read") {
      rejectMcpHeaderAnnotations(inputJsonSchema);
    }
    freezeJson(inputJsonSchema);
    const fingerprint = canonicalToolArguments({
      connectorVersion: registration.connectorVersion ?? definition.version,
      definition,
      input: inputJsonSchema,
      maxInputBytes,
      maxOutputBytes: registration.maxOutputBytes,
      output: jsonSchema(output),
      ...mcpProtocolFingerprint(target),
      requiresApproval: registration.requiresApproval,
      retryMode: registration.retryMode,
      target,
    });
    entries.set(
      definition.id,
      Object.freeze({
        connectorVersion: registration.connectorVersion ?? definition.version,
        definition,
        description: registration.description,
        fingerprint,
        input,
        inputJsonSchema,
        maxInputBytes,
        maxOutputBytes: registration.maxOutputBytes,
        output,
        prepareArguments(inputValue: unknown): unknown {
          if (
            new TextEncoder().encode(canonicalToolArguments(inputValue))
              .byteLength > maxInputBytes
          ) {
            throw new Error("Tool arguments exceed the byte limit.");
          }
          const parsed = input.parse(inputValue);
          const normalized = input.parse(
            normalize ? normalize(parsed) : parsed
          );
          if (
            new TextEncoder().encode(canonicalToolArguments(normalized))
              .byteLength > maxInputBytes
          ) {
            throw new Error("Normalized tool arguments exceed the byte limit.");
          }
          return structuredClone(normalized);
        },
        requiresApproval: registration.requiresApproval,
        retryMode: registration.retryMode,
        target,
      })
    );
  }
  const list = Object.freeze([...entries.values()]);
  return Object.freeze({
    get: (toolId: ToolId) => entries.get(toolId),
    list: () => list,
    prepare(call: ToolCall): ToolCall {
      const entry = entries.get(call.tool.id);
      const definition =
        "connectorFingerprint" in call.tool
          ? Object.fromEntries(
              Object.entries(call.tool).filter(
                ([key]) => key !== "connectorFingerprint"
              )
            )
          : call.tool;
      if (
        !entry ||
        canonicalToolArguments(entry.definition) !==
          canonicalToolArguments(definition)
      ) {
        throw new Error(
          "Tool metadata does not match the registered definition."
        );
      }
      return {
        ...structuredClone(call),
        arguments: entry.prepareArguments(call.arguments),
        tool:
          "connectorFingerprint" in call.tool ? call.tool : entry.definition,
      };
    },
  });
};

export const bindRegisteredTool = (
  entry: RegisteredTool
): Effect.Effect<BoundToolDefinition, InvalidInput> =>
  connectorFingerprint({
    connectorId: entry.definition.connectorId,
    destination: entry.target.url,
    version: entry.connectorVersion ?? entry.definition.version,
  }).pipe(
    Effect.map((fingerprint) => ({
      ...entry.definition,
      connectorFingerprint: fingerprint,
    })),
    Effect.mapError(
      () => new InvalidInput({ reason: "Invalid connector registration." })
    )
  );
