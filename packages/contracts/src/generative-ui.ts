import { parseUiPresentation } from "@cerebro/generative-ui/presentation";
import type { UiPresentation } from "@cerebro/generative-ui/presentation";
import { Schema, SchemaGetter } from "effect";

const presentation = Schema.declare<UiPresentation | undefined>(
  (value): value is UiPresentation | undefined =>
    value === undefined || parseUiPresentation(value).kind === "valid"
);

export const UiPresentationFromUnknown = Schema.Unknown.pipe(
  Schema.decodeTo(presentation, {
    decode: SchemaGetter.transform((value) => {
      const result = parseUiPresentation(value);
      return result.kind === "valid" ? result.presentation : undefined;
    }),
    encode: SchemaGetter.transform((value) => value),
  })
);
