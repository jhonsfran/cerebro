import type { EventAddress } from "@cerebro/contracts/events";
import { InvalidInput, Unavailable } from "@cerebro/contracts/failures";
import {
  INSPECTION_MAX_BYTES,
  INSPECTION_TEXT_LENGTH,
  InspectionFrame,
} from "@cerebro/contracts/inspection";
import type { InspectionQuery } from "@cerebro/contracts/inspection";
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import type {
  Cursor,
  DocDefinition,
  Harness,
  JsonObject,
  Storage,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";

import { piContext } from "./pi-harness.ts";

const continuation = Schema.fromJsonString(
  Schema.Struct({
    scope: Schema.String,
    cursor: Schema.declare<Cursor>((value): value is Cursor =>
      Schema.is(Schema.JsonObject)(value)
    ),
  })
);
export const scanInspectionKeys = async (
  pi: Harness,
  storage: Storage,
  definition: Pick<DocDefinition<JsonObject>, "kind" | "version">,
  cursor?: Cursor
) =>
  await pi.commit(async () => {
    const page = await storage.scanDocuments(
      { scope: { kind: "session" }, at: "current", kind: definition.kind },
      32,
      cursor,
      piContext()
    );
    const keys = await Promise.all(
      page.items.map(async (entry) => {
        const saved = await storage.document(entry.id, "current", piContext());
        // Retired formats remain stored, but the current Inspector cannot decode them.
        return saved && saved.version >= definition.version
          ? entry.key
          : undefined;
      })
    );
    return {
      keys: keys.filter((key): key is string => key !== undefined),
      ...(page.next ? { next: page.next } : {}),
    };
  }, piContext());
const scope = (address: EventAddress, query: InspectionQuery): string =>
  canonicalToolArguments({
    address,
    kind: query.kind,
    workId: "workId" in query ? query.workId : null,
    role: "role" in query ? query.role : null,
  });
export const inspectionCursor = (
  address: EventAddress,
  query: InspectionQuery
): Cursor | undefined => {
  if (!("cursor" in query) || !query.cursor) {
    return;
  }
  try {
    const parsed = Schema.decodeUnknownSync(continuation)(query.cursor);
    if (parsed.scope === scope(address, query)) {
      return parsed.cursor;
    }
  } catch {
    throw new InvalidInput({ reason: "Invalid inspection cursor." });
  }
  throw new InvalidInput({
    reason: "The inspection cursor belongs to another page.",
  });
};
export const nextInspectionCursor = (
  address: EventAddress,
  query: InspectionQuery,
  cursor?: Cursor
): string | null =>
  cursor ? JSON.stringify({ scope: scope(address, query), cursor }) : null;
export const inspectionText = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  const truncated = bytes.length > INSPECTION_TEXT_LENGTH;
  return {
    text: truncated
      ? new TextDecoder().decode(bytes.subarray(0, INSPECTION_TEXT_LENGTH), {
          stream: true,
        })
      : text,
    truncated,
  };
};
export const boundedInspectionFrame = (
  value: InspectionFrame
): InspectionFrame => {
  const frame = Schema.decodeUnknownSync(InspectionFrame, {
    onExcessProperty: "error",
  })(value);
  if (
    new TextEncoder().encode(JSON.stringify(frame)).length >
    INSPECTION_MAX_BYTES
  ) {
    throw new Unavailable({
      reason: "The inspection page exceeds its display limit.",
    });
  }
  return frame;
};
