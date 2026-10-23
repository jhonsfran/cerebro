import type { ChatToolExecution } from "@cerebro/contracts/session-service";
import type { ReactNode } from "react";

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

const ToolDiagnostics = ({ tool }: { tool: ChatToolExecution }) => (
  <>
    <details>
      <summary>Arguments</summary>
      <pre>{JSON.stringify(tool.arguments, null, 2)}</pre>
    </details>
    {tool.output ? (
      <details>
        <summary>Output</summary>
        <pre className="tool-output">{tool.output}</pre>
      </details>
    ) : null}
  </>
);

export const ToolExecution = ({
  tool,
  children,
}: {
  tool: ChatToolExecution;
  children: ReactNode;
}) => {
  const { label, content } =
    tool.toolName === "render_ui"
      ? { label: "Agent report", content: <ReportContent tool={tool} /> }
      : { label: tool.toolName, content: <ToolDiagnostics tool={tool} /> };
  return (
    <article
      className="tool-execution"
      aria-label={`${label} ${toolStatus[tool.state]}`}
      aria-busy={tool.state === "pending" || tool.state === "running"}
    >
      <header className="tool-execution-header">
        <strong>{label}</strong>
        <span className="tool-status">{toolStatus[tool.state]}</span>
      </header>
      {content}
      {children}
    </article>
  );
};
