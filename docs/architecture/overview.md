# How Cerebro fits together

Cerebro gives company users a chat interface to configured agents and controlled tools. Pi Durable owns execution. celld hosts the Worker and Durable Objects. Cerebro owns configuration, current permissions, approvals, credentials, and chat presentation.

## Execution ownership

```mermaid
flowchart TD
    Web[Web chat] <--> API[Cerebro API and authorization]
    API <--> Host[PiHarness on celld]
    Config[Model, instructions, tools, and grants] --> Host
    Host <--> Pi[Pi transcript, inbox, tasks, and recovery]
    Pi <--> Tools[Cerebro tools and approvals]
    Tools --> Gateway[Signed gateway]
    Gateway --> Connectors[MCP and HTTP connectors]
```

Each conversation has one SessionAgent Durable Object and one native Pi conversation. The official PiHarness connects Pi to SQLite and Lifecycle wake-up jobs. Pi controls inputs, busy-input queuing, generation, tool tasks, Stop, retries, and crash recovery. Cerebro composes the model, instructions, enabled tools, and grants. Current company authorization controls admission, model requests, tool calls, approval decisions, and reads.

## State owners

| State | Authority | Storage |
| --- | --- | --- |
| Identities, memberships, grants, agent definitions, connectors, searchable memory, and audit | Company services | PostgreSQL |
| Transcript, inbox, generation, tool tasks, and recovery | Pi Durable | Conversation SQLite through PiHarness |
| External dispatch markers and outcomes | Pi task memos | Conversation SQLite |
| Owner, agent version, content access dependencies, and approvals | Cerebro | Company metadata beside Pi state |
| Chat messages, partial text, and busy status | Pi current view | Derived on read, then held in browser memory |
| Slack delivery identity | Channel adapter | Conversation SQLite |
| Source documents and artifacts | Artifact storage | Artifact MinIO |
| celld durable state | celld | Separate runtime MinIO |

ChatSnapshot presents native Pi state and company approval data. Cerebro does not persist that snapshot. Pi decides when execution is active or complete. The browser uses native message order and entry identities. Reset and compaction can change the current view. A separate permanent answer archive is not part of the chat contract.

## Send, Stop, and reconnect

Send authenticates the user, verifies current access, and calls Pi submit with the client's operation ID. Pi accepts the input durably and returns a receipt. The receipt confirms acceptance, not completion. Sending while busy uses Pi's inbox.

A retry keeps the same operation ID. Pi stores one input for that operation. The client matches receipts by operation ID. PiHarness's `accepted` field is advisory under concurrent retries.

Stop calls native Pi abort. It can stop active work and withdraw queued input. The UI does not promise an independent run for each message.

Observation sends complete authorized snapshots of the native conversation view. Reconnect starts with current messages, partial output, busy status, and approvals. Closing the browser releases the observer without stopping accepted work.

## Tools and approvals

The model can request tools enabled for the agent. Each tool checks current authority and content access. A write waits for approval bound to its native task and call, arguments, tool and connector versions, actor, policy, and expiry.

An authorized person records allow or deny. A decision receipt contains only its approval ID and state. The waiting tool reads the durable decision. After allow, it rechecks authority, validates the binding, and rechecks source access before dispatch. Cerebro signs a short-lived capability. The isolated loader reaches the connector through the gateway, which validates current policy, supplies credentials, and removes secrets from the result.

Source access controls transcript reads, new input, model requests, and allowed tool calls. Stop and Deny require current session ownership and agent authority. They remain available after source access is revoked.

## Recovery

Pi persists the transcript, inbox, generation, and tool tasks. PiHarness schedules host wake-up after eviction or restart. The host retains Pi's native idle wait with `ctx.waitUntil` while work runs. Cerebro has no second execution queue or copied-state repair job.

Before an external effect, the tool records a dispatch marker in a Pi task memo and flushes storage. Afterward it records the outcome. Recovery reuses a recorded result. Idempotent tools can retry. An at-most-once tool with a marker but no outcome reports an unknown result without another dispatch. A person checks uncertain effects in the target system.

## Code map

| Location | Responsibility |
| --- | --- |
| `packages/runtime/src/session-agent.ts` | PiHarness host, authority, approvals, and chat transport |
| `packages/runtime/src/pi-harness.ts` | Safe presentation of native entries and live state |
| `packages/runtime/src/pi-tools.ts` | Controlled tools, approval waits, and task memos |
| `packages/contracts/src/session-service.ts` | Small chat requests, receipts, approvals, and snapshots |
| `apps/server/src/session` | Company configuration, access context, transport, and Slack delivery |
| `packages/channels/src/service.ts` | Setup, agent management, access changes, and chat operations |
| `packages/api/src` | Product routes and observation delivery |
| `apps/web/src/features/product` | Agent configuration and small chat UI |
| `packages/authorization`, `tools`, `memory`, `db`, `auth` | Policy, connectors, memory, records, and identity |

## Deployment

The server runs as one Worker on celld in Docker Compose. PostgreSQL holds company records. Runtime durability and artifacts use separate MinIO services. Local mode permits local HTTP endpoints. Production mode requires public HTTPS endpoints, verified PostgreSQL TLS, and externally managed secrets. Tests use isolated local stacks with a fake model and connectors.
