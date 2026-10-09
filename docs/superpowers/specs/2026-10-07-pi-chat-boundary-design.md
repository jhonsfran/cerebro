# Pi chat ownership

> Superseded on 2026-10-09 by the [chat simplification design](2026-10-09-chat-simplification-design.md). The conversation Durable Object still owns Pi; the AG-UI mapping and the TanStack transcript described below were removed. The conversation Durable Object owns Pi's root session and its durable execution. The existing Hono product API authenticates commands and attachments. It does not run an agent loop. Submission uses native `session.submit` with a stable operation identity and returns an admission receipt. Observation and disconnection cannot submit, cancel, or resume execution.

The Durable Object's server adapter maps authorized Pi-derived observations to AG-UI `StreamChunk` events. TanStack's client assembles messages and React renders its typed text, thinking, tool-call, and tool-result parts. Cerebro keeps company access, approval decisions, citations, durable Stop, and operation receipts. These product controls do not need a separate client transcript.

Use one root session per conversation. Preserve the current execution identity mapping, including joined steering inputs. Do not add TanStack's backend `chat()` loop or call Pi's request-scoped `prompt()` helper.

Reconnect restores a fresh authorized snapshot, including the current partial answer, then receives live events. Native Pi event streams are in-memory attachments, not replay logs. Keep the stream attached across model/tool steps. A generated message or `RUN_FINISHED` chunk must not close the conversation attachment. Closing an attachment releases only observation resources.

Exact chunk replay is a separate optional feature. It requires a Durable Object chunk log, cursor validation, retention, access checks during replay, and a TanStack durability adapter. It must not be represented as a capability of Pi's native event stream. No chunk log is added for snapshot recovery.

The compatibility boundary preserves company authorization and existing channel consumers. TanStack and AG-UI types remain inside transport adapters. Private thinking signatures and encrypted provider content are not UI text.

Verification covers native durable submission, reconnect without submission, partial snapshot restoration, reasoning and tool rendering, canonical answer replacement, access denial, stale attachments, and client cleanup without cancellation. Existing native crash/recovery changes in the working tree remain intact.
