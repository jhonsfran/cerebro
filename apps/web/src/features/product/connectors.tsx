import { useEffect, useState } from "react";

import { encoded, mutate, productPath, request } from "./api";
import {
  connectorChangeSchema,
  connectorListSchema,
  connectorRemovedSchema,
} from "./types";
import type { ConnectorView } from "./types";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "The request failed.";
const summary = (change: {
  readonly toolCount: number;
  readonly skipped: readonly string[];
}) =>
  `${change.toolCount} tools listed.${change.skipped.length > 0 ? ` Skipped: ${change.skipped.join(", ")}.` : ""}`;
const listConnectors = async (signal?: AbortSignal) => {
  const value = await request(
    productPath("connectors"),
    connectorListSchema,
    signal ? { signal } : undefined
  );
  return value.connectors;
};

// MCP servers whose tools agents can enable. Adding or refreshing lists the
// server's tools into the catalog. Credentials are sealed on the server and
// never shown again.
export const ConnectorsPanel = () => {
  const [connectors, setConnectors] = useState<ConnectorView[]>([]);
  const [id, setId] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const listed = await listConnectors(controller.signal);
        if (!controller.signal.aborted) {
          setConnectors(listed);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setErrorMessage(messageOf(error));
        }
      }
    };
    load();
    return () => controller.abort();
  }, []);
  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setErrorMessage("");
    setNotice("");
    try {
      const message = await action();
      setConnectors(await listConnectors());
      setNotice(message);
    } catch (error) {
      setErrorMessage(messageOf(error));
    }
    setBusy(false);
  };
  const add = () =>
    run(async () => {
      const change = await mutate(
        productPath("connectors"),
        {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          id,
          url,
        },
        connectorChangeSchema
      );
      setId("");
      setUrl("");
      setToken("");
      return `Added ${change.id}. ${summary(change)}`;
    });
  const refresh = (connectorId: string) =>
    run(async () => {
      const change = await mutate(
        productPath(`connectors/${encoded(connectorId)}/refresh`),
        {},
        connectorChangeSchema
      );
      return `Refreshed ${change.id}. ${summary(change)}`;
    });
  const remove = (connectorId: string) =>
    run(async () => {
      await mutate(
        productPath(`connectors/${encoded(connectorId)}`),
        {},
        connectorRemovedSchema,
        "DELETE"
      );
      return `Removed ${connectorId} and its tools.`;
    });
  return (
    <section className="settings-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Connectors</p>
          <h2>MCP servers your agents can use</h2>
        </div>
      </div>
      <p className="muted-text">
        Tools a server marks read-only run without approval. Every other tool
        asks for approval before it runs. Enable tools in the agent
        configuration.
      </p>
      {errorMessage ? (
        <p className="error-banner" role="alert">
          {errorMessage}
        </p>
      ) : null}
      {notice ? <output className="muted-text">{notice}</output> : null}
      <div className="access-table">
        <div className="access-row access-labels">
          <span>Connector</span>
          <span>Tools</span>
          <span>Source</span>
          <span />
        </div>
        {connectors.map((connector) => (
          <div className="access-row" key={connector.id}>
            <div>
              <strong>{connector.id}</strong>
              <small>{connector.url ?? "Declared in runtime.json"}</small>
            </div>
            <span>{connector.toolCount}</span>
            <span>{connector.source === "admin" ? "Added here" : "File"}</span>
            {connector.source === "admin" ? (
              <span className="row-actions">
                <button
                  className="text-button"
                  type="button"
                  disabled={busy}
                  onClick={() => refresh(connector.id)}
                >
                  Refresh
                </button>
                <button
                  className="text-button"
                  type="button"
                  disabled={busy}
                  onClick={() => remove(connector.id)}
                >
                  Remove
                </button>
              </span>
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>
      <form
        className="agent-form"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <label htmlFor="connector-id">Connector ID</label>
        <input
          id="connector-id"
          autoComplete="off"
          placeholder="crm"
          pattern="[a-z0-9][a-z0-9-]{0,39}"
          value={id}
          onChange={(event) => setId(event.target.value)}
          required
        />
        <label htmlFor="connector-url">MCP server URL</label>
        <input
          id="connector-url"
          autoComplete="off"
          placeholder="https://mcp.example.com/mcp"
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          required
        />
        <label htmlFor="connector-token">Bearer token (optional)</label>
        <input
          id="connector-token"
          autoComplete="off"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <button className="primary-button" disabled={busy} type="submit">
          Add connector
        </button>
      </form>
    </section>
  );
};
