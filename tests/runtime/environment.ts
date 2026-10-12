import type { SessionAgent } from "./fixture-session.ts";

export interface TestEnvironment extends Readonly<Record<string, unknown>> {
  readonly AUDIT_SINK: Fetcher;
  readonly DATABASE_URL: string;
  readonly FAIL_FIRST_EFFECT: "0" | "1";
  readonly FIXTURE_URL: string;
  readonly SESSION: DurableObjectNamespace<SessionAgent>;
  readonly TRACE_NATIVE: "0" | "1";
}
