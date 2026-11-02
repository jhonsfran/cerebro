import { cn } from "@cerebro/ui/lib/utils";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

// A native <details>: it keeps its open state across renders, works without
// scripting, and tests can toggle it directly.
export const Disclosure = ({
  summary,
  open,
  className,
  summaryClassName,
  children,
}: {
  summary: ReactNode;
  open?: boolean;
  className?: string;
  summaryClassName?: string;
  children: ReactNode;
}) => (
  <details className={cn("group/disclosure text-xs", className)} open={open}>
    <summary
      className={cn(
        "text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex w-fit cursor-pointer list-none items-center gap-1 font-medium outline-none select-none focus-visible:ring-1 [&::-webkit-details-marker]:hidden",
        summaryClassName
      )}
    >
      <ChevronRight
        aria-hidden="true"
        className="size-3.5 shrink-0 transition-transform group-open/disclosure:rotate-90"
      />
      {summary}
    </summary>
    <div className="mt-2 flex flex-col gap-2">{children}</div>
  </details>
);
