import { useEffect, useMemo, useRef, useState } from "react";

import { encoded, mutate, productPath, request } from "./api";
import { agentEditorValues, agentExecutionGrants } from "./configuration";
import { operationFor } from "./intent";
import type { OperationIntent } from "./intent";
import { catalogSchema, savedAgentSchema } from "./types";
import type { AgentDetail, Setup } from "./types";

const saveLabel = (busy: boolean, editing: boolean): string => {
  if (busy) {
    return "Saving...";
  }
  return editing ? "Publish new version" : "Create agent";
};
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "The request failed.";

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
    const input = {
      enabledToolIds: connectors,
      grants,
      instructions: instructions.trim(),
      model,
      name: name.trim(),
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
    <section className="settings-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Agent configuration</p>
          <h2>{agent ? `Edit ${agent.name}` : "Create an agent"}</h2>
        </div>
        {agent ? (
          <span className="status-pill">
            Version {agent.definition.version}
          </span>
        ) : null}
      </div>
      <p className="muted-text">
        Each save publishes a new version. Earlier versions remain available for
        existing runs.
      </p>
      {hasUnavailableSelections ? (
        <p className="muted-text">
          <output>
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
          </output>
        </p>
      ) : null}
      {errorMessage ? (
        <p className="error-banner" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <form
        className="agent-form"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <label htmlFor="agent-name">Agent name</label>
        <input
          id="agent-name"
          autoComplete="off"
          placeholder="Company assistant"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={120}
          required
        />
        <label htmlFor="agent-instructions">Instructions</label>
        <textarea
          id="agent-instructions"
          rows={6}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          required
        />
        <label htmlFor="agent-model">Model</label>
        <select
          id="agent-model"
          value={model}
          onChange={(event) => setModel(event.target.value)}
        >
          {modelChoices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </select>
        <fieldset>
          <legend>Tools</legend>
          <p className="muted-text">Select tools this agent can execute.</p>
          {choices.map((choice) => (
            <label className="checkbox-row" key={choice.id}>
              <input
                type="checkbox"
                checked={selectedToolIds.has(choice.id)}
                onChange={(event) =>
                  setConnectors((current) =>
                    event.target.checked
                      ? [...current, choice.id]
                      : current.filter((id) => id !== choice.id)
                  )
                }
              />
              <span>{choice.label}</span>
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Company sources</legend>
          <p className="muted-text">
            Select sources this agent can read and cite.
          </p>
          {catalog.sourceChoices.map((choice) => (
            <label className="checkbox-row" key={choice.id}>
              <input
                type="checkbox"
                checked={selectedSourceIds.has(choice.id)}
                onChange={(event) =>
                  setSources((current) =>
                    event.target.checked
                      ? [...current, choice.id]
                      : current.filter((sourceId) => sourceId !== choice.id)
                  )
                }
              />
              <span>{choice.label}</span>
            </label>
          ))}
        </fieldset>
        <div className="button-row">
          <button
            className="primary-button"
            disabled={busy || !model || !name.trim() || !instructions.trim()}
            type="submit"
          >
            {saveLabel(busy, Boolean(agent))}
          </button>
          <button
            className="quiet-button"
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
};
