/* oxlint-disable no-await-in-loop -- Each item must pass current authorization before it leaves the stream. */
import type { EventAddress } from "@cerebro/contracts/events";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type {
  AuthorizationPolicy,
  EntitlementPolicy,
} from "@cerebro/contracts/policy";
import type {
  EffectOptions,
  PortResult,
  ReadOptions,
} from "@cerebro/contracts/port";
import { preflightEffect } from "@cerebro/contracts/port";
import type {
  AgentRepository,
  RunState,
  SessionCommand,
  SessionReceipt,
  SessionService,
  SessionSnapshot,
  SessionStreamItem,
  ContentDependencies,
} from "@cerebro/contracts/session";
import { getAgentByName } from "agents";

import {
  authorizeSession,
  sessionName,
  validateEvent,
} from "./event-handler.ts";
import { pinAgent } from "./pinned-agent.ts";
import type { SessionAgent } from "./session-agent.ts";

export interface SessionServiceDependencies {
  readonly namespace: DurableObjectNamespace<SessionAgent>;
  readonly agentRepository: AgentRepository;
  readonly authorizationPolicy: AuthorizationPolicy;
  readonly entitlementPolicy: EntitlementPolicy;
  readonly checkContentDependencies?: (
    context: ExecutionContext,
    dependencies: ContentDependencies,
    options: ReadOptions
  ) => Promise<PortResult<void>>;
}

const unavailable = (): PortResult<never> => ({
  code: "provider-unavailable",
  reason: "Session Durable Object is unavailable",
  status: "unavailable",
});

const requestAgent = async <Value>(
  namespace: DurableObjectNamespace<SessionAgent>,
  address: EventAddress,
  path: string,
  body: unknown
): Promise<PortResult<Value>> => {
  try {
    const agent = await getAgentByName(namespace, sessionName(address));
    const response = await agent.fetch(
      new Request(`https://session.internal/${path}`, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    );
    return (await response.json()) as PortResult<Value>;
  } catch {
    return unavailable();
  }
};

export const createSessionService = (
  dependencies: SessionServiceDependencies
): SessionService => ({
  approve: async (
    command: Extract<SessionCommand, { type: "approve" }>,
    options: EffectOptions
  ): Promise<PortResult<RunState>> => {
    const preflight = preflightEffect(options, Date.now());
    if (preflight.status !== "ok") {
      return preflight;
    }
    const authorized = await authorizeSession(
      dependencies.authorizationPolicy,
      dependencies.entitlementPolicy,
      command.address,
      command.context,
      "approve",
      options
    );
    if (authorized.status !== "ok") {
      return authorized;
    }
    return await requestAgent(
      dependencies.namespace,
      command.address,
      "approve",
      { command, options }
    );
  },
  cancel: async (
    command: Extract<SessionCommand, { type: "cancel" }>,
    options: EffectOptions
  ): Promise<PortResult<RunState>> => {
    const preflight = preflightEffect(options, Date.now());
    if (preflight.status !== "ok") {
      return preflight;
    }
    const authorized = await authorizeSession(
      dependencies.authorizationPolicy,
      dependencies.entitlementPolicy,
      command.address,
      command.context,
      "execute",
      options
    );
    if (authorized.status !== "ok") {
      return authorized;
    }
    return await requestAgent(
      dependencies.namespace,
      command.address,
      "cancel",
      { command, options }
    );
  },
  inspect: async (
    address: EventAddress,
    context: ExecutionContext,
    options: ReadOptions
  ): Promise<PortResult<SessionSnapshot>> => {
    const authorized = await authorizeSession(
      dependencies.authorizationPolicy,
      dependencies.entitlementPolicy,
      address,
      context,
      "read",
      options
    );
    if (authorized.status !== "ok") {
      return authorized;
    }
    return await requestAgent(dependencies.namespace, address, "inspect", {
      address,
    });
  },
  async *stream(
    address: EventAddress,
    context: ExecutionContext,
    cursor: string | undefined,
    options: ReadOptions
  ): AsyncIterable<PortResult<SessionStreamItem>> {
    const authorized = await authorizeSession(
      dependencies.authorizationPolicy,
      dependencies.entitlementPolicy,
      address,
      context,
      "read",
      options
    );
    if (authorized.status !== "ok") {
      yield authorized;
      return;
    }
    const result = await requestAgent<SessionStreamItem[]>(
      dependencies.namespace,
      address,
      "stream",
      { address, cursor }
    );
    if (result.status !== "ok") {
      yield result;
      return;
    }
    for (const item of result.value) {
      const current = await authorizeSession(
        dependencies.authorizationPolicy,
        dependencies.entitlementPolicy,
        address,
        context,
        "read",
        options
      );
      if (current.status !== "ok") {
        yield current;
        return;
      }
      if (
        dependencies.checkContentDependencies &&
        (item.type === "output" ||
          item.type === "citation" ||
          item.type === "tool")
      ) {
        if (!item.dependencies) {
          yield {
            code: "unauthorized",
            reason: "Sensitive output has no content dependencies.",
            status: "denied",
          };
          return;
        }
        const allowed = await dependencies.checkContentDependencies(
          context,
          item.dependencies,
          options
        );
        if (allowed.status !== "ok") {
          yield allowed;
          return;
        }
      }
      yield { status: "ok", value: item };
    }
  },
  submit: async (
    command: Extract<SessionCommand, { type: "submit" }>,
    options: EffectOptions
  ): Promise<PortResult<SessionReceipt>> => {
    const preflight = preflightEffect(options, Date.now());
    if (preflight.status !== "ok") {
      return preflight;
    }
    const valid = validateEvent(command.event, Date.now());
    if (valid.status !== "ok") {
      return valid;
    }
    const authorized = await authorizeSession(
      dependencies.authorizationPolicy,
      dependencies.entitlementPolicy,
      command.event,
      command.event.context,
      "execute",
      options
    );
    if (authorized.status !== "ok") {
      return authorized;
    }
    const definition = await dependencies.agentRepository.get(
      command.event.organizationId,
      command.event.agentId,
      "latest",
      options
    );
    if (definition.status !== "ok") {
      return definition;
    }
    return await requestAgent(dependencies.namespace, command.event, "submit", {
      agent: pinAgent(definition.value),
      event: command.event,
      options: {
        deadlineAt: options.deadlineAt,
        operationId: options.operationId,
        requestDigest: options.requestDigest,
      },
    });
  },
});
