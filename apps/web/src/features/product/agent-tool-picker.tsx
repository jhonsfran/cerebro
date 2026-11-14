import { Checkbox } from "@cerebro/ui/components/checkbox";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@cerebro/ui/components/field";

import { Disclosure } from "./disclosure";
import type { ToolChoice } from "./types";

const ToolRow = ({
  tool,
  checked,
  onChange,
}: {
  tool: ToolChoice;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) => {
  const id = `agent-tool-${tool.id}`;
  const approvalId = `${id}-approval`;
  return (
    <li className="px-3 py-2">
      <Field orientation="horizontal">
        <Checkbox
          id={id}
          aria-describedby={
            tool.requiresApproval === undefined ? undefined : approvalId
          }
          checked={checked}
          onCheckedChange={onChange}
        />
        <FieldLabel htmlFor={id} className="min-w-0 font-mono break-all">
          {tool.label}
        </FieldLabel>
        {tool.requiresApproval === undefined ? null : (
          <span
            id={approvalId}
            className="text-muted-foreground shrink-0 text-xs"
          >
            {tool.requiresApproval ? "Approval required" : "No approval"}
          </span>
        )}
      </Field>
      {tool.description && tool.description !== tool.label ? (
        <Disclosure
          summary={
            <>
              Details<span className="sr-only"> for {tool.label}</span>
            </>
          }
          className="mt-1.5 ml-6"
        >
          <p className="text-muted-foreground wrap-anywhere whitespace-pre-wrap">
            {tool.description}
          </p>
        </Disclosure>
      ) : null}
    </li>
  );
};

export const AgentToolPicker = ({
  choices,
  selected,
  toggle,
}: {
  choices: readonly ToolChoice[];
  selected: ReadonlySet<string>;
  toggle: (id: string, checked: boolean) => void;
}) => {
  const byConnector = new Map<string | undefined, ToolChoice[]>();
  for (const choice of choices) {
    const tools = byConnector.get(choice.connectorId);
    if (tools) {
      tools.push(choice);
    } else {
      byConnector.set(choice.connectorId, [choice]);
    }
  }
  const selectedCount = choices.filter(({ id }) => selected.has(id)).length;
  return (
    <FieldSet className="gap-3">
      <FieldLegend>Tools</FieldLegend>
      <FieldDescription>
        {choices.length > 0
          ? `Connectors provide these tools and set which ones need approval. Select the tools this agent can use. ${selectedCount} of ${choices.length} selected.`
          : "No tools are available. An administrator can add them under Connectors."}
      </FieldDescription>
      {[...byConnector].map(([connectorId, tools]) => (
        <section className="bg-card border" key={connectorId ?? ""}>
          {connectorId ? (
            <h3 className="bg-muted/50 text-muted-foreground border-b px-3 py-2 text-xs wrap-anywhere">
              Connector{" "}
              <span className="text-foreground font-mono">{connectorId}</span>
            </h3>
          ) : null}
          <ul
            className="divide-y"
            aria-label={connectorId ? `Tools from ${connectorId}` : "Tools"}
          >
            {tools.map((tool) => (
              <ToolRow
                key={tool.id}
                tool={tool}
                checked={selected.has(tool.id)}
                onChange={(checked) => toggle(tool.id, checked)}
              />
            ))}
          </ul>
        </section>
      ))}
    </FieldSet>
  );
};
