import { id, isExecutionContextActiveAt } from "./identity.ts";
import type {
  AgentId,
  DelegationId,
  Digest,
  ExecutionContext,
  OperationId,
  OrganizationId,
  PrincipalId,
  ToolId,
} from "./identity.ts";
import type { EffectOptions, PortResult, ReadOptions } from "./port.ts";

export interface ToolDefinition {
  readonly id: ToolId;
  readonly version: string;
  readonly effect: "read" | "write";
  readonly connectorId: string;
}

export interface ToolCall {
  readonly organizationId: OrganizationId;
  readonly agentId: AgentId;
  readonly tool: ToolDefinition;
  readonly arguments: unknown;
  readonly context: ExecutionContext;
}

export interface ToolCapability {
  readonly organizationId: OrganizationId;
  readonly toolId: ToolId;
  readonly toolVersion: string;
  readonly connectorId: string;
  readonly effect: "read" | "write";
  readonly agentId: AgentId;
  readonly principalId: PrincipalId;
  readonly actorPrincipalId: PrincipalId;
  readonly delegationId?: DelegationId;
  readonly operationId: OperationId;
  readonly argumentDigest: Digest;
  readonly expiresAt: number;
}

// Tool arguments are JSON values. Arrays must be dense. Objects must be plain
// data objects. Object keys use UTF-16 code unit order; array order is retained.
// JSON.stringify encodes primitives, so numeric -0 and 0 have the same digest.
export const canonicalToolArguments = (argumentsValue: unknown): string => {
  const ancestors = new WeakSet<object>();
  const encode = (value: unknown): string => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      return JSON.stringify(value);
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new TypeError("Tool arguments must contain finite JSON numbers.");
      }
      return JSON.stringify(value);
    }
    if (typeof value !== "object") {
      throw new TypeError("Tool arguments must be JSON values.");
    }
    if (ancestors.has(value)) {
      throw new TypeError("Tool arguments must not contain cycles.");
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (Reflect.ownKeys(value).length !== value.length + 1) {
          throw new TypeError(
            "Tool argument arrays must be dense JSON arrays."
          );
        }
        const elements: string[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(
            value,
            String(index)
          );
          if (!descriptor || !("value" in descriptor)) {
            throw new TypeError(
              "Tool argument arrays must be dense JSON arrays."
            );
          }
          elements.push(encode(descriptor.value));
        }
        return `[${elements.join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError(
          "Tool argument objects must be plain JSON objects."
        );
      }
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) => typeof key !== "string")) {
        throw new TypeError("Tool argument objects cannot have symbol keys.");
      }
      const keys = Object.keys(value).toSorted();
      if (keys.length !== ownKeys.length) {
        throw new TypeError(
          "Tool argument objects must contain enumerable data."
        );
      }
      const fields = keys.map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) {
          throw new TypeError("Tool argument objects cannot have accessors.");
        }
        return `${JSON.stringify(key)}:${encode(descriptor.value)}`;
      });
      return `{${fields.join(",")}}`;
    } finally {
      ancestors.delete(value);
    }
  };
  return encode(argumentsValue);
};

export const digestToolArguments = async (
  argumentsValue: unknown
): Promise<Digest> => {
  const canonical = canonicalToolArguments(argumentsValue);
  const bytes = new TextEncoder().encode(canonical);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (const byte of hash) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return id.digest(`sha256:${hex}`);
};

export const toolCapabilityMatches = async (
  capability: ToolCapability,
  call: ToolCall,
  options: EffectOptions,
  now: number
): Promise<boolean> => {
  if (
    !isExecutionContextActiveAt(call.context, call.organizationId, now) ||
    capability.organizationId !== call.organizationId ||
    capability.toolId !== call.tool.id ||
    capability.toolVersion !== call.tool.version ||
    capability.connectorId !== call.tool.connectorId ||
    capability.effect !== call.tool.effect ||
    capability.agentId !== call.agentId ||
    capability.principalId !==
      (call.context.represented?.id ?? call.context.actor.id) ||
    capability.actorPrincipalId !== call.context.actor.id ||
    capability.delegationId !== call.context.delegation?.id ||
    capability.operationId !== options.operationId ||
    capability.argumentDigest !== options.requestDigest ||
    capability.expiresAt <= now
  ) {
    return false;
  }
  try {
    return (
      (await digestToolArguments(call.arguments)) === capability.argumentDigest
    );
  } catch (error) {
    if (error instanceof TypeError) {
      return false;
    }
    throw error;
  }
};

export type ToolInvocation = ToolCall & {
  readonly operationId: OperationId;
  readonly argumentDigest: Digest;
} & (
    | { readonly state: "requested" | "waiting-for-approval" | "running" }
    | {
        readonly state: "succeeded";
        readonly result: unknown;
        readonly providerReceipt?: string;
      }
    | { readonly state: "failed" | "cancelled"; readonly reason: string }
    | { readonly state: "unknown-outcome"; readonly providerReceipt?: string }
  );

export interface Approval {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly operationId: OperationId;
  readonly toolId: ToolId;
  readonly toolVersion: string;
  readonly argumentDigest: Digest;
  readonly principalId: PrincipalId;
  readonly policyVersion: string;
  readonly approverId: PrincipalId;
  readonly expiresAt: number;
}

// The caller must recheck current grants before it uses a matching approval.
export const approvalMatches = (
  approval: Approval,
  invocation: ToolInvocation,
  policyVersion: string,
  now: number
): boolean =>
  isExecutionContextActiveAt(
    invocation.context,
    invocation.organizationId,
    now
  ) &&
  approval.organizationId === invocation.organizationId &&
  approval.operationId === invocation.operationId &&
  approval.toolId === invocation.tool.id &&
  approval.toolVersion === invocation.tool.version &&
  approval.argumentDigest === invocation.argumentDigest &&
  approval.principalId ===
    (invocation.context.represented?.id ?? invocation.context.actor.id) &&
  approval.policyVersion === policyVersion &&
  approval.expiresAt > now;

export interface ToolExecution {
  readonly output: unknown;
  readonly providerReceipt?: string;
}

export interface ToolExecutor {
  // For this port, requestDigest is digestToolArguments(call.arguments).
  readonly execute: (
    call: ToolCall,
    capability: ToolCapability,
    options: EffectOptions
  ) => Promise<PortResult<ToolExecution>>;
  // Reconciliation may inspect a provider receipt. It must not execute the effect again.
  readonly reconcile: (
    operationId: OperationId,
    context: ExecutionContext,
    options: ReadOptions
  ) => Promise<PortResult<ToolExecution>>;
}
