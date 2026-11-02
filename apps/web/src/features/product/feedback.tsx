import { Alert, AlertDescription } from "@cerebro/ui/components/alert";
import { Spinner } from "@cerebro/ui/components/spinner";
import { cn } from "@cerebro/ui/lib/utils";
import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";

// A failed request. Its text is the alert's whole accessible content.
export const ErrorAlert = ({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) => (
  <Alert variant="destructive" className={className}>
    <CircleAlert aria-hidden="true" />
    <AlertDescription className="text-destructive">{children}</AlertDescription>
  </Alert>
);

export const LoadingState = ({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) => (
  <p
    className={cn(
      "text-muted-foreground flex items-center gap-2 text-xs",
      className
    )}
    aria-busy="true"
  >
    <Spinner />
    {children}
  </p>
);

// A settings page: scrolls inside the workspace and keeps a readable width.
export const PageBody = ({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) => (
  <div className="min-h-0 flex-1 overflow-y-auto">
    <div
      className={cn(
        "mx-auto flex w-full max-w-(--measure-page) flex-col gap-6 p-4 md:p-6",
        className
      )}
    >
      {children}
    </div>
  </div>
);

// The title and lede every settings page opens with.
export const PageIntro = ({
  id,
  title,
  hiddenTitle = false,
  children,
  action,
}: {
  id: string;
  title: string;
  // The page h1 already names it; the section keeps a heading for its label.
  hiddenTitle?: boolean;
  children: ReactNode;
  action?: ReactNode;
}) => (
  <div className="flex flex-wrap items-start justify-between gap-3">
    <div className="flex max-w-prose flex-col gap-1">
      <h2 id={id} className={hiddenTitle ? "sr-only" : "text-sm font-medium"}>
        {title}
      </h2>
      <p className="text-muted-foreground text-xs/relaxed">{children}</p>
    </div>
    {action}
  </div>
);
