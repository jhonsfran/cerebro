# ADR 0001 keeps application behavior independent of replaceable components

Status is proposed. Revised on 2026-10-09. This record does not describe a completed migration.

## Context

Cerebro needs company policy, durable work, controlled tools, and usable chat. The prototype couples those behaviors to celld, OpenCode, and Cloudflare chat libraries.

The current delivery plan retains celld and replaces OpenCode and AI SDK with Pi Durable. TanStack AI and AG-UI were selected for the first slice and removed on 2026-10-09; the [chat simplification design](../superpowers/specs/2026-10-09-chat-simplification-design.md) records why. New Cerebro orchestration uses the latest published Effect 4 release, pinned at 4.0.1 in the S1-0 proposal. S1-0 requested the latest published Pi and TanStack packages and recorded their exact pins and isolated compatibility evidence; the TanStack pins were removed with the chat simplification. Future component changes must not require another company-policy implementation.

## Decision

Organize code around company behavior and a few explicit integration boundaries. Add an interface where a component has an independent lifecycle or a high replacement cost.

Reuse the meanings of `SessionService`, `AuthorizationPolicy`, and `ToolExecutor` through Effect service contracts. Define an external metering port without implementing a local budget authority. Keep contracts in Cerebro terms. Vendor configuration, SDK contexts, clients, connections, and storage handles stay in implementations.

Keep one application operation for each business action. HTTP, web chat, Slack, and agent tools call that operation. The application verifies current company access and coordinates approvals. External metering remains unbound in the first slice.

Pi owns its private session, durable inbox, steering, model/tool loop, submission deduplication, native Stop semantics and engine recovery. The official PiHarness supplies persistence and Lifecycle wake-up. The thin Effect adapter translates public vendor calls; the conversation coordinator owns trusted command intents, durable product state and repair of its handoff and projection. It does not implement another execution queue or alarm scheduler. Cerebro owns action-approval decisions and operation identities. SDK permission prompts must not create another independent approval authority.

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

## S1-0 qualification status

The [S1-0 contract proposal](2026-10-05-cerebro-slice-1-contracts.md) selects official PiHarness + Lifecycle on retained celld 0.6.1 with `nodejs_compat`, following the operator's latest-version direction and instruction to proceed with inexpensive fixes and recorded TODOs. This overrides the preparation stop gate; qualification remains partial and ADR status remains proposed. The coordinator can review and publish the contracts for later implementation packets.

The recovery investigation found celld's default sixty-second cold-alarm discovery scan exceeds the earlier forty-five-second test window. Default automatic recovery passed in separate local-store process-restart probes on 0.6.0 and 0.6.1, and request-triggered resume passed on 0.6.1. The functional fixture now allows ninety seconds without HTTP and checks saved answers before blocking waits. Previous failed results remain archived. This does not qualify production durability, separate idle eviction or the plan's sixty-second performance budget. Pi and Lifecycle still own recovery; no Cerebro scheduler is introduced.

The operator subsequently chose a thin adapter that reuses Pi's native follow-up queue, steering and Stop semantics. Follow-ups enter Pi's inbox; steering joins current work after its tool round. Active Stop withdraws queued inputs as Pi defines. Replace composes native Stop and submission in the same conversation. The prior requirement to preserve already-queued inputs across active Stop is superseded; its executed failed case remains visible. Cerebro's custom admission queue and host admission job are removed. The direct storage/wake prototype remains historical only.

Proposed ports distinguish durable domain revision, ephemeral observation epoch and client access generation. Every acknowledgement requires PiHarness acceptance, which includes its inbox and Lifecycle wake, plus the Cerebro acceptance marker. The product command journal retains immutable input/mode, replacement phase and projection state; it is not another execution queue. Replacement retry/crash repair remains an explicit TODO. Approvals bind run identity and connector-registration fingerprint. Effect contract fakes and local host probes do not establish production bucket durability, tool interruption or crash-handoff guarantees. Deferred cases remain in `tests/pi-durable-qualification/todos.json`.

External metering stays unbound, spend control through it is inactive, and native Python remains outside this slice. Manifests and locks remain coordinator-owned. These paragraphs record the S1-0 selection and its limits.

## S1-F integration status

The coordinator imported the reviewed packets locally in B, A, C, D order and completed the shared application composition and caller migration. Active OpenCode, AI SDK and local-budget execution paths are removed. Historical usage, audit, authentication and company records remain. The [integration record](2026-10-07-cerebro-slice-1-integration.md) identifies the exact packet heads and executed candidate evidence.

Official Lifecycle jobs also retain product projection repair. This repair observes existing native work and commits missing canonical product state. It must not submit another input, call Stop or weaken execution membership checks. A typed transient projection failure can retry; a terminal failure retains a safe diagnostic. This is product-state repair under the selected host lifecycle, not a second execution queue.

The ADR remains proposed until all required final-candidate unit, host, browser, dependency, credentialed live and performance gates pass. A passing packet or earlier candidate does not establish that verdict. Deployment and customer-data cutover remain outside the local integration operation.

## Acceptance and maintenance

The [first-slice plan](2026-10-05-cerebro-slice-1-plan.md) defines the runtime checks and later stages.

Accept this record after the implementation follows these rules and the replacement passes its gate. Record measured limits and remaining gaps in the current architecture overview.

Write another ADR for a later major choice. Supersede accepted decisions explicitly. Keep one current architecture overview and one active delivery plan.
