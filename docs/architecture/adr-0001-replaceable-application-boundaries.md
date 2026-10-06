# ADR 0001 keeps application behavior independent of replaceable components

Status is proposed. Revised on 2026-10-06. This record does not describe a completed migration.

## Context

Cerebro needs company policy, durable work, controlled tools, and usable chat. The prototype couples those behaviors to celld, OpenCode, and Cloudflare chat libraries.

The current delivery plan retains celld and replaces OpenCode and AI SDK with Pi Durable and TanStack AI. New Cerebro orchestration uses the latest published Effect 4 release, pinned at 4.0.1 in the S1-0 proposal. S1-0 requests the latest published Pi and TanStack packages and records their exact pins and isolated compatibility evidence. Future component changes must not require another company-policy implementation.

## Decision

Organize code around company behavior and a few explicit integration boundaries. Add an interface where a component has an independent lifecycle or a high replacement cost.

Reuse the meanings of `SessionService`, `AuthorizationPolicy`, and `ToolExecutor` through Effect service contracts. Separate durable tool receipts from historical budget journal states. Define an external metering port without implementing a local budget authority. Keep contracts in Cerebro terms. Vendor configuration, SDK contexts, clients, connections, and storage handles stay in implementations.

Keep one application operation for each business action. HTTP, web chat, Slack, and agent tools call that operation. The application verifies current company access and coordinates approvals and tool receipts. External metering remains unbound in the first slice.

Pi owns its private session, model loop, and engine recovery. The conversation coordinator owns admission, durable product state, stop, and recovery of its handoff to Pi. Cerebro owns action-approval decisions and operation identities. SDK permission prompts must not create another independent approval authority.

Each fact has one authority. Product history and tool receipts use Cerebro tables in the session's SQLite store. PostgreSQL owns company records. Browser and channel history are projections. Pi checkpoints are private engine state. A future external meter owns pricing, balances, and reservations. Historical budget records remain preserved.

Preserve intent before external dispatch. Record confirmed results afterward. An uncertain non-idempotent effect stops for reconciliation. Neither actors nor database transactions guarantee exactly-once execution in a remote system.

## Dependency rules

| Area | Permitted dependencies |
| --- | --- |
| `packages/contracts` | Cerebro data, boundary schemas, Effect service types, and typed failures. No host, engine, UI protocol, authentication, or ORM SDK types. |
| Company application behavior | Contracts, current policy, repositories, and explicit effect ports. No browser or actor context. |
| celld and Pi adapters | Application behavior and contracts. Own engine setup, persistence integration, host lifecycle, and vendor event translation. |
| TanStack and AG-UI adapters | Authorized domain observations and command receipts. Own protocol translation and browser state. No model or tool execution loop. |
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

The cost is explicit ownership at the boundaries. The Cerebro-to-Pi handoff, approval wait, host wake-up, cancellation, and TanStack observation need runtime proof. Effect scopes do not provide durable execution by themselves.

This proposal rejects a generic plugin framework, a broad rewrite of existing company services, and a second policy or approval engine. It uses Effect Layers for the selected adapters and preserves one company authority.

## S1-0 qualification status

The [S1-0 contract proposal](2026-10-05-cerebro-slice-1-contracts.md) records candidate failures on retained celld 0.6.0. The official PiHarness active-operation abort also withdraws queued inputs. The tested portable-storage fallback preserves the queued receipt but fails to progress it after cancellation and restart. No implementation or contracts are frozen; S1-A through S1-D remain blocked. Published TanStack hydrate/joinRun and ChatClient attach/detach passed a headless probe; browser, permission-stream and recovery acceptance remain unverified.

Proposed ports distinguish durable domain revision, ephemeral observation epoch and client access generation. Acknowledgement requires admission, engine acceptance and persisted wake. Approval proposals bind the run and connector-registration fingerprint in addition to existing fields. Effect typed failures and receipt state do not imply host durability. External metering stays unbound, spend control through it is inactive, and native Python remains outside this slice. Manifests and locks remain coordinator-owned requests.

## Acceptance and maintenance

The [first-slice plan](2026-10-05-cerebro-slice-1-plan.md) defines the runtime checks and later stages.

Accept this record after the implementation follows these rules and the replacement passes its gate. Record measured limits and remaining gaps in the current architecture overview.

Write another ADR for a later major choice. Supersede accepted decisions explicitly. Keep one current architecture overview and one active delivery plan.
