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

const isUnexpiredAt = (expiresAt: number, now: number): boolean =>
  Number.isFinite(now) && Number.isFinite(expiresAt) && expiresAt > now;

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
  readonly actorPrincipalId: PrincipalId;
  readonly agentId: AgentId;
  readonly connectorId: string;
  readonly effect: "read" | "write";
  readonly delegationId?: DelegationId;
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
export const approvalMatches = async (
  approval: Approval,
  invocation: ToolInvocation,
  policyVersion: string,
  now: number
): Promise<boolean> => {
  if (
    !isUnexpiredAt(approval.expiresAt, now) ||
    !isExecutionContextActiveAt(
      invocation.context,
      invocation.organizationId,
      now
    ) ||
    approval.organizationId !== invocation.organizationId ||
    approval.operationId !== invocation.operationId ||
    approval.agentId !== invocation.agentId ||
    approval.connectorId !== invocation.tool.connectorId ||
    approval.effect !== invocation.tool.effect ||
    approval.toolId !== invocation.tool.id ||
    approval.toolVersion !== invocation.tool.version ||
    approval.argumentDigest !== invocation.argumentDigest ||
    approval.principalId !==
      (invocation.context.represented?.id ?? invocation.context.actor.id) ||
    approval.actorPrincipalId !== invocation.context.actor.id ||
    approval.delegationId !== invocation.context.delegation?.id ||
    approval.policyVersion !== policyVersion
  ) {
    return false;
  }
  try {
    return (
      (await digestToolArguments(invocation.arguments)) ===
      approval.argumentDigest
    );
  } catch (error) {
    if (error instanceof TypeError) {
      return false;
    }
    throw error;
  }
};

export interface ToolExecution {
  readonly output: unknown;
  readonly providerReceipt?: string;
}
