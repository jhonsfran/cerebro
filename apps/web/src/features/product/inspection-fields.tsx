import type {
  InspectionResult,
  InspectionWork,
} from "@cerebro/contracts/inspection";
import { Button } from "@cerebro/ui/components/button";
import { Spinner } from "@cerebro/ui/components/spinner";
import { Fragment } from "react";
import type { ReactNode } from "react";

import { ErrorAlert } from "./feedback";
import type { InspectionLoad } from "./use-inspection";

export const InspectionText = ({
  content,
}: {
  content: InspectionWork["goal"];
}) => (
  <>
    <p className="break-words whitespace-pre-wrap">{content.text}</p>
    {content.truncated ? (
      <p className="text-muted-foreground">Text truncated.</p>
    ) : null}
  </>
);

export const InspectionFacts = ({
  rows,
}: {
  rows: readonly (readonly [string, ReactNode])[];
}) => (
  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
    {rows.map(([label, value]) => (
      <Fragment key={label}>
        <dt className="text-muted-foreground">{label}</dt>
        <dd className="min-w-0 break-all">{value ?? "Not recorded"}</dd>
      </Fragment>
    ))}
  </dl>
);

export const InspectionNotice = ({
  state,
}: {
  state: InspectionLoad<unknown>;
}) => {
  if (state.kind === "loading") {
    return (
      <output className="flex items-center gap-2">
        <Spinner />
        Loading Inspector…
      </output>
    );
  }
  return state.kind === "failed" ? (
    <ErrorAlert>Inspector is unavailable. Refresh to retry.</ErrorAlert>
  ) : null;
};

export const InspectionResultView = ({
  result,
}: {
  result: InspectionResult | null;
}) =>
  result ? (
    <section aria-label="Work result" className="flex flex-col gap-1">
      <h4 className="font-medium">Result · {result.kind}</h4>
      <InspectionText content={result.content} />
      <p className="text-muted-foreground break-all">Result {result.id}</p>
    </section>
  ) : (
    <p className="text-muted-foreground">No saved result.</p>
  );

export const InspectionPagination = ({
  next,
  older,
  latest,
  label,
}: {
  next: string | null;
  older: (cursor: string) => void;
  latest: () => void;
  label: string;
}) => (
  <div className="flex flex-wrap gap-2">
    <Button type="button" size="xs" variant="outline" onClick={latest}>
      Latest {label}
    </Button>
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={next === null}
      onClick={() => {
        if (next) {
          older(next);
        }
      }}
    >
      Older {label}
    </Button>
  </div>
);
