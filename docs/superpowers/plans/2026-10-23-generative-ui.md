# Generative UI implementation plan

> **For agentic workers:** Use subagent-driven-development or executing-plans to implement this plan task by task. The parent reviews the implementation and verifies the browser path.

**Goal:** Agents can show validated read-only cards and tables inside a durable conversation.

**Architecture:** A shared server-safe catalog defines a restricted json-render tree. An internal `render_ui` tool returns a versioned presentation in Pi result details. Existing authorized snapshots carry accepted presentations to a web-owned React registry.

**Tech stack:** Pi Durable 1.3.0, json-render core and React 0.21.2, Zod 4, Effect 4, React 19, TanStack Start, and existing Docker verification fixtures.

## Scope

Deliver complete read-only specifications. Cards follow the active transcript through reload, reconnect, and native forks. Compaction and reset follow existing transcript behavior. Forms, actions, progressive specifications, and permanent dashboard storage are later features.

Use a named presentation with literal kind and version, a catalog-derived spec, and `fallbackText`. The model supplies `spec` and `fallbackText`. The runtime adds kind and version. Only a successful internal `render_ui` result can publish a presentation.

The shared package owns `Stack`, `Card`, `Text`, `Metric`, `KeyValue`, and `Table` definitions. Each element contains `type`, strict literal props, and `children`. The spec contains `root` and `elements`. Layout elements can contain children. Leaf elements cannot.

Reject unknown fields, actions, expressions, watchers, URLs, arbitrary styles, missing references, shared subtrees, cycles, unreachable elements, and uneven table rows. Bound the accepted envelope to 32 KiB, 64 nodes, depth 8, 8 table columns, and 50 rows. Keep at most 128 KiB of presentation data in a snapshot, retaining the newest cards. Older cards retain text output. Suppress duplicated `render_ui` spec arguments in public presentation records. Child display summaries omit presentations for this first version.

## Design decision

Use a dedicated package with core and Zod dependencies. Keep its Effect adapter in contracts. This avoids a dependency from contracts to the React component library and keeps one catalog for the model and browser.

Two alternatives were evaluated. A catalog inside contracts needs fewer package files but puts rendering policy in the transport package. Rendering tool arguments alone needs fewer contract changes but treats a requested input as an accepted result. The explicit validated presentation is the selected design.

## Throughput checkpoint

- [x] Blocking first steps. Ground the existing flow, compare package placements, and choose the named presentation before application edits.
- [x] Independent workstreams. One implementation owner changes the coupled catalog, runtime, and renderer. The parent owns the plan, review, and browser evidence.
- [x] Shared mutable state. Designers use separate temporary artifacts. One owner writes application files. Package installation and lock changes remain sequential.
- [x] Smallest safe decomposition. One owner prevents drift between tool schema, transport type, and registry. Verification proceeds after the complete path builds.

## Task 1. Define and verify the shared domain

Create `packages/generative-ui` with explicit catalog and presentation subpath exports and a composite declaration build. Add dependencies and project references where consumers need them. Update the deploy Dockerfile and native fixture source/dependency configuration.

The public operations are `parseUiRequest(value: unknown)` and `parseUiPresentation(value: unknown)`. Both return a discriminated result with either the validated presentation or a bounded reason. Infer all accepted data types from schemas. Prove catalog inference works with `defineRegistry` and `Renderer` before implementing adapters.

- [x] Add catalog, strict input schemas, graph checks, and aggregate size checks.
- [x] Add domain tests with a literal expected valid card/table and invalid structures.
- [x] Install pinned dependencies and verify the shared package builds.

Run `rtk proxy pnpm test:contracts` after integrating the contract tests. Reject missing nodes, cycles, shared nodes, excessive data, unregistered types, expressions, and unsupported versions in the domain parser.

## Task 2. Carry accepted UI through Pi and snapshots

Create the local tool in `packages/runtime/src`, reserve its name, and install it in the conversation tool extension. Authorize before returning details. Derive its JSON Schema from the shared input schema. Its instructions require actual permitted data and a useful assistant text answer. Do not use the upstream playground generation prompt.

Add one tolerant Effect adapter in contracts. An invalid or unknown presentation decodes to absent without rejecting a valid snapshot. The Pi projection reads only matched successful `render_ui` result details. It preserves text output for every rejected or omitted card.

- [x] Add the internal tool, registration, reservation, and result projection.
- [x] Enforce total presentation bytes and omit child presentations.
- [x] Test native result projection, failed calls, metadata from other tools, unknown versions, and JSON transport.
- [x] Test durable tool execution and reconstruction from stored Pi entries.

Run `rtk proxy node --test tests/runtime/pi-presentation.test.ts` and the targeted generative UI runtime journey.

## Task 3. Render the accepted tree

Create a web-local registry that uses existing theme and shared Card components. Render native semantic tables with captions and scoped headers. Keep overflow inside the card. Mount accepted presentations in `conversation-transcript.tsx`, keyed by the existing stable tool entry ID. A rejected or unsupported presentation uses the existing text output. Keep normal tool diagnostics accessible without showing the full spec in the normal transcript.

- [x] Add the registry, presentation view, and responsive styles.
- [x] Test visible cards, table semantics, text escaping, fallback, and repeated snapshots.
- [x] Run focused UI tests and the web production build.

Run `rtk proxy bun test apps/web/tests/generative-ui.test.mjs` for the three browser-component checks. The first production browser check found dark shared-card variables inside the light product chat. The report now uses scoped product palette variables. A fresh build verifies the correction.

## Task 4. Prove the user path

Extend the existing fake model boundary to emit a real `render_ui` call when the verification prompt requests it. Produce an actual complete text reply after the tool. Keep ordinary fixture behavior unchanged.

- [x] Add the fixture and deterministic integration coverage.
- [x] Run type, lint, React checks, focused domain/projection/UI tests, and native runtime tests.
- [x] Launch a fresh isolated stack with the project verification helper and pass doctor.
- [x] In the browser, create an agent, request a card/table, and inspect the rendered values.
- [x] Reload the same conversation, disconnect, reconnect, and confirm the same accepted card.
- [x] Confirm invalid UI falls back to text and capture evidence.
- [x] Clean up only the owned verification stack.

Record source-level and browser verification separately. The fake model proves delivery and persistence, not live model quality. Keep runtime and protocol limitations explicit in the final report.

## Verification result

The final isolated production stack passed report generation, readable product colors, text summary, reload, reconnect, invalid UI rejection, and normal chat after rejection. Browser console errors were empty. Read-only observations recorded one conversation and five model requests. Native tests also proved recovery after SQLite storage close and reopen.

The focused suites passed 40 contract and native tests, three UI tests, and five Slack adapter tests. Workspace lint and type checks passed. The type check includes the production web build. React Doctor passed its error gate with ten warnings in other files. Vite reports its bundle size warning. Live model quality and real Slack delivery were not exercised.

Evidence remains in `artifacts/verification/generative-ui-5efb019e-v2/`. The first run's failed contrast proof remains in `artifacts/verification/generative-ui-5efb019e/`.
