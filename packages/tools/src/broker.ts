import {
  isExecutionContextActiveAt,
  sameExecutionContext,
} from "@cerebro/contracts/identity";
import type {
  ExecutionContext,
  OperationId,
} from "@cerebro/contracts/identity";
import type { ToolOperationJournal } from "@cerebro/contracts/operation-journal";
import type {
  AuthorizationPolicy,
  EntitlementPolicy,
} from "@cerebro/contracts/policy";
import { preflightEffect } from "@cerebro/contracts/port";
import type {
  EffectOptions,
  PortResult,
  ReadOptions,
} from "@cerebro/contracts/port";
import { approvalMatches, digestToolArguments } from "@cerebro/contracts/tools";
import type {
  ToolCall,
  ToolCapability,
  ToolExecution,
  ToolExecutor,
} from "@cerebro/contracts/tools";
import { z } from "zod";

import { toolCallSchema } from "./capability.ts";
import type { ToolRegistry } from "./registry.ts";

export interface ToolBroker {
  readonly invoke: (
    call: ToolCall,
    options: EffectOptions
  ) => Promise<PortResult<ToolExecution>>;
  readonly reconcile: ToolExecutor["reconcile"];
}
export interface ToolAuthority {
  readonly authorizationPolicy: AuthorizationPolicy;
  readonly entitlementPolicy: EntitlementPolicy;
}
export const authorizeTool = async (
  authority: ToolAuthority,
  call: ToolCall,
  options: ReadOptions,
  now: number
): Promise<PortResult<{ readonly policyVersion: string }>> => {
  if (!isExecutionContextActiveAt(call.context, call.organizationId, now)) {
    return {
      code: "unauthorized",
      reason: "The execution context is inactive.",
      status: "denied",
    };
  }
  const allowed = await authority.authorizationPolicy.evaluate(
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
  const entitled = await authority.entitlementPolicy.check(
    {
      agentId: call.agentId,
      capability: call.tool.id,
      organizationId: call.organizationId,
    },
    options
  );
  if (entitled.status !== "ok") {
    return entitled;
  }
  if (entitled.value.decision !== "allow") {
    return {
      code: "entitlement",
      reason: "This tool capability is not enabled.",
      status: "denied",
    };
  }
  return {
    status: "ok",
    value: { policyVersion: allowed.value.policyVersion },
  };
};
export const checkToolApproval = async (
  journal: ToolOperationJournal,
  call: ToolCall,
  options: EffectOptions,
  policyVersion: string,
  now: number
): Promise<PortResult<void>> => {
  const approval = await journal.approval(
    call.organizationId,
    options.operationId,
    options
  );
  if (approval.status !== "ok") {
    if (approval.status !== "not-found") {
      return approval;
    }
    return {
      code: "approval-required",
      reason: "A bound approval is required.",
      status: "denied",
    };
  }
  const matches = await approvalMatches(
    approval.value,
    {
      ...call,
      argumentDigest: options.requestDigest,
      operationId: options.operationId,
      state: "requested",
    },
    policyVersion,
    now
  );
  return matches
    ? { status: "ok", value: undefined }
    : {
        code: "approval-required",
        reason: "Approval does not match the current tool request.",
        status: "denied",
      };
};
const intentSchema = z.strictObject({
  call: toolCallSchema,
  fingerprint: z.string(),
  kind: z.literal("tool"),
});
const maintenance = (options: EffectOptions, now: number): EffectOptions => ({
  deadlineAt: now + 5000,
  operationId: options.operationId,
  requestDigest: options.requestDigest,
});
export const createToolBroker = (
  dependencies: ToolAuthority & {
    readonly registry: ToolRegistry;
    readonly executor: ToolExecutor;
    readonly journal: ToolOperationJournal;
    readonly now?: () => number;
  }
): ToolBroker => {
  const now = dependencies.now ?? Date.now;
  const prepare = async (input: ToolCall, options: EffectOptions) => {
    let call: ToolCall;
    try {
      call = dependencies.registry.prepare(input);
    } catch {
      return {
        reason: "Tool arguments or metadata are invalid.",
        status: "invalid-input",
      } as const;
    }
    if ((await digestToolArguments(call.arguments)) !== options.requestDigest) {
      return {
        code: "digest-mismatch",
        reason: "The supplied digest does not match normalized arguments.",
        status: "conflict",
      } as const;
    }
    const allowed = await authorizeTool(dependencies, call, options, now());
    if (allowed.status !== "ok") {
      return allowed;
    }
    const entry = dependencies.registry.get(call.tool.id);
    if (entry?.requiresApproval) {
      const approved = await checkToolApproval(
        dependencies.journal,
        call,
        options,
        allowed.value.policyVersion,
        now()
      );
      if (approved.status !== "ok") {
        return approved;
      }
    }
    return {
      status: "ok",
      value: { call, policyVersion: allowed.value.policyVersion },
    } as const;
  };
  return {
    async invoke(input, options) {
      const preflight = preflightEffect(options, now());
      if (preflight.status !== "ok") {
        return preflight;
      }
      const prepared = await prepare(input, options);
      if (prepared.status !== "ok") {
        return prepared;
      }
      const { call } = prepared.value;
      const claim = await dependencies.journal.claim(
        {
          operationId: options.operationId,
          organizationId: call.organizationId,
          request: {
            call,
            fingerprint: dependencies.registry.get(call.tool.id)?.fingerprint,
            kind: "tool",
          },
          requestDigest: options.requestDigest,
        },
        options
      );
      if (claim.status !== "ok") {
        return claim;
      }
      if (claim.value.state === "completed") {
        return structuredClone(claim.value.result);
      }
      if (claim.value.state === "pending") {
        return {
          operationId: options.operationId,
          reason: "This tool operation requires reconciliation.",
          status: "unknown-outcome",
        };
      }
      const { claimToken } = claim.value;
      const dispatched = await dependencies.journal.dispatch(
        claimToken,
        { toolId: call.tool.id },
        options
      );
      if (dispatched.status !== "ok") {
        return dispatched;
      }
      const capability: ToolCapability = {
        ...(call.context.delegation
          ? { delegationId: call.context.delegation.id }
          : {}),
        actorPrincipalId: call.context.actor.id,
        agentId: call.agentId,
        argumentDigest: options.requestDigest,
        connectorId: call.tool.connectorId,
        effect: call.tool.effect,
        expiresAt: Math.min(options.deadlineAt, now() + 60_000),
        operationId: options.operationId,
        organizationId: call.organizationId,
        principalId: call.context.represented?.id ?? call.context.actor.id,
        toolId: call.tool.id,
        toolVersion: call.tool.version,
      };
      let result: PortResult<ToolExecution>;
      try {
        result = await dependencies.executor.execute(call, capability, options);
      } catch {
        result = {
          operationId: options.operationId,
          reason: "The dispatched tool outcome is unknown.",
          status: "unknown-outcome",
        };
      }
      const persistence = maintenance(options, now());
      if (result.status === "unknown-outcome") {
        const saved = await dependencies.journal.unknown(
          claimToken,
          result.reason,
          persistence
        );
        return saved.status === "ok" ? result : saved;
      }
      const saved = await dependencies.journal.complete(
        claimToken,
        result,
        persistence
      );
      if (saved.status !== "ok") {
        return saved;
      }
      const current = await prepare(call, maintenance(options, now()));
      return current.status === "ok" ? structuredClone(result) : current;
    },
    async reconcile(
      operationId: OperationId,
      context: ExecutionContext,
      options: ReadOptions
    ) {
      const record = await dependencies.journal.read(
        context.actor.organizationId,
        operationId,
        options
      );
      if (record.status !== "ok") {
        return record;
      }
      const intent = intentSchema.safeParse(record.value.intent.request);
      if (
        !intent.success ||
        !sameExecutionContext(intent.data.call.context, context)
      ) {
        return {
          code: "unauthorized",
          reason: "The caller does not own this tool operation.",
          status: "denied",
        };
      }
      if (
        intent.data.fingerprint !==
        dependencies.registry.get(intent.data.call.tool.id)?.fingerprint
      ) {
        return {
          code: "version-mismatch",
          reason: "The tool registration changed after dispatch.",
          status: "conflict",
        };
      }
      const effect = {
        ...options,
        operationId,
        requestDigest: record.value.intent.requestDigest,
      };
      const prepared = await prepare(intent.data.call, effect);
      if (prepared.status !== "ok") {
        return prepared;
      }
      if (record.value.state === "completed") {
        return structuredClone(record.value.result);
      }
      const result = await dependencies.executor.reconcile(
        operationId,
        context,
        options
      );
      if (result.status !== "ok") {
        return result;
      }
      const saved = await dependencies.journal.complete(
        record.value.claimToken,
        result,
        maintenance(effect, now())
      );
      return saved.status === "ok" ? result : saved;
    },
  };
};
