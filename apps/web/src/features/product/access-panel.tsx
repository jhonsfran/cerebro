import { useRef, useState } from "react";

import { encoded, mutate, productPath } from "./api";
import { operationFor } from "./intent";
import type { OperationIntent } from "./intent";
import { accessMutationSchema } from "./types";
import type { AccessAction, AgentDetail } from "./types";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "The request failed.";

export const AccessPanel = ({
  agent,
  refresh,
}: {
  agent: AgentDetail;
  refresh: () => Promise<void>;
}) => {
  const [errorMessage, setErrorMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const accessIntent = useRef<OperationIntent | null>(null);
  const change = async (principalId: string, actions: AccessAction[]) => {
    setBusy(true);
    setErrorMessage("");
    try {
      await mutate(
        productPath(
          `agents/${encoded(agent.agentId)}/access/${encoded(principalId)}`
        ),
        {
          actions,
          operationId: operationFor(accessIntent, {
            actions,
            agentId: agent.agentId,
            principalId,
          }),
        },
        accessMutationSchema,
        "PUT"
      );
      await refresh();
      accessIntent.current = null;
    } catch (error) {
      setErrorMessage(messageOf(error));
    }
    setBusy(false);
  };
  return (
    <section className="settings-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Access management</p>
          <h2>Who can use {agent.name}?</h2>
        </div>
      </div>
      <p className="muted-text">
        Changes apply to the next action in web and linked Slack conversations.
      </p>
      {errorMessage ? (
        <p className="error-banner" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <div className="access-table">
        <div className="access-row access-labels">
          <span>Company principal</span>
          <span>Read</span>
          <span>Execute</span>
          <span>Approve</span>
        </div>
        {agent.access.map((entry) => (
          <div className="access-row" key={entry.principalId}>
            <div>
              <strong>{entry.name}</strong>
              <small>{entry.principalId}</small>
            </div>
            {(["read", "execute", "approve"] as const).map((action) => (
              <label key={action}>
                <span className="sr-only">
                  {action} access for {entry.name}
                </span>
                <input
                  type="checkbox"
                  checked={entry.actions.includes(action)}
                  disabled={busy}
                  onChange={(event) =>
                    change(
                      entry.principalId,
                      event.target.checked
                        ? [...entry.actions, action]
                        : entry.actions.filter((value) => value !== action)
                    )
                  }
                />
              </label>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
};
