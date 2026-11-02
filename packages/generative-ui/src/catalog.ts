import { defineCatalog, defineSchema } from "@json-render/core";
import { z } from "zod";

const text = z.string().max(4096);
const label = z.string().trim().min(1).max(256);
const nodeId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u);

const readonlyTree = defineSchema((s) => ({
  catalog: s.object({
    components: s.map({ props: s.zod(), description: s.string() }),
    actions: s.map({ props: s.zod() }),
  }),
  spec: s.object({
    root: s.string(),
    elements: s.record(
      s.object({
        type: s.ref("catalog.components"),
        props: s.propsOf("catalog.components"),
        children: s.array(s.string()),
      })
    ),
  }),
}));

export const uiCatalog = defineCatalog(readonlyTree, {
  actions: {},
  components: {
    Stack: {
      description: "Group children vertically or horizontally.",
      props: z.strictObject({ direction: z.enum(["vertical", "horizontal"]) }),
    },
    Card: {
      description: "Group related results under a title.",
      props: z.strictObject({ title: label, description: text.optional() }),
    },
    Text: {
      description: "Show plain text.",
      props: z.strictObject({ text, tone: z.enum(["default", "muted"]) }),
    },
    Metric: {
      description: "Show a labeled value and optional detail.",
      props: z.strictObject({ label, value: text, detail: text.optional() }),
    },
    KeyValue: {
      description: "Show a labeled text value.",
      props: z.strictObject({ label, value: text }),
    },
    Table: {
      description: "Show records with a caption and column headers.",
      props: z.strictObject({
        caption: label,
        columns: z.array(label).min(1).max(8),
        rows: z.array(z.array(text).max(8)).max(50),
      }),
    },
  },
});

const element = <
  Name extends keyof typeof uiCatalog.data.components,
  Props extends z.ZodType,
>(
  type: Name,
  props: Props
) =>
  z.strictObject({
    type: z.literal(type),
    props,
    children: z.array(nodeId).max(64),
  });

// Core's generated schema does not validate props by component or reject unknown keys.
export const uiSpecSchema = z.strictObject({
  root: nodeId,
  elements: z.record(
    nodeId,
    z.discriminatedUnion("type", [
      element("Stack", uiCatalog.data.components.Stack.props),
      element("Card", uiCatalog.data.components.Card.props),
      element("Text", uiCatalog.data.components.Text.props),
      element("Metric", uiCatalog.data.components.Metric.props),
      element("KeyValue", uiCatalog.data.components.KeyValue.props),
      element("Table", uiCatalog.data.components.Table.props),
    ])
  ),
});
export type UiSpec = z.output<typeof uiSpecSchema>;
export const uiRequestSchema = z.strictObject({
  spec: uiSpecSchema,
  fallbackText: z.string().trim().min(1).max(8000),
});
