/* oxlint-disable no-redeclare -- Effect service tags and schemas share their TypeScript type name. */
import { Context, Effect } from "effect";

import type { EventAddress } from "./events.ts";
import { Denied } from "./failures.ts";
import type { InvalidInput, Unavailable } from "./failures.ts";
import type { ExecutionContext } from "./identity.ts";
import type { Action, AuthorizationDecision, Resource } from "./policy.ts";
import type { ReadOptions } from "./port.ts";
import type { AgentDefinition } from "./session.ts";
import type { RegisteredTool } from "./tool-service.ts";

export interface AuthorityRequest {
  readonly address: EventAddress;
  readonly context: ExecutionContext;
  readonly action: Action;
  readonly resource: Resource;
  readonly pinnedAgent: AgentDefinition;
  readonly model?: string;
  readonly tool?: RegisteredTool;
}
export interface AuthorityPermit {
  readonly request: AuthorityRequest;
  readonly policyVersion: string;
  readonly evaluatedAt: number;
}
export interface AuthorityService {
  readonly evaluate: (
    request: AuthorityRequest,
    options: ReadOptions
  ) => Effect.Effect<AuthorizationDecision, InvalidInput | Unavailable>;
  readonly require: (
    request: AuthorityRequest,
    options: ReadOptions
  ) => Effect.Effect<AuthorityPermit, Denied | InvalidInput | Unavailable>;
}
export const AuthorityService = Context.Service<AuthorityService>(
  "@cerebro/AuthorityService"
);
export const enforceDecision = (
  request: AuthorityRequest,
  evaluatedAt: number,
  decision: AuthorizationDecision
): Effect.Effect<AuthorityPermit, Denied> =>
  decision.decision === "deny"
    ? Effect.fail(new Denied({ code: "unauthorized", reason: decision.reason }))
    : Effect.succeed({
        evaluatedAt,
        policyVersion: decision.policyVersion,
        request,
      });
