import { assertQueuePayloadSize } from "@cerebro/channels/queue-payload";
import { contextByPrincipal } from "@cerebro/channels/security";
import {
  normalizeTeamReport,
  teamReportReceiptMatches,
} from "@cerebro/contracts/team-events";
import { withDatabase } from "@cerebro/db";

import type { WorkerEnv } from "./bindings";
import { runtimeConfiguration } from "./config";
import { signSessionRequest } from "./session/proof";

type TeamReportEnvironment = Pick<
  WorkerEnv,
  "DATABASE_URL" | "DEPLOY_MODE" | "RUNTIME_CONFIG_JSON"
> & {
  readonly SESSION: {
    readonly idFromName: (name: string) => DurableObjectId;
    readonly get: (id: DurableObjectId) => Pick<Fetcher, "fetch">;
  };
};
export const consumeTeamReports = async (
  batch: MessageBatch<unknown>,
  env: TeamReportEnvironment
): Promise<void> => {
  if (batch.queue !== "cerebro-team-reports") {
    throw new Error("This worker does not consume the requested queue.");
  }
  await Promise.all(
    batch.messages.map(async (message) => {
      try {
        assertQueuePayloadSize(message.body);
        const delivery = normalizeTeamReport(message.body);
        const { organizationId, ownerPrincipalId } = delivery.key;
        const context = await withDatabase(env, (database) =>
          contextByPrincipal(database, organizationId, ownerPrincipalId)
        );
        const body = JSON.stringify(delivery.wire);
        const proof = await signSessionRequest(
          delivery.sourceEventAddress,
          context,
          delivery.path,
          body,
          runtimeConfiguration(env).gatewaySigningKey,
          { organizationId, ownerPrincipalId }
        );
        const stub = env.SESSION.get(
          env.SESSION.idFromName(
            JSON.stringify([organizationId, ownerPrincipalId])
          )
        );
        const response = await stub.fetch(
          `https://session.internal${delivery.path}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-cerebro-session-proof": proof,
            },
            body,
          }
        );
        if (!response.ok) {
          throw new Error("Private report admission failed.");
        }
        const result: unknown = await response.json();
        if (!teamReportReceiptMatches(delivery, result)) {
          throw new Error("The source receipt does not match the report.");
        }
        message.ack();
      } catch {
        message.retry({
          delaySeconds: Math.min(60, 2 ** Math.min(message.attempts, 6)),
        });
      }
    })
  );
};
