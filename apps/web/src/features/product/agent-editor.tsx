import { Alert, AlertDescription } from "@cerebro/ui/components/alert";
import { Badge } from "@cerebro/ui/components/badge";
import { Button } from "@cerebro/ui/components/button";
import { Checkbox } from "@cerebro/ui/components/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from "@cerebro/ui/components/field";
import { Input } from "@cerebro/ui/components/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@cerebro/ui/components/select";
import { Spinner } from "@cerebro/ui/components/spinner";
import { Textarea } from "@cerebro/ui/components/textarea";
import { TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { AgentToolPicker } from "./agent-tool-picker";
import { encoded, mutate, productPath, request } from "./api";
import {
  agentEditorValues,
  agentExecutionGrants,
  agentTeamSection,
} from "./configuration";
import type { TeamBudgets } from "./configuration";
import { Disclosure } from "./disclosure";
import { ErrorAlert, PageBody, PageIntro } from "./feedback";
import { operationFor } from "./intent";
import type { OperationIntent } from "./intent";
import { catalogSchema, savedAgentSchema } from "./types";
import type { AgentDetail, Setup } from "./types";

const saveLabel = (busy: boolean, editing: boolean): string => {
  if (busy) {
    return "Saving…";
  }
  return editing ? "Publish new version" : "Create agent";
};
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "The request failed.";

const ChoiceGroup = ({
  id,
  legend,
  help,
  empty,
  choices,
  selected,
  toggle,
}: {
  id: string;
  legend: string;
  help: string;
  empty: string;
  choices: readonly { readonly id: string; readonly label: string }[];
  selected: ReadonlySet<string>;
  toggle: (id: string, checked: boolean) => void;
}) => {
  const count = choices.filter((choice) => selected.has(choice.id)).length;
  return (
    <FieldSet>
      <FieldLegend>{legend}</FieldLegend>
      <FieldDescription>
        {choices.length > 0
          ? `${help} ${count} of ${choices.length} selected.`
          : empty}
      </FieldDescription>
      {choices.length > 0 ? (
        <FieldGroup data-slot="checkbox-group" className="gap-2">
          {choices.map((choice) => {
            const choiceId = `${id}-${choice.id}`;
            return (
              <FieldLabel htmlFor={choiceId} key={choice.id}>
                <Field orientation="horizontal">
                  <Checkbox
                    id={choiceId}
                    checked={selected.has(choice.id)}
                    onCheckedChange={(checked) => toggle(choice.id, checked)}
                  />
                  <FieldContent>
                    <FieldTitle className="break-all">
                      {choice.label}
                    </FieldTitle>
                  </FieldContent>
                </Field>
              </FieldLabel>
            );
          })}
        </FieldGroup>
      ) : null}
    </FieldSet>
  );
};

const TEAM_BUDGET_FIELDS: readonly {
  readonly key: keyof TeamBudgets;
  readonly label: string;
  readonly max: number;
}[] = [
  { key: "maxWorkers", label: "Workers at once", max: 8 },
  { key: "maxTurns", label: "Model calls per team", max: 256 },
  { key: "timeoutSeconds", label: "Time limit in seconds", max: 14_400 },
];

const TeamBudgetFields = ({
  budgets,
  change,
}: {
  budgets: TeamBudgets;
  change: (key: keyof TeamBudgets, value: string) => void;
}) => (
  <FieldSet className="gap-3">
    <FieldLegend>Background Teams</FieldLegend>
    <FieldDescription>
      The agent can delegate a task to a Team that runs in the background and
      sends its result back to the conversation.
    </FieldDescription>
    <Disclosure summary="Team limits">
      <FieldDescription>
        These limits apply to each new Team. Leave a field empty to use the
        workspace default.
      </FieldDescription>
      <FieldGroup className="gap-3">
        {TEAM_BUDGET_FIELDS.map((field) => (
          <Field key={field.key}>
            <FieldLabel htmlFor={`agent-team-${field.key}`}>
              {field.label}
            </FieldLabel>
            <Input
              id={`agent-team-${field.key}`}
              type="number"
              inputMode="numeric"
              min={1}
              max={field.max}
              step={1}
              placeholder="Installation default"
              value={budgets[field.key]}
              onChange={(event) => change(field.key, event.target.value)}
            />
          </Field>
        ))}
      </FieldGroup>
    </Disclosure>
  </FieldSet>
);

export const AgentEditor = ({
  agent,
  setup,
  onSaved,
  onCancel,
}: {
  agent: AgentDetail | null;
  setup: Setup;
  onSaved: (agentId: string) => Promise<void>;
  onCancel: () => void;
}) => {
  const initial = agentEditorValues(agent);
  const { unavailableSelections } = initial;
  const hasUnavailableSelections =
    unavailableSelections.model !== null ||
    unavailableSelections.toolIds.length > 0 ||
    unavailableSelections.sourceIds.length > 0;
  const [name, setName] = useState(initial.name);
  const [instructions, setInstructions] = useState(initial.instructions);
  const [model, setModel] = useState(initial.model);
  const [connectors, setConnectors] = useState(initial.toolIds);
  const [sources, setSources] = useState(initial.sourceIds);
  const [team, setTeam] = useState(initial.team);
  const selectedToolIds = useMemo(() => new Set(connectors), [connectors]);
  const selectedSourceIds = useMemo(() => new Set(sources), [sources]);
  const [errorMessage, setErrorMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [catalog, setCatalog] = useState(initial.catalog);
  useEffect(() => {
    if (agent) {
      return;
    }
    const controller = new AbortController();
    const load = async () => {
      try {
        const configured = await request(
          productPath("catalog"),
          catalogSchema,
          { signal: controller.signal }
        );
        if (controller.signal.aborted) {
          return;
        }
        setCatalog(configured);
        setModel(configured.modelChoices[0]?.id ?? "");
      } catch (error) {
        if (!controller.signal.aborted) {
          setErrorMessage(messageOf(error));
        }
      }
    };
    load();
    return () => controller.abort();
  }, [agent]);
  const choices = catalog.connectorChoices;
  const { modelChoices } = catalog;
  const saveIntent = useRef<OperationIntent | null>(null);
  const save = async () => {
    setBusy(true);
    setErrorMessage("");
    const grants = agentExecutionGrants(
      setup.organizationId,
      connectors,
      sources,
      agent?.definition.grants,
      catalog.connectorChoices
    );
    const teamSection = agentTeamSection(team);
    const input = {
      enabledToolIds: connectors,
      grants,
      instructions: instructions.trim(),
      model,
      name: name.trim(),
      ...(teamSection ? { team: teamSection } : {}),
      ...(agent ? { expectedVersion: agent.definition.version } : {}),
    };
    try {
      const saved = await mutate(
        productPath(agent ? `agents/${encoded(agent.agentId)}` : "agents"),
        { ...input, operationId: operationFor(saveIntent, input) },
        savedAgentSchema,
        agent ? "PUT" : "POST"
      );
      await onSaved(saved.agentId);
    } catch (error) {
      setErrorMessage(messageOf(error));
    }
    setBusy(false);
  };
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      aria-labelledby="agent-editor-title"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <PageBody className="@container">
        <PageIntro
          id="agent-editor-title"
          hiddenTitle
          title={agent ? `Edit ${agent.name}` : "Create an agent"}
          action={
            agent ? (
              <Badge variant="outline">
                Version {agent.definition.version}
              </Badge>
            ) : null
          }
        >
          Each save publishes a new version. Earlier versions remain available
          for existing runs.
        </PageIntro>
        {hasUnavailableSelections ? (
          <Alert
            role="note"
            className="border-warning-border bg-warning text-warning-foreground"
          >
            <TriangleAlert aria-hidden="true" />
            <AlertDescription className="text-warning-foreground">
              {unavailableSelections.model === null
                ? ""
                : `Saved model ${unavailableSelections.model} is unavailable. `}
              {unavailableSelections.model !== null && model
                ? `This draft uses ${model}. `
                : ""}
              {unavailableSelections.model !== null && !model
                ? "No configured model is available. "
                : ""}
              {unavailableSelections.toolIds.length > 0
                ? `Unavailable tools removed from this draft: ${unavailableSelections.toolIds.join(", ")}. `
                : ""}
              {unavailableSelections.sourceIds.length > 0
                ? `Unavailable sources removed from this draft: ${unavailableSelections.sourceIds.join(", ")}. `
                : ""}
              Publish a new version to apply these changes to new messages.
            </AlertDescription>
          </Alert>
        ) : null}
        {errorMessage ? <ErrorAlert>{errorMessage}</ErrorAlert> : null}
        <div className="grid gap-8 @4xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="agent-name">Agent name</FieldLabel>
              <Input
                id="agent-name"
                autoComplete="off"
                placeholder="Company assistant"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={120}
                required
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="agent-instructions">Instructions</FieldLabel>
              <Textarea
                id="agent-instructions"
                aria-describedby="agent-instructions-help"
                className="min-h-64"
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                required
              />
              <FieldDescription id="agent-instructions-help">
                The agent follows these in every conversation.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="agent-model">Model</FieldLabel>
              <Select
                items={modelChoices.map((choice) => ({
                  label: choice.label,
                  value: choice.id,
                }))}
                value={model}
                onValueChange={(value) => {
                  if (typeof value === "string") {
                    setModel(value);
                  }
                }}
              >
                <SelectTrigger id="agent-model" className="w-full">
                  <SelectValue placeholder="No model available" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {modelChoices.map((choice) => (
                      <SelectItem key={choice.id} value={choice.id}>
                        {choice.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          <FieldGroup>
            <AgentToolPicker
              choices={choices}
              selected={selectedToolIds}
              toggle={(id, checked) =>
                setConnectors((current) =>
                  checked
                    ? [...current, id]
                    : current.filter((value) => value !== id)
                )
              }
            />
            <FieldSeparator />
            <ChoiceGroup
              id="agent-source"
              legend="Company sources"
              help="Select sources this agent can read and cite."
              empty="No company sources are configured for this installation."
              choices={catalog.sourceChoices}
              selected={selectedSourceIds}
              toggle={(id, checked) =>
                setSources((current) =>
                  checked
                    ? [...current, id]
                    : current.filter((sourceId) => sourceId !== id)
                )
              }
            />
            <FieldSeparator />
            <TeamBudgetFields
              budgets={team}
              change={(key, value) =>
                setTeam((current) => ({ ...current, [key]: value }))
              }
            />
          </FieldGroup>
        </div>
      </PageBody>
      <div className="bg-background border-t">
        <div className="mx-auto flex w-full max-w-(--measure-page) items-center gap-2 px-4 py-3 md:px-6">
          <Button
            disabled={busy || !model || !name.trim() || !instructions.trim()}
            type="submit"
          >
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {saveLabel(busy, Boolean(agent))}
          </Button>
          <Button
            variant="ghost"
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>
      </div>
    </form>
  );
};
