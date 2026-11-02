import { Badge } from "@cerebro/ui/components/badge";
import { Button } from "@cerebro/ui/components/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@cerebro/ui/components/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@cerebro/ui/components/empty";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@cerebro/ui/components/field";
import { Input } from "@cerebro/ui/components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@cerebro/ui/components/item";
import { Skeleton } from "@cerebro/ui/components/skeleton";
import { Spinner } from "@cerebro/ui/components/spinner";
import { Plug } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { encoded, mutate, productPath, request } from "./api";
import { ConfirmRemoval } from "./confirm-removal";
import { ErrorAlert, PageBody, PageIntro } from "./feedback";
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
  const [errorMessage, setErrorMessage] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const listed = await listConnectors(controller.signal);
        if (!controller.signal.aborted) {
          setConnectors(listed);
          setLoaded(true);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setErrorMessage(messageOf(error));
          setLoaded(true);
        }
      }
    };
    load();
    return () => controller.abort();
  }, []);
  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    setErrorMessage("");
    setConfirming(null);
    try {
      const message = await action();
      setConnectors(await listConnectors());
      toast.success(message);
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
    <PageBody>
      <PageIntro id="connectors-title" title="MCP servers your agents can use">
        Tools a server marks read-only run without approval. Every other tool
        asks for approval before it runs. Enable tools in the agent
        configuration.
      </PageIntro>
      {errorMessage ? <ErrorAlert>{errorMessage}</ErrorAlert> : null}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section
          className="flex flex-col gap-3"
          aria-labelledby="connectors-list-title"
        >
          <div className="flex min-h-7 items-center">
            <h3 id="connectors-list-title" className="text-xs font-medium">
              Configured servers
            </h3>
          </div>
          {loaded ? null : (
            <div className="flex flex-col gap-2" aria-busy="true">
              <span className="sr-only">Loading connectors…</span>
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
            </div>
          )}
          {loaded && connectors.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Plug aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No connectors yet</EmptyTitle>
                <EmptyDescription>
                  Add an MCP server with the form.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
          {connectors.length > 0 ? (
            <ItemGroup className="gap-2">
              {connectors.map((connector) => (
                <Item variant="outline" className="bg-card" key={connector.id}>
                  <ItemContent>
                    <ItemTitle>
                      <span className="font-mono">{connector.id}</span>
                      <Badge variant="secondary">
                        {connector.toolCount === 1
                          ? "1 tool"
                          : `${connector.toolCount} tools`}
                      </Badge>
                    </ItemTitle>
                    <ItemDescription className="break-all">
                      {connector.url ?? "Declared in runtime.json"}
                      {connector.source === "admin"
                        ? ", added here"
                        : ", from the runtime file"}
                    </ItemDescription>
                  </ItemContent>
                  {connector.source === "admin" ? (
                    <ItemActions>
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        disabled={busy}
                        onClick={() => refresh(connector.id)}
                      >
                        Refresh
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirming(connector.id)}
                      >
                        Remove
                      </Button>
                    </ItemActions>
                  ) : null}
                </Item>
              ))}
            </ItemGroup>
          ) : null}
        </section>
        <Card>
          <form
            className="contents"
            aria-labelledby="connector-form-title"
            onSubmit={(event) => {
              event.preventDefault();
              add();
            }}
          >
            <CardHeader>
              <CardTitle>
                <h3 id="connector-form-title">Add a connector</h3>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="connector-id">Connector ID</FieldLabel>
                  <Input
                    id="connector-id"
                    aria-describedby="connector-id-help"
                    autoComplete="off"
                    className="font-mono"
                    placeholder="crm"
                    pattern="[a-z0-9][a-z0-9-]{0,39}"
                    value={id}
                    onChange={(event) => setId(event.target.value)}
                    required
                  />
                  <FieldDescription id="connector-id-help">
                    Lowercase letters, numbers and hyphens, up to 40 characters.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="connector-url">
                    MCP server URL
                  </FieldLabel>
                  <Input
                    id="connector-url"
                    autoComplete="off"
                    placeholder="https://mcp.example.com/mcp"
                    type="url"
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    required
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="connector-token">
                    Bearer token (optional)
                  </FieldLabel>
                  <Input
                    id="connector-token"
                    aria-describedby="connector-token-help"
                    autoComplete="off"
                    type="password"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                  />
                  <FieldDescription id="connector-token-help">
                    Sealed on the server and never shown again.
                  </FieldDescription>
                </Field>
              </FieldGroup>
            </CardContent>
            <CardFooter>
              <Button disabled={busy} type="submit">
                {busy ? <Spinner data-icon="inline-start" /> : null}
                Add connector
              </Button>
            </CardFooter>
          </form>
        </Card>
      </div>
      <ConfirmRemoval
        target={confirming}
        busy={busy}
        onCancel={() => setConfirming(null)}
        onConfirm={remove}
      >
        Agents lose every tool this server provides. Add it again to restore
        them.
      </ConfirmRemoval>
    </PageBody>
  );
};
