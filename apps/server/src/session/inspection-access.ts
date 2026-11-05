import { contextByPrincipal } from "@cerebro/channels/security";
import type { EventAddress } from "@cerebro/contracts/events";
import { Denied, fromPortResult } from "@cerebro/contracts/failures";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type { ContentDependencies } from "@cerebro/contracts/session";
import { withDatabase } from "@cerebro/db";
import { Effect } from "effect";

import {
  checkContentDependencies,
  createCurrentAuthorization,
} from "../access";
import type { WorkerEnv } from "../bindings";
import { resolveSessionAddress } from "./address";

export const requireInspectionRead = async (
  env: WorkerEnv,
  input: {
    readonly address: EventAddress;
    readonly context: ExecutionContext;
    readonly dependencies: ContentDependencies;
    readonly history?: readonly EventAddress[];
    readonly signal?: AbortSignal;
  }
): Promise<void> => {
  const { context, address, signal } = input;
  if (
    "delegation" in context ||
    context.actor.organizationId !== address.organizationId
  ) {
    throw new Denied({
      code: "unauthorized",
      reason: "Inspection requires the source owner.",
    });
  }
  const identity = {
    organizationId: address.organizationId,
    ownerPrincipalId: context.actor.id,
  };
  const options = { deadlineAt: Date.now() + 10_000, signal };
  signal?.throwIfAborted();
  await withDatabase(env, (database) =>
    contextByPrincipal(
      database,
      identity.organizationId,
      identity.ownerPrincipalId
    )
  );
  await Promise.all(
    [address, ...(input.history ?? [])].map(async (source) => {
      await Effect.runPromise(resolveSessionAddress(env, source, identity));
      const decision = await createCurrentAuthorization(env).evaluate(
        context,
        "read",
        {
          kind: "agent",
          id: source.agentId,
          organizationId: source.organizationId,
        },
        options
      );
      const value = await Effect.runPromise(fromPortResult(decision));
      if (value.decision !== "allow") {
        throw new Denied({
          code: "revoked",
          reason: "Source read access is no longer available.",
        });
      }
    })
  );
  const checked = await withDatabase(env, (database) =>
    checkContentDependencies(
      env,
      database,
      context,
      input.dependencies,
      options
    )
  );
  await Effect.runPromise(fromPortResult(checked));
  signal?.throwIfAborted();
};
