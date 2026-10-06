/* oxlint-disable no-redeclare -- Effect service tags and schemas share their TypeScript type name. */
import { Context, Effect } from "effect";

import type { ContractFailure } from "./failures.ts";
import type {
  Digest,
  ExecutionContext,
  OperationId,
  RunId,
} from "./identity.ts";
import type { EffectOptions, ReadOptions } from "./port.ts";
import { approvalMatches, digestToolArguments } from "./tools.ts";
import type {
  Approval,
  ToolCall,
  ToolCapability,
  ToolDefinition,
  ToolExecution,
  ToolInvocation,
} from "./tools.ts";

export interface ConnectorRegistration {
  readonly connectorId: string;
  readonly version: string;
  readonly destination: string;
}
export const connectorFingerprint = (
  registration: ConnectorRegistration
): Effect.Effect<Digest, Error> =>
  Effect.tryPromise({
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
    try: () => digestToolArguments(registration),
  });
export type RegisteredTool = ToolDefinition & {
  readonly connectorFingerprint: Digest;
};
export type BoundToolCall = ToolCall & {
  readonly runId: RunId;
  readonly tool: RegisteredTool;
};
export type BoundCapability = ToolCapability & {
  readonly runId: RunId;
  readonly connectorFingerprint: Digest;
  readonly policyVersion: string;
};
export type BoundApproval = Approval & {
  readonly runId: RunId;
  readonly connectorFingerprint: Digest;
};
export type BoundInvocation = ToolInvocation & {
  readonly runId: RunId;
  readonly tool: RegisteredTool;
};
export const boundApprovalMatches = (
  approval: BoundApproval,
  invocation: BoundInvocation,
  policyVersion: string,
  now: number
): Effect.Effect<boolean, Error> => {
  if (
    approval.runId !== invocation.runId ||
    approval.connectorFingerprint !== invocation.tool.connectorFingerprint
  ) {
    return Effect.succeed(false);
  }
  return Effect.tryPromise({
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
    try: () => approvalMatches(approval, invocation, policyVersion, now),
  });
};
export interface ToolExecutor {
  readonly execute: (
    call: BoundToolCall,
    capability: BoundCapability,
    options: EffectOptions
  ) => Effect.Effect<ToolExecution, ContractFailure>;
  readonly reconcile: (
    operationId: OperationId,
    context: ExecutionContext,
    options: ReadOptions
  ) => Effect.Effect<ToolExecution, ContractFailure>;
}
export const ToolExecutor = Context.GenericTag<ToolExecutor>(
  "@cerebro/ToolExecutor"
);
