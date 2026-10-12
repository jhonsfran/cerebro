# ADR 0001: Pi Durable owns agent execution

Status: accepted by the project owner on 2026-10-11. This replaces the proposed execution-replacement boundaries in the previous version.

## Context

Cerebro copied Pi submissions, execution membership, answers, and run status into another durable snapshot. This required handoffs, projection commits, repair jobs, and another browser protocol. The project owner chose Pi Durable as the harness and celld as its host. A generic replaceable execution engine is not a current requirement.

## Decision

Pi Durable owns the transcript, inbox, generation, tool tasks, retries, Stop, and recovery. Use the official PiHarness for SQLite persistence and Lifecycle wake-up on celld.

Cerebro owns agent configuration, current company authorization, credentials, controlled tools, approvals, and safe chat presentation. Small company documents or tables can exist beside Pi state. They must not become another execution store.

Call native Pi operations directly. Derive messages, partial output, and busy status from Pi's current view. Use native request, entry, task, and call identities. Do not persist another transcript, answer history, execution membership, or run state.

The chat API supports Send, Stop, read, observe, and approval decisions. Reconnect reads a fresh native view. Pi's submission, queuing, deduplication, ordering, cancellation, and compaction semantics are the product contract.

Check current permissions before model requests and tool calls. Bind approvals to exact calls. Keep the restricted gateway and task memos for remote effects. Report an uncertain at-most-once effect without another dispatch.

## Consequences

There is one execution authority and fewer synchronization paths. Agent configuration composes instructions, model, tools, and grants without another orchestration framework.

Cerebro is coupled to Pi's public APIs. Updates need tests of submission, observation, Stop, approvals, and recovery. A future engine replacement is a migration, not another implementation of a generic port.

The product no longer promises custom run-specific cancellation, changed-payload conflicts under a reused operation ID, immutable joined-answer grouping, or a separate permanent answer archive.

## Verification

Verify Send, retry, Stop, partial output, reconnect, and restart without an observer. Verify pending approvals after SIGKILL, denied and revoked authority, and one dispatch after an interrupted remote write.

Keep independent authorization and tool-boundary tests. Replace tests that only describe the removed execution store or projection protocol. See the [architecture overview](overview.md).
