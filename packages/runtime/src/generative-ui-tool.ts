import { uiCatalog, uiRequestSchema } from "@cerebro/generative-ui/catalog";
import type { UiSpec } from "@cerebro/generative-ui/catalog";
import { parseUiRequest } from "@cerebro/generative-ui/presentation";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { z } from "zod";

const componentGuide = Object.entries(uiCatalog.data.components)
  .map(
    ([name, component]) =>
      `${name}: ${component.description} Props: ${Object.keys(component.props.shape).join(", ")}.`
  )
  .join("\n");
const textExample = {
  type: "Text",
  props: { text: "Replace this with supplied text", tone: "default" },
  children: [],
} satisfies UiSpec["elements"][string];

export const createGenerativeUiTool = (options: {
  readonly authorize: (signal?: AbortSignal) => Promise<void>;
}): ToolRegistration => ({
  name: "render_ui",
  description:
    "Show a read-only report in this conversation using a complete spec with root and elements. " +
    "Each element has type, props, and children. children is required even on leaves; use []. " +
    "Only Stack and Card can have children. All elements must belong to one tree. " +
    "Text uses props.text, never props.content. Text tone is default or muted. " +
    "Metric and KeyValue values must be strings. Stack direction is vertical or horizontal. " +
    "Table columns are strings and rows are arrays of strings in column order. " +
    "Use actual data from the user or permitted tool results. Never invent sample data. " +
    "Provide fallbackText that communicates the report without the UI. " +
    "After this tool, always give a useful assistant text answer for channels that cannot display UI. " +
    "Limits are 32 KiB, 64 elements, 8 levels, 8 columns, and 50 rows per table. " +
    "Actions, expressions, bindings, styles, and URLs are not supported.\n" +
    `${componentGuide}\nExample element shape: ${JSON.stringify(textExample)}`,
  parameters: z.toJSONSchema(uiRequestSchema),
  prepareArguments: (args) => {
    const result = parseUiRequest(args);
    if (result.kind === "invalid") {
      throw new Error(result.reason);
    }
    const { spec, fallbackText } = result.presentation;
    return { spec, fallbackText };
  },
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
