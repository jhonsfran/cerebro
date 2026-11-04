import {
  TeamReportDeliverySchema,
  WorkAdmissionSchema,
} from "@cerebro/contracts/work";
import type { WorkAdmission, WorkReport } from "@cerebro/contracts/work";
import { Schema } from "effect";

import { assertQueuePayloadSize } from "./queue-payload";

export const prepareTeamReport = (input: WorkAdmission, report: WorkReport) => {
  const work = Schema.decodeUnknownSync(WorkAdmissionSchema, {
    onExcessProperty: "error",
  })(input);
  const source =
    "sourceSlackThread" in work
      ? {
          sourceEventAddress: work.sourceEventAddress,
          sourceSlackThread: work.sourceSlackThread,
        }
      : { version: 2, sourceEventAddress: work.sourceEventAddress };
  const delivery = Schema.decodeUnknownSync(TeamReportDeliverySchema, {
    onExcessProperty: "error",
  })({
    report,
    ...source,
  });
  try {
    assertQueuePayloadSize(delivery);
    return delivery;
  } catch {
    const fallback = Schema.decodeUnknownSync(TeamReportDeliverySchema, {
      onExcessProperty: "error",
    })({
      ...delivery,
      report: {
        id: report.id,
        key: report.key,
        contentDependencies: { sourceIds: [], toolIds: [] },
        ...(report.kind === "cancelled"
          ? { kind: "cancelled" }
          : {
              kind: "failed",
              reason:
                "The team result could not be transferred within its delivery limits.",
            }),
      },
    });
    assertQueuePayloadSize(fallback);
    return fallback;
  }
};
