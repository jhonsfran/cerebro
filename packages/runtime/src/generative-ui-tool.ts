import { uiRequestSchema } from "@cerebro/generative-ui/catalog";
import { parseUiRequest } from "@cerebro/generative-ui/presentation";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { z } from "zod";

export const createGenerativeUiTool = (options: {
  readonly authorize: (signal?: AbortSignal) => Promise<void>;
}): ToolRegistration => ({
  name: "render_ui",
  description:
    "Show a read-only report in this conversation using a complete spec with root and elements. " +
    "Use Stack, Card, Text, Metric, KeyValue, or Table. Each element has type, props, and children. " +
    "Only Stack and Card can have children. All elements must belong to one tree. " +
    "Use actual data from the user or permitted tool results. Never invent sample data. " +
    "Provide fallbackText that communicates the report without the UI. " +
    "After this tool, always give a useful assistant text answer for channels that cannot display UI. " +
    "Limits are 32 KiB, 64 elements, 8 levels, 8 columns, and 50 rows per table. " +
    "Actions, expressions, bindings, styles, and URLs are not supported.",
  parameters: z.toJSONSchema(uiRequestSchema),
  replay: "safe",
  execute: async (args, _api, context) => {
    await options.authorize(context.abortSignal);
    const result = parseUiRequest(args);
    if (result.kind === "invalid") {
      return { isError: true, output: [{ type: "text", text: result.reason }] };
    }
    return {
      details: result.presentation,
      output: [{ type: "text", text: result.presentation.fallbackText }],
    };
  },
});
