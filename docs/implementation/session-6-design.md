# Session 6 design decision

The base is the shared channel service in candidate A. REST handlers use candidate B's endpoint contract. Both channels share admission, current authorization, replay, projection, and reply rules.

The judge preferred the existing oRPC transport. This implementation uses one REST transport because the separate UI owner can develop against its small endpoint contract without changing the coordinator-owned app router. It does not add a second oRPC product API.

The database keeps immutable agent versions, stored message envelopes, stream cursors, and explicit reply attempt states. The existing identity repository owns human grants and Slack account links. Agent capabilities remain separate from human access.

The fixture Worker schedules a repeating durable dispatcher before it admits a channel request. The dispatcher reschedules before each bounded scan. This closes the interval between inbox commit and the first wake schedule. Slack also waits for durable session admission before acknowledgement.

The production session runtime remains an injected port. It cannot fall back to the fixture adapter. Citations and tool status use explicit channel presentation records because the current shared stream contract has no variants for them. Fixture results do not prove model, tool, or retrieval integration.

The candidates are `/tmp/cerebro-s6-design-a.md` and `/tmp/cerebro-s6-design-b.md`. The judge verdict is `/tmp/cerebro-s6-design-verdict.md`. All three were read before this decision.

## Alternatives

| Choice | Result | Tradeoff |
| --- | --- | --- |
| Shared channel service | Selected | One admission and policy path covers web and Slack. |
| API-owned channel logic | Rejected as the base | More route code would repeat policy and replay rules. Its REST interface and transaction detail were retained. |
| Existing oRPC product transport | Judge preference | It matches existing browser wiring. REST keeps the new product endpoint contract independent from the shared router. |
| Stored inbox with a request-only wake | Rejected | A crash can occur between the PostgreSQL commit and the wake. The fixture dispatcher is scheduled first and repeats. |
| Automatic retry after ambiguous Slack delivery | Rejected | A timeout does not establish that no message was sent. The outbox preserves an unknown outcome for reconciliation. |

The production composition still needs real session, budget, source, catalog, and audit ports. An agent version in a conversation is display metadata until the runtime reports its execution version. This session preserves immutable versions but does not assert runtime pinning.
