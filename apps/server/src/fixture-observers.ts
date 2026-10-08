import { createChannelService } from "@cerebro/channels/service";
import { digestToolArguments } from "@cerebro/contracts/tools";
import { z } from "zod";

import { sessionName } from "../../../packages/runtime/src/event-handler";
import { createChannelOptions } from "./channel-services";
import type { WorkerEnv } from "./env.server";
import { runtimeConfiguration } from "./runtime-services";
import { createAuth, withDatabase } from "./services";
import { signSessionRequest } from "./session-proof";

export const inspectFixtureObservers = async (
  request: Request,
  env: WorkerEnv
): Promise<Response> => {
  if (env.DEPLOY_MODE !== "fixture") {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const parsed = z
    .object({ conversationId: z.string().min(1) })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid input" }, { status: 422 });
  }
  const access = await withDatabase(env, async (database) => {
    const auth = await createAuth(env, database).api.getSession({
      headers: request.headers,
    });
    if (!auth) {
      return;
    }
    return createChannelService(database, createChannelOptions(env)).chatAccess(
      auth.user.id,
      parsed.data.conversationId
    );
  });
  if (!access) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { address, context } = access;
  const body = JSON.stringify({
    fixtureDiagnostics: "observers",
    options: {
      deadlineAt: Date.now() + 5000,
      operationId: `fixture-observers:${crypto.randomUUID()}`,
      requestDigest: await digestToolArguments(address),
    },
  });
  const proof = await signSessionRequest(
    address,
    context,
    "/inspect",
    body,
    runtimeConfiguration(env).gatewaySigningKey
  );
  const stub = env.SESSION.get(env.SESSION.idFromName(sessionName(address)));
  const response = await stub.fetch(
    new Request("https://session.internal/inspect", {
      body,
      headers: {
        "Content-Type": "application/json",
        "x-cerebro-session-proof": proof,
      },
      method: "POST",
      signal: AbortSignal.timeout(5000),
    })
  );
  if (!response.ok) {
    return response;
  }
  const result = z
    .object({
      diagnostics: z.object({
        adapterMeasurements: z.array(
          z.object({
            adapter: z.enum(["permission", "projection"]),
            durationMs: z.number().nonnegative(),
            operationId: z.string().optional(),
            recordedAt: z.number().int().nonnegative(),
          })
        ),
        firstProjectionFailure: z
          .object({
            code: z.string().nullable(),
            reasonSHA256: z.string().regex(/^[a-f0-9]{64}$/u),
            tag: z.enum([
              "Denied",
              "InvalidInput",
              "Conflict",
              "Unavailable",
              "NotFound",
              "UnknownOutcome",
            ]),
          })
          .nullable(),
        observerCount: z.number().int().nonnegative(),
        projectionFailure: z
          .object({
            code: z.string().nullable(),
            reasonSHA256: z.string().regex(/^[a-f0-9]{64}$/u),
            tag: z.enum([
              "Denied",
              "InvalidInput",
              "Conflict",
              "Unavailable",
              "NotFound",
              "UnknownOutcome",
            ]),
          })
          .nullable(),
      }),
    })
    .parse(await response.json());
  return Response.json(result.diagnostics, {
    headers: { "Cache-Control": "no-store" },
  });
};
