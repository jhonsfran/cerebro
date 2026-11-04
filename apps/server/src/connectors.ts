import { ChannelError } from "@cerebro/channels/types";
import type {
  ConnectorAdmin,
  ConnectorChange,
  ConnectorInput,
} from "@cerebro/channels/types";
import type { Database } from "@cerebro/db";
import { findSealedAccount } from "@cerebro/db/repositories/accounts";
import {
  deleteAdminConnector,
  findConnector,
  listConnectors,
  saveAdminConnector,
} from "@cerebro/db/repositories/catalog";
import {
  connectorAccountId,
  openCredentials,
  sealCredentials,
} from "@cerebro/tools/accounts";

import type { WorkerEnv } from "./bindings";
import { catalogTools } from "./catalog";
import type { CatalogTool } from "./config";
import { productionEndpoint, withRedactions } from "./config";
import { discoverMcpTools } from "./mcp-discovery";

// Lowercase, digits, and hyphens. No underscore, so `<id>_<tool>` IDs from two
// connectors can never collide.
const CONNECTOR_ID = /^[a-z0-9][a-z0-9-]{0,39}$/u;

const rows = (tools: readonly CatalogTool[]) =>
  tools.map((tool) => ({
    connectorId: tool.connectorId,
    definition: tool,
    id: tool.id,
  }));

export const createConnectorAdmin = (
  env: Pick<WorkerEnv, "ACCOUNT_KEY" | "DEPLOY_MODE">
): ConnectorAdmin => {
  const discover = async (
    connector: {
      readonly id: string;
      readonly url: string;
      readonly readTools: readonly string[];
    },
    headers: Readonly<Record<string, string>>
  ) => {
    try {
      return await discoverMcpTools(connector, headers, env.DEPLOY_MODE);
    } catch {
      throw new ChannelError(
        422,
        "connector-unreachable",
        "The MCP server could not be reached or did not list its tools."
      );
    }
  };
  const save = async (
    database: Database,
    organizationId: string,
    principalId: string,
    connector: {
      readonly id: string;
      readonly url: string;
      readonly readTools: readonly string[];
    },
    headers: Readonly<Record<string, string>>,
    account?: { readonly id: string; readonly sealed: string }
  ): Promise<ConnectorChange> => {
    const { skipped, tools } = await discover(connector, headers);
    await saveAdminConnector(database, {
      ...(account ? { account } : {}),
      id: connector.id,
      organizationId,
      principalId,
      readTools: connector.readTools,
      tools: rows(tools),
      url: connector.url,
    });
    return { id: connector.id, skipped, toolCount: tools.length };
  };
  // Discovers again with the stored credentials. A new read list is stored only
  // when discovery succeeds, so the list always matches the catalog rows.
  const rediscover = async (
    database: Database,
    organizationId: string,
    principalId: string,
    connectorId: string,
    readTools?: readonly string[]
  ): Promise<ConnectorChange> => {
    const connector = await findConnector(
      database,
      organizationId,
      connectorId
    );
    if (!connector) {
      throw new ChannelError(404, "not-found", "The connector was not found.");
    }
    const accountId = connectorAccountId(connectorId);
    const sealed = await findSealedAccount(database, organizationId, accountId);
    const stored = sealed
      ? await openCredentials(
          env.ACCOUNT_KEY,
          { accountId, organizationId },
          sealed
        )
      : undefined;
    return await save(
      database,
      organizationId,
      principalId,
      {
        id: connectorId,
        readTools: readTools ?? connector.readTools,
        url: connector.url,
      },
      stored?.headers ?? {}
    );
  };
  return {
    add: async (
      database,
      organizationId,
      principalId,
      input: ConnectorInput
    ) => {
      let url: URL;
      try {
        url = new URL(input.url);
      } catch {
        throw new ChannelError(422, "invalid-input", "Enter a valid URL.");
      }
      if (
        !CONNECTOR_ID.test(input.id) ||
        url.username ||
        url.password ||
        url.hash ||
        (env.DEPLOY_MODE === "production" && !productionEndpoint(url.href))
      ) {
        throw new ChannelError(
          422,
          "invalid-input",
          "Use a lowercase connector ID and an HTTPS URL without credentials."
        );
      }
      const existing = await listConnectors(database, organizationId);
      if (existing.some((connector) => connector.id === input.id)) {
        throw new ChannelError(
          409,
          "conflict",
          "A connector with this ID already exists."
        );
      }
      const accountId = connectorAccountId(input.id);
      const account = {
        id: accountId,
        sealed: await sealCredentials(
          env.ACCOUNT_KEY,
          { accountId, organizationId },
          withRedactions({ headers: { ...input.headers }, secrets: [] })
        ),
      };
      return await save(
        database,
        organizationId,
        principalId,
        { id: input.id, readTools: input.readTools ?? [], url: url.href },
        input.headers,
        account
      );
    },
    list: async (database, organizationId) => {
      const connectors = await listConnectors(database, organizationId);
      const tools = await catalogTools(database, organizationId);
      return connectors.map((connector) => ({
        ...connector,
        tools: tools.flatMap((tool) =>
          tool.connectorId === connector.id && tool.target.kind === "mcp"
            ? [{ effect: tool.effect, name: tool.target.method }]
            : []
        ),
      }));
    },
    refresh: (database, organizationId, principalId, connectorId) =>
      rediscover(database, organizationId, principalId, connectorId),
    setReadTools: (
      database,
      organizationId,
      principalId,
      connectorId,
      readTools
    ) =>
      rediscover(database, organizationId, principalId, connectorId, readTools),
    remove: async (database, organizationId, connectorId) => {
      if (!(await findConnector(database, organizationId, connectorId))) {
        throw new ChannelError(
          404,
          "not-found",
          "The connector was not found."
        );
      }
      await deleteAdminConnector(
        database,
        organizationId,
        connectorId,
        connectorAccountId(connectorId)
      );
    },
  };
};
