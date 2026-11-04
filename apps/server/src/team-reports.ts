import { assertQueuePayloadSize } from "@cerebro/channels/queue-payload";
import { contextByPrincipal } from "@cerebro/channels/security";
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import {
  TeamReportDeliverySchema,
  TeamReportReceiptSchema,
} from "@cerebro/contracts/work";
import { withDatabase } from "@cerebro/db";
import { Schema } from "effect";

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
        const delivery = Schema.decodeUnknownSync(TeamReportDeliverySchema, {
          onExcessProperty: "error",
        })(message.body);
        const { organizationId, ownerPrincipalId } = delivery.report.key;
        const context = await withDatabase(env, (database) =>
          contextByPrincipal(database, organizationId, ownerPrincipalId)
        );
        const body = JSON.stringify(delivery);
        const proof = await signSessionRequest(
          delivery.sourceEventAddress,
          context,
          "/team-report",
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
          "https://session.internal/team-report",
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
        const receipt = Schema.decodeUnknownSync(TeamReportReceiptSchema, {
          onExcessProperty: "error",
        })(await response.json());
        if (
          receipt.reportId !== delivery.report.id ||
          canonicalToolArguments(receipt.key) !==
            canonicalToolArguments(delivery.report.key)
        ) {
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
