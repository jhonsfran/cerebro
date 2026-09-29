import type {
  SessionEnvironment,
  SessionAgent,
} from "../../packages/runtime/src/session-agent.ts";
import type { LedgerMigrationProbe } from "./migration-probe.ts";

export interface TestEnvironment extends SessionEnvironment {
  readonly AUDIT_SINK: Fetcher;
  readonly DATABASE_URL: string;
  readonly MIGRATION_PROBE: DurableObjectNamespace<LedgerMigrationProbe>;
  readonly SESSION: DurableObjectNamespace<SessionAgent>;
}
