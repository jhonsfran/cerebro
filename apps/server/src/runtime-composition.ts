import { id } from "@cerebro/contracts";
import type { AuthorizationPolicy, ToolExecution } from "@cerebro/contracts";
import { createPaidWork } from "@cerebro/policy/authorization-gate";
import type { SessionLedger, StoredRun } from "@cerebro/runtime/ledger";
import {
  DurableOperationJournal,
  durableJournalDatabase,
} from "@cerebro/runtime/operation-journal";
import type {
  ModelHttpReceipt,
  RuntimePorts,
} from "@cerebro/runtime/runtime-ports";
import { createToolBroker } from "@cerebro/tools/broker";
import { createCapabilitySigner } from "@cerebro/tools/capability";
import { createDynamicToolExecutor } from "@cerebro/tools/dynamic-worker";

import type { WorkerEnv } from "./env.server";
import { createRuntimeRegistry } from "./runtime-configuration";
import {
  checkContentDependencies,
  createCurrentAuthorization,
  createCurrentBudget,
  createCurrentEntitlements,
  createMemoryServices,
  runtimeConfiguration,
} from "./runtime-services";
import { withDatabase } from "./services";

export const GATEWAY_AUDIENCE = "cerebro-trusted-tool-gateway-v1";
export const createRuntimeComposition = async (
  env: WorkerEnv,
  storage: DurableObjectStorage,
  ledger: SessionLedger,
  run: StoredRun
): Promise<RuntimePorts> => {
  const config = runtimeConfiguration(env);
  const model = config.models.find(
    (candidate) => candidate.id === run.agent.model
  );
  if (!model) {
    throw new Error("The pinned model is not configured.");
  }
  const current = createCurrentAuthorization(env);
  const authorization: AuthorizationPolicy = {
    evaluate: async (context, action, resource, options) => {
      if (
        ["tool", "memory", "artifact"].includes(resource.kind) &&
        !(run.agent.grants ?? []).some(
          (grant) =>
            grant.action === action &&
            grant.resource.id === resource.id &&
            grant.resource.kind === resource.kind &&
            grant.resource.organizationId === resource.organizationId
        )
      ) {
        return {
          status: "ok",
          value: {
            decision: "deny",
            policyVersion: `agent:${run.agent.version}`,
            reason: "The pinned agent does not grant this resource.",
          },
        };
      }
      const allowed = await current.evaluate(
        context,
        action,
        resource,
        options
      );
      if (allowed.status !== "ok" || allowed.value.decision !== "allow") {
        return allowed;
      }
      const connectorId =
        resource.kind === "tool" && action === "execute"
          ? config.tools.find((tool) => tool.id === resource.id)?.connectorId
          : undefined;
      if (!connectorId) {
        return allowed;
      }
      const connector = { ...resource, id: connectorId };
      if (
        !(run.agent.grants ?? []).some(
          (grant) =>
            grant.action === "execute" &&
            grant.resource.kind === "tool" &&
            grant.resource.id === connectorId &&
            grant.resource.organizationId === resource.organizationId
        )
      ) {
        return {
          status: "ok",
          value: {
            decision: "deny",
            policyVersion: `agent:${run.agent.version}`,
            reason: "The pinned agent does not grant this connector.",
          },
        };
      }
      return await current.evaluate(context, "execute", connector, options);
    },
  };
  const registry = createRuntimeRegistry({
    ...config,
    tools: config.tools.filter((tool) =>
      run.agent.enabledToolIds.includes(id.tool(tool.id))
    ),
  });
  const database = durableJournalDatabase(storage);
  const journal = new DurableOperationJournal<ToolExecution>(
    database,
    "broker"
  );
  const modelJournal = new DurableOperationJournal<ModelHttpReceipt>(
    database,
    "model"
  );
  const entitlementPolicy = createCurrentEntitlements(env);
  const executor = createDynamicToolExecutor({
    audience: GATEWAY_AUDIENCE,
    authorizationPolicy: authorization,
    gateway: env.TOOL_GATEWAY,
    loader: env.LOADER,
    reconcile: async (operationId, context, options) => {
      const response = await env.TOOL_GATEWAY.fetch(
        new Request("https://gateway.internal/reconcile", {
          body: JSON.stringify({
            context,
            operationId,
            options: { deadlineAt: options.deadlineAt },
          }),
          headers: {
            "Content-Type": "application/json",
            "X-Cerebro-Gateway-Key": config.gatewaySigningKey,
          },
          method: "POST",
        })
      );
      if (!response.ok) {
        return {
          code: "provider-unavailable",
          reason: "Gateway reconciliation is unavailable.",
          status: "unavailable",
        };
      }
      return await response.json();
    },
    registry,
    signer: await createCapabilitySigner(config.gatewaySigningKey),
  });
  return {
    authorization,
    broker: createToolBroker({
      authorizationPolicy: authorization,
      entitlementPolicy,
      executor,
      journal,
      registry,
    }),
    checkDependencies: async (active, dependencies, options) => {
      const pinned = await Promise.all([
        ...dependencies.sourceIds.map((sourceId) =>
          authorization.evaluate(
            active.context,
            "read",
            {
              id: sourceId,
              kind: "memory",
              organizationId: active.agent.organizationId,
            },
            options
          )
        ),
        ...dependencies.toolIds.map((toolId) =>
          authorization.evaluate(
            active.context,
            "read",
            {
              id: toolId,
              kind: "tool",
              organizationId: active.agent.organizationId,
            },
            options
          )
        ),
      ]);
      const failed = pinned.find((result) => result.status !== "ok");
      if (failed) {
        return failed;
      }
      if (
        !pinned.every(
          (result) =>
            result.status === "ok" && result.value.decision === "allow"
        )
      ) {
        return {
          code: "unauthorized",
          reason: "The pinned agent has no current dependency access.",
          status: "denied",
        };
      }
      return await withDatabase(env, (connection) =>
        checkContentDependencies(
          env,
          connection,
          active.context,
          dependencies,
          options
        )
      );
    },
    model,
    modelJournal,
    paidModel: createPaidWork({
      authorization,
      budget: createCurrentBudget(env),
      entitlements: entitlementPolicy,
      journal: modelJournal,
    }),
    prepareApproval: async (operationId) => {
      const approval = ledger.grant(id.operation(operationId));
      if (!approval) {
        return;
      }
      await journal.putApproval(approval);
      const response = await env.TOOL_GATEWAY.fetch(
        new Request("https://gateway.internal/approve", {
          body: JSON.stringify(approval),
          headers: {
            "Content-Type": "application/json",
            "X-Cerebro-Gateway-Key": config.gatewaySigningKey,
          },
          method: "POST",
        })
      );
      if (!response.ok) {
        throw new Error("The trusted gateway could not retain the approval.");
      }
    },
    registry,
    retrieve: (active, options) =>
      withDatabase(env, async (connection) => {
        const result = await createMemoryServices(
          env,
          connection
        ).memory.retrieve(
          {
            context: active.context,
            limit: 6,
            organizationId: active.agent.organizationId,
            text: active.prompt,
          },
          options
        );
        if (result.status !== "ok") {
          return result;
        }
        const checks = await Promise.all(
          result.value.map((hit) =>
            authorization.evaluate(
              active.context,
              "read",
              {
                id: hit.citation.sourceId,
                kind: "memory",
                organizationId: active.agent.organizationId,
              },
              options
            )
          )
        );
        const failure = checks.find((check) => check.status !== "ok");
        if (failure) {
          return failure;
        }
        return {
          status: "ok",
          value: result.value.filter(
            (_, index) =>
              checks[index]?.status === "ok" &&
              checks[index]?.value.decision === "allow"
          ),
        };
      }),
  };
};
