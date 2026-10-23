import { z } from "zod";

import { uiRequestSchema } from "./catalog.ts";
import type { UiSpec } from "./catalog.ts";

export const MAX_UI_PRESENTATION_BYTES = 32 * 1024;
export const MAX_SNAPSHOT_UI_BYTES = 128 * 1024;
const encoder = new TextEncoder();
export const uiPresentationSchema = uiRequestSchema.extend({
  kind: z.literal("generative-ui"),
  version: z.literal(1),
});
export type UiPresentation = z.output<typeof uiPresentationSchema>;
export type UiParseResult =
  | { readonly kind: "valid"; readonly presentation: UiPresentation }
  | { readonly kind: "invalid"; readonly reason: string };

export const uiPresentationBytes = (value: UiPresentation): number =>
  encoder.encode(JSON.stringify(value)).byteLength;

const treeError = (spec: UiSpec): string | undefined => {
  const nodes = Object.keys(spec.elements);
  if (nodes.length > 64) {
    return "UI must contain at most 64 elements.";
  }
  const visited = new Set<string>();
  const pending = [{ id: spec.root, depth: 1 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      break;
    }
    const node = spec.elements[current.id];
    if (!node) {
      return "Every UI reference must identify an existing element.";
    }
    if (visited.has(current.id)) {
      return "UI must be a tree without cycles or shared elements.";
    }
    visited.add(current.id);
    if (current.depth > 8) {
      return "UI must have at most 8 levels.";
    }
    if (node.type !== "Stack" && node.type !== "Card" && node.children.length) {
      return "Only Stack and Card can contain children.";
    }
    if (node.type === "Table") {
      const { props } = node;
      if (props.rows.some((row) => row.length !== props.columns.length)) {
        return "Each table row must have one value per column.";
      }
    }
    for (const id of node.children) {
      pending.push({ id, depth: current.depth + 1 });
    }
  }
  return visited.size === nodes.length
    ? undefined
    : "Every UI element must be reachable from the root.";
};

const parse = (value: unknown): UiParseResult => {
  try {
    const serialized = JSON.stringify(value);
    if (
      !serialized ||
      encoder.encode(serialized).byteLength > MAX_UI_PRESENTATION_BYTES
    ) {
      return {
        kind: "invalid",
        reason: "UI must fit within 32 KiB of UTF-8 JSON.",
      };
    }
    const result = uiPresentationSchema.safeParse(value);
    if (!result.success) {
      const [issue] = result.error.issues;
      return {
        kind: "invalid",
        reason:
          `Invalid UI at ${issue?.path.join(".") || "presentation"}: ${issue?.message ?? "invalid value"}`.slice(
            0,
            400
          ),
      };
    }
    const reason = treeError(result.data.spec);
    return reason
      ? { kind: "invalid", reason }
      : { kind: "valid", presentation: result.data };
  } catch {
    return { kind: "invalid", reason: "UI must be a JSON object." };
  }
};

export const parseUiPresentation = (value: unknown): UiParseResult =>
  parse(value);
export const parseUiRequest = (value: unknown): UiParseResult => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "invalid", reason: "UI arguments must be an object." };
  }
  if ("kind" in value || "version" in value) {
    return {
      kind: "invalid",
      reason: "UI arguments accept only spec and fallbackText.",
    };
  }
  return parse({ ...value, kind: "generative-ui", version: 1 });
};
