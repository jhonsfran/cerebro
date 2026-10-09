import type {
  AuthorizationPolicy,
  ContentDependencies,
  ExecutionContext,
  PortResult,
} from "@cerebro/contracts";
import type { EventAddress } from "@cerebro/contracts/events";
import type { SessionService } from "@cerebro/contracts/session-service";
import type { Database } from "@cerebro/db";
import type { ChannelItemBody } from "@cerebro/db/schema/agents";

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
export interface AuditView {
  readonly runId: string;
  readonly state: string;
  readonly entries: readonly {
    readonly at: number;
    readonly description: string;
    readonly type: string;
  }[];
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
  readonly readAudit?: (
    database: Database,
    context: ExecutionContext,
    input: {
      readonly conversationId: string;
      readonly sessionId: string;
      readonly runId: string;
    }
  ) => Promise<PortResult<AuditView>>;
  readonly checkContentDependencies?: (
    database: Database,
    context: ExecutionContext,
    dependencies: ContentDependencies
  ) => Promise<PortResult<void>>;
  readonly sessions: (database: Database) => SessionService;
  readonly observationResponse?: (input: {
    readonly accessGeneration: number;
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
export type ChannelPresentationItem = ChannelItemBody & {
  readonly cursor: string;
};
export const INSTALLATION_AGENT_PREFIX = "installation:";
export const EFFECT_DEADLINE_MS = 2200;
export const DELIVERY_TIMEOUT_MS = 30_000;
