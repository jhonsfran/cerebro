# Design verdict

Use Candidate B as the final composition. Apply Candidate A's staged implementation order. Keep one experiment project, one check registry, and one final full-composition run. Intermediate probes diagnose failures. They cannot establish that the complete stack works together.

| Criterion | Verdict |
| --- | --- |
| Reproducibility | Both retain pinned versions, native deployment, persistent volumes, and the two required Compose commands. B better preserves one final application. |
| Runtime coverage | B explicitly requires a final combined run. Retain that requirement. A offers earlier evidence if a later SDK cannot load. |
| Failure diagnosis | A is stronger. Deploy and check API, database, auth, Agents/OpenCode, then tools and recovery. Keep dependent failures visible as not run. |
| Implementation size | B is smaller when it uses one registry and one external check process. Avoid A's separate celld supervisor plus host restart wrapper. |

Keep process control in the check container. If Docker access is needed for controlled Compose failures, expose it only there and document its host authority. Add a controller only if the environment requires that boundary. The Worker must never own process control. Restrict script targets to the named experiment services and preserve volumes.

Retain separate MinIO services for runtime and application storage unless pinned R2 binding source proves that separate physical buckets meet the requirement. Shared object-store credentials must not reach tool wrappers. A fixture effect journal may use its own PostgreSQL schema, but database-outage checks must distinguish fixture unavailability from celld failure.

Retained requirements are real Worker PostgreSQL traffic, independent commit/rollback observation, request-bound database connections, positive production TLS evidence, actual Better Auth cookie flows, the real Agents/OpenCode composition, persistent OpenCode session identity, isolated conversations, brokered tools with disabled ambient egress, durable approvals, deterministic crash barriers, provider idempotency and unknown-outcome handling, recovery without a new user request, rebuild/restart checks, and one/ten-session measurements.

Neither design has yet established the pinned OpenCode custom provider, tool interception, built-in disablement, and approval APIs. Resolve these from installed declarations before implementation. Missing APIs are compatibility failures. A mock loop or post-call observer cannot satisfy the gate.

Use B's discriminated check and invocation records. Keep required criteria in a fixed manifest. Missing credentials and unproved TLS remain incomplete. The full required gate must exit nonzero until all required runtime evidence exists.
