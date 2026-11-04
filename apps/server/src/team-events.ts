import { assertQueuePayloadSize } from "@cerebro/channels/queue-payload";
import { contextByPrincipal } from "@cerebro/channels/security";
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import {
  TeamCommandSchema,
  TeamCommandReceiptSchema,
  workCellName,
} from "@cerebro/contracts/work";
import { withDatabase } from "@cerebro/db";
import { Schema } from "effect";

import type { WorkerEnv } from "./bindings";
import { runtimeConfiguration } from "./config";
import { signSessionRequest } from "./session/proof";

type TeamCommandEnvironment = Pick<
  WorkerEnv,
  "DATABASE_URL" | "DEPLOY_MODE" | "RUNTIME_CONFIG_JSON"
> & {
  readonly TEAM: {
    readonly idFromName: (name: string) => DurableObjectId;
    readonly get: (id: DurableObjectId) => Pick<Fetcher, "fetch">;
  };
};

export const consumeTeamCommands = async (
  batch: MessageBatch<unknown>,
  env: TeamCommandEnvironment
): Promise<void> => {
  if (batch.queue !== "cerebro-team-commands") {
    throw new Error("This worker does not consume the requested queue.");
  }
  await Promise.all(
    batch.messages.map(async (message) => {
      try {
        assertQueuePayloadSize(message.body);
        const command = Schema.decodeUnknownSync(TeamCommandSchema, {
          onExcessProperty: "error",
        })(message.body);
        const { organizationId, ownerPrincipalId } = command.work.key;
        const context = await withDatabase(env, (database) =>
          contextByPrincipal(database, organizationId, ownerPrincipalId)
        );
        const body = JSON.stringify(command);
        const proof = await signSessionRequest(
          command.work.sourceEventAddress,
          context,
          "/control",
          body,
          runtimeConfiguration(env).gatewaySigningKey,
          { organizationId, ownerPrincipalId }
        );
        const stub = env.TEAM.get(
          env.TEAM.idFromName(workCellName(command.work.key))
        );
        const response = await stub.fetch("https://team.internal/control", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-cerebro-session-proof": proof,
          },
          body,
        });
        if (!response.ok) {
          throw new Error("Private team admission failed.");
        }
        const receipt = Schema.decodeUnknownSync(TeamCommandReceiptSchema, {
          onExcessProperty: "error",
        })(await response.json());
        if (
          receipt.commandId !== command.id ||
          canonicalToolArguments(receipt.key) !==
            canonicalToolArguments(command.work.key)
        ) {
          throw new Error("The team receipt does not match the command.");
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
