# ADR 0001 keeps application behavior independent of replaceable components

Status is proposed. Date is 2026-10-02. This record does not describe a completed migration.

## Context

Cerebro needs company policy, durable work, controlled tools, and usable chat. The prototype couples those behaviors to celld, OpenCode, and Cloudflare chat libraries.

The user selected a single replacement change for celld and OpenCode. The proposed target is self-hosted Rivet with Pi and AI SDK v7. Future component changes must not require another company-policy implementation.

## Decision

Organize code around company behavior and a few explicit integration boundaries. Add an interface where a component has an independent lifecycle or a high replacement cost.

Reuse `SessionService`, `OperationJournal`, `AuthorizationPolicy`, `BudgetAuthority`, and `ToolExecutor`. Keep each contract in Cerebro terms. Vendor configuration, SDK contexts, clients, connections, and storage handles stay in implementations.

Keep one application operation for each business action. HTTP, web chat, Slack, and agent tools call that operation. The application verifies current company access and coordinates approvals, budget admission, and receipts.

Pi owns its private session and model loop. The conversation coordinator owns admission, durable run state, stop, and recovery. Cerebro owns action-approval decisions and operation identities. SDK permission prompts must not create another independent approval authority.

Each fact has one authority. Product history and operation records use actor SQLite in the proposed target. PostgreSQL owns company records and shared budgets. Browser and channel history are projections. Pi checkpoints are private engine state.

Preserve intent before external dispatch. Record confirmed results afterward. An uncertain non-idempotent effect stops for reconciliation. Neither actors nor database transactions guarantee exactly-once execution in a remote system.

## Dependency rules

| Area | Permitted dependencies |
| --- | --- |
| `packages/contracts` | Cerebro types and boundary schemas. No runtime, transport, authentication, or ORM SDK types. |
| Company application behavior | Contracts, current policy, repositories, and explicit effect ports. No browser or actor context. |
| Rivet and Pi integration | Application behavior and contracts. Owns engine setup, persistence adapter, lifecycle, and event translation. |
| Authentication and transport adapters | Verified credentials, boundary parsing, application calls, and presentation. No separate business rules. |
| `apps/server` composition | Concrete implementations and configuration. Connects the selected components. |

Existing `packages/channels` contains application behavior. Keep that behavior in one place during replacement. Move operations to a clearer application module when another caller needs them. A package rename alone does not improve the design.

Direct Drizzle queries are acceptable in company repositories. Do not add a generic repository for every table. Do not create a universal engine checkpoint, plugin framework, or layer for every function.

## Replacement rules

Replace the implementation and migrate its callers in one change. Delete the old integration and implementation-specific tests. Preserve behavioral tests that still describe company requirements.

A runtime replacement changes the session adapter, persistence integration, and deployment. An engine replacement changes private session handling and event translation. Neither should change company authorization or tool receipts.

Keep one supported implementation per boundary until a real requirement needs another. An alternative component does not need checkpoint compatibility with an old engine.

## Consequences

The benefit is a smaller change area when an expensive component changes. Humans and agents use the same company rules. New engineers can locate behavior without tracing through vendor adapters.

The cost is explicit ownership at the boundaries. The actor SQLite API requires asynchronous persistence changes. Pi interception, recovery, and AI SDK integration need runtime proof.

This proposal rejects a full Clean Architecture framework, a broad Effect rewrite, and a second policy or approval engine. It keeps the useful dependency rule without adding layers that have no independent responsibility.

## Acceptance and maintenance

The [migration plan](/Users/jhonsfran/repos/cerebro/docs/architecture/2026-10-02-rivet-migration-plan.md) defines the runtime checks and later stages.

Accept this record after the implementation follows these rules and the replacement passes its gate. Record measured limits and remaining gaps in the current architecture overview.

Write another ADR for a later major choice. Supersede accepted decisions explicitly. Keep one current architecture overview and one active delivery plan.
