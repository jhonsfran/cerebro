# ADR 0001 keeps application behavior independent of replaceable components

Status is proposed. Revised on 2026-10-09. The [architecture overview](overview.md) describes the system that follows these rules.

## Context

Cerebro needs company policy, durable work, controlled tools, and usable chat. The prototype couples those behaviors to celld, OpenCode, and Cloudflare chat libraries.

Cerebro retains celld and replaced OpenCode and the AI SDK with Pi Durable. New Cerebro orchestration uses Effect 4. Future component changes must not require another company-policy implementation.

## Decision

Organize code around company behavior and a few explicit integration boundaries. Add an interface where a component has an independent lifecycle or a high replacement cost.

Reuse the meanings of `SessionService`, `AuthorizationPolicy`, and `ToolExecutor` through Effect service contracts. Define an external metering port without implementing a local budget authority. Keep contracts in Cerebro terms. Vendor configuration, SDK contexts, clients, connections, and storage handles stay in implementations.

Keep one application operation for each business action. HTTP, web chat, Slack, and agent tools call that operation. The application verifies current company access and coordinates approvals. External metering remains unbound in the first slice.

Pi owns its private session, durable inbox, steering, model and tool loop, submission deduplication, native Stop, tool crash recovery, and engine recovery. The official PiHarness supplies persistence and Lifecycle wake-up. The thin Effect adapter translates public vendor calls. The conversation coordinator owns trusted command intents, durable product state, and repair of its handoff and projection. It does not implement another execution queue or alarm scheduler. Cerebro owns action-approval decisions and operation identities. SDK permission prompts must not create another independent approval authority.

The Durable Object emits authorized observation frames. The HTTP route authenticates the viewer, checks access on attach and on an interval, and forwards the bytes. It does not own the Pi loop. The web app applies the frames to one projection and renders its transcript, approvals and citations from it. Reconnect reads a fresh snapshot, including current partial content, then observes live updates. Pi's in-memory event stream does not provide cursor replay; exact replay would require a separate durable chunk log.

Each fact has one authority. Product history uses Cerebro tables in the session's SQLite store. Tool dispatch markers and outcomes are Pi task memos. PostgreSQL owns company records. Browser and channel history are projections. Pi checkpoints are private engine state. A future external meter owns pricing, balances, and reservations. Historical budget records remain preserved.

Preserve intent before external dispatch. Record confirmed results afterward. An uncertain non-idempotent effect is reported as an unknown outcome and never dispatched again. Neither actors nor database transactions guarantee exactly-once execution in a remote system.

## Dependency rules

| Area | Permitted dependencies |
| --- | --- |
| `packages/contracts` | Cerebro data, boundary schemas, Effect service types, and typed failures. No host, engine, UI protocol, authentication, or ORM SDK types. |
| Company application behavior | Contracts, current policy, repositories, and explicit effect ports. No browser or actor context. |
| celld and Pi adapters | Application behavior and contracts. Own engine setup, persistence integration, host lifecycle, and vendor event translation. |
| Browser observation adapter | Authorized domain observations and command receipts. Owns the browser projection. No model or tool execution loop. |
| Authentication and transport adapters | Verified credentials, boundary parsing, application calls, and presentation. No separate business rules. |
| `apps/server` composition | Concrete implementations and configuration. Connects the selected components. |

Existing `packages/channels` contains application behavior. Keep that behavior in one place during replacement. Move operations to a clearer application module when another caller needs them. A package rename alone does not improve the design.

Direct Drizzle queries are acceptable in company repositories. Do not add a generic repository for every table. Do not create a universal engine checkpoint, plugin framework, or layer for every function.

## Replacement rules

Replace the implementation and migrate its callers in one change. Delete the old integration and implementation-specific tests. Preserve behavioral tests that still describe company requirements.

A runtime replacement changes the session adapter, persistence integration, and deployment. An engine replacement changes private session handling and event translation. Neither should change company authorization or approval binding.

Keep one supported implementation per boundary until a real requirement needs another. An alternative component does not need checkpoint compatibility with an old engine.

## Consequences

The benefit is a smaller change area when an expensive component changes. Humans and agents use the same company rules. New engineers can locate behavior without tracing through vendor adapters.

The cost is explicit ownership at the boundaries. The Cerebro-to-Pi handoff, approval wait, host wake-up, cancellation, and browser observation need runtime proof. Effect scopes do not provide durable execution by themselves.

This proposal rejects a generic plugin framework, a broad rewrite of existing company services, and a second policy or approval engine. It uses Effect Layers for the selected adapters and preserves one company authority.

## Acceptance and maintenance

Accept this record after the implementation follows these rules and passes a credentialed live check against a real model and connector. The deterministic integration suite alone does not establish that verdict.

Write another ADR for a later major choice. Supersede accepted decisions explicitly. Keep one current [architecture overview](overview.md).
