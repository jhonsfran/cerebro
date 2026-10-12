import type {
  AuthorizationPolicy,
  ExecutionContext,
  PortResult,
} from "@cerebro/contracts";
import type { EventAddress } from "@cerebro/contracts/events";
import type { ChatClient } from "@cerebro/contracts/session-service";
import type { Database } from "@cerebro/db";

export interface SlackConfiguration {
  readonly workspaceId: string;
  readonly appId: string;
  readonly agentId: string;
  readonly signingSecret: string;
  readonly botToken?: string;
  readonly apiUrl?: string;
}
export interface ChannelCatalog {
  readonly sourceChoices?: readonly {
    readonly id: string;
    readonly label: string;
  }[];
  readonly modelChoices: readonly {
    readonly id: string;
    readonly label: string;
  }[];
  readonly connectorChoices: readonly {
    readonly connectorId?: string;
    readonly id: string;
    readonly label: string;
  }[];
}
export interface SourceView {
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly text: string;
  readonly title: string;
}
export interface ConnectorView {
  readonly id: string;
  readonly source: "admin" | "runtime.json";
  readonly toolCount: number;
  readonly url: string | null;
}
export interface ConnectorInput {
  readonly id: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}
export interface ConnectorChange {
  readonly id: string;
  readonly toolCount: number;
  readonly skipped: readonly string[];
}
// MCP connectors that administrators manage at runtime. The service authorizes;
// the host discovers tools, seals credentials, and writes the catalog.
export interface ConnectorAdmin {
  readonly list: (
    database: Database,
    organizationId: string
  ) => Promise<readonly ConnectorView[]>;
  readonly add: (
    database: Database,
    organizationId: string,
    principalId: string,
    input: ConnectorInput
  ) => Promise<ConnectorChange>;
  readonly refresh: (
    database: Database,
    organizationId: string,
    principalId: string,
    connectorId: string
  ) => Promise<ConnectorChange>;
  readonly remove: (
    database: Database,
    organizationId: string,
    connectorId: string
  ) => Promise<void>;
}
export interface ChannelOptions {
  readonly mode: "local" | "production";
  readonly organizationId: string;
  readonly withDatabase: <T>(
    run: (database: Database) => Promise<T>
  ) => Promise<T>;
  readonly slack?: SlackConfiguration;
  readonly bootstrapToken?: string;
  readonly trustedOwnerUserId?: string;
  readonly catalog?: ChannelCatalog;
  readonly connectors?: ConnectorAdmin;
  readonly catalogFor?: (
    database: Database,
    context: ExecutionContext
  ) => Promise<PortResult<ChannelCatalog>>;
  readonly readSource?: (
    database: Database,
    context: ExecutionContext,
    input: {
      readonly conversationId: string;
      readonly sessionId: string;
      readonly sourceId: string;
    }
  ) => Promise<PortResult<SourceView>>;
  readonly sessions: (database: Database) => ChatClient;
  readonly observationResponse?: (input: {
    readonly address: EventAddress;
    readonly context: ExecutionContext;
    readonly signal: AbortSignal;
  }) => Promise<Response>;
  readonly authorization?: (database: Database) => AuthorizationPolicy;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
}
export interface ProductHandlerOptions extends ChannelOptions {
  readonly getUser: (
    request: Request,
    database: Database
  ) => Promise<{ id: string } | null>;
}
export class ChannelError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ChannelError";
    this.status = status;
    this.code = code;
  }
}
export type AccessAction = "read" | "execute" | "approve";
export const INSTALLATION_AGENT_PREFIX = "installation:";
export const EFFECT_DEADLINE_MS = 2200;
export const DELIVERY_TIMEOUT_MS = 30_000;
