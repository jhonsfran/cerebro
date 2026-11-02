import type { ChatToolExecution } from "@cerebro/contracts/session-service";
import { Badge } from "@cerebro/ui/components/badge";
import { Spinner } from "@cerebro/ui/components/spinner";
import { cn } from "@cerebro/ui/lib/utils";
import { ChartColumn, Check, CircleAlert, Wrench } from "lucide-react";
import type { ReactNode } from "react";

import { Disclosure } from "./disclosure";
import { GenerativeUi } from "./generative-ui";

const toolStatus = {
  failed: "Failed",
  interrupted: "Interrupted",
  pending: "Waiting",
  running: "Running",
  succeeded: "Completed",
} satisfies Record<ChatToolExecution["state"], string>;

const ReportContent = ({ tool }: { tool: ChatToolExecution }) => {
  if (tool.presentation) {
    return <GenerativeUi presentation={tool.presentation} />;
  }
  return tool.output ? (
    <p className="generated-fallback">{tool.output}</p>
  ) : null;
};

const ToolDiagnostics = ({
  tool,
  awaitingApproval,
}: {
  tool: ChatToolExecution;
  awaitingApproval: boolean;
}) => (
  <>
    {awaitingApproval ? null : (
      <Disclosure summary="Arguments" className="message-disclosure">
        <pre>{JSON.stringify(tool.arguments, null, 2)}</pre>
      </Disclosure>
    )}
    {tool.output ? (
      <Disclosure summary="Output" className="message-disclosure">
        <pre className="tool-output">{tool.output}</pre>
      </Disclosure>
    ) : null}
  </>
);

const StatusBadge = ({ state }: { state: ChatToolExecution["state"] }) => {
  if (state === "pending" || state === "running") {
    return (
      <Badge variant="outline">
        <Spinner data-icon="inline-start" />
        {toolStatus[state]}
      </Badge>
    );
  }
  if (state === "succeeded") {
    return (
      <Badge variant="secondary">
        <Check data-icon="inline-start" aria-hidden="true" />
        {toolStatus[state]}
      </Badge>
    );
  }
  return (
    <Badge variant="destructive">
      <CircleAlert data-icon="inline-start" aria-hidden="true" />
      {toolStatus[state]}
    </Badge>
  );
};

export const ToolExecution = ({
  tool,
  awaitingApproval = false,
  children,
}: {
  tool: ChatToolExecution;
  awaitingApproval?: boolean;
  children: ReactNode;
}) => {
  const report = tool.toolName === "render_ui";
  const { label, content } = report
    ? { label: "Agent report", content: <ReportContent tool={tool} /> }
    : {
        label: tool.toolName,
        content: (
          <ToolDiagnostics tool={tool} awaitingApproval={awaitingApproval} />
        ),
      };
  return (
    <article
      className={cn(
        "tool-execution bg-card flex flex-col border text-xs",
        report && "tool-report"
      )}
      data-state={tool.state}
      aria-label={`${label} ${toolStatus[tool.state]}`}
      aria-busy={tool.state === "pending" || tool.state === "running"}
    >
      <header className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="flex min-w-0 items-center gap-2 font-medium">
          {report ? (
            <ChartColumn
              aria-hidden="true"
              className="text-muted-foreground size-3.5 shrink-0"
            />
          ) : (
            <Wrench
              aria-hidden="true"
              className="text-muted-foreground size-3.5 shrink-0"
            />
          )}
          <span className={cn("truncate", !report && "font-mono")}>
            {label}
          </span>
        </span>
        <StatusBadge state={tool.state} />
      </header>
      <div className="flex flex-col gap-2 px-3 pb-3 empty:hidden">
        {content}
      </div>
      {children}
    </article>
  );
};
