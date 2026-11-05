import {
  Denied,
  InvalidInput,
  NotFound,
  Unavailable,
} from "@cerebro/contracts/failures";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import {
  InspectionFrame,
  TeamInspectionFrame,
} from "@cerebro/contracts/inspection";
import type {
  InspectionClient,
  InspectionRequest,
  TeamInspectionQuery,
} from "@cerebro/contracts/inspection";
import { workCellName } from "@cerebro/contracts/work";
import type { WorkAdmission } from "@cerebro/contracts/work";
import { Effect, Schema } from "effect";
import { z } from "zod";

import type { WorkerEnv } from "../bindings";
import { runtimeConfiguration } from "../config";
import { resolveSessionAddress } from "./address";
import { signSessionRequest } from "./proof";

const failure = z.object({ error: z.string() });
const checkedResponse = async (response: Response): Promise<unknown> => {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Unavailable({ reason: "Inspection is unavailable." });
  }
  if (response.ok) {
    return value;
  }
  const decoded = failure.safeParse(value);
  if (
    response.status === 401 ||
    response.status === 403 ||
    (decoded.success && decoded.data.error === "Denied")
  ) {
    throw new Denied({
      code: "revoked",
      reason: "Inspection read access is no longer available.",
    });
  }
  if (response.status === 404) {
    throw new NotFound({ resource: "Inspection target" });
  }
  if (
    response.status === 422 ||
    (decoded.success && decoded.data.error === "InvalidInput")
  ) {
    throw new InvalidInput({ reason: "Invalid inspection request." });
  }
  throw new Unavailable({ reason: "Inspection is unavailable." });
};
export const createInspectionClient = (env: WorkerEnv): InspectionClient => ({
  read: async (input: InspectionRequest) => {
    const identity = {
      organizationId: input.address.organizationId,
      ownerPrincipalId: input.context.actor.id,
    };
    await Effect.runPromise(
      resolveSessionAddress(env, input.address, identity)
    );
    const body = JSON.stringify(input.query);
    const proof = await signSessionRequest(
      input.address,
      input.context,
      "/inspect",
      body,
      runtimeConfiguration(env).gatewaySigningKey,
      identity
    );
    const stub = env.SESSION.get(
      env.SESSION.idFromName(
        JSON.stringify([identity.organizationId, identity.ownerPrincipalId])
      )
    );
    let response: Response;
    try {
      response = await stub.fetch(
        new Request("https://session.internal/inspect", {
          method: "POST",
          body,
          headers: {
            "Content-Type": "application/json",
            "x-cerebro-session-proof": proof,
          },
          signal: input.signal,
        })
      );
    } catch {
      throw new Unavailable({ reason: "Source inspection is unavailable." });
    }
    try {
      return Schema.decodeUnknownSync(InspectionFrame, {
        onExcessProperty: "error",
      })(await checkedResponse(response));
    } catch (error) {
      if (
        error instanceof Denied ||
        error instanceof NotFound ||
        error instanceof InvalidInput ||
        error instanceof Unavailable
      ) {
        throw error;
      }
      throw new Unavailable({ reason: "Invalid inspection response." });
    }
  },
});
export const readPrivateTeamInspection = async (
  env: WorkerEnv,
  input: {
    readonly work: WorkAdmission;
    readonly context: ExecutionContext;
    readonly query: TeamInspectionQuery;
    readonly signal?: AbortSignal;
  }
) => {
  const { work, context, query, signal } = input;
  const body = JSON.stringify({ work, query });
  const identity = {
    organizationId: work.key.organizationId,
    ownerPrincipalId: work.key.ownerPrincipalId,
  };
  const proof = await signSessionRequest(
    work.sourceEventAddress,
    context,
    "/inspect",
    body,
    runtimeConfiguration(env).gatewaySigningKey,
    identity
  );
  const stub = env.TEAM.get(env.TEAM.idFromName(workCellName(work.key)));
  let response: Response;
  try {
    response = await stub.fetch(
      new Request("https://team.internal/inspect", {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "x-cerebro-session-proof": proof,
        },
        signal,
      })
    );
  } catch {
    throw new Unavailable({
      reason: "Private Team inspection is unavailable.",
    });
  }
  const value = await checkedResponse(response);
  try {
    return Schema.decodeUnknownSync(TeamInspectionFrame, {
      onExcessProperty: "error",
    })(value);
  } catch {
    throw new Unavailable({ reason: "Invalid private inspection response." });
  }
};
