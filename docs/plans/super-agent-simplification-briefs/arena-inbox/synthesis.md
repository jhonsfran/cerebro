# Synthesis: coordinator triggers through Pi's inbox

The rubric is [rubric.md](rubric.md). Three runners produced candidates; a separate judge scored them and verified the Pi facts each design relied on.

| Candidate | Shape | Judge score |
| --- | --- | --- |
| 1 | Receipt plus a per-conversation staging list; one drain is both crash re-drive and publication gate | 15 of 18 |
| 2 | One small admission task per event, created with its receipt | 15 of 18 |
| 3 | `Trigger` and `ReplyPort` domain; channels as adapters; backlog drain | 16 of 18 |

## Pi facts the judge confirmed

- An `onYield` continuation is dropped when the final boundary places queued user input (`dist/harness/generation.js:433`), which is exactly the burst case.
- A throw from `beforeRequest` is reported and swallowed (`dist/harness/scheduler.js:1502-1517`), so a hook cannot gate a run.
- The agent configuration is resolved per generation at prepare time, so a configure applied between runs takes effect on the next run.
- `Conversation.submit` with a known `requestId` returns the existing submission without writing.

## Base and grafts

The judge recommended candidate 1 as the base. The lead took candidate 1's mechanics, and also candidate 3's contract against the judge's scope objection, because the channel generalization was in this run's scope and the receipt contract should change once.

- From candidate 2: the forgotten-reply nudge is a durable follow-up submission with request ID `reply-nudge:<trigger id>`, never an `onYield` continuation; and the waiting cap counts Pi's inbox plus the backlog.
- From candidate 3: the `Trigger`, `ReplyDestination`, and `ReplyPorts` contract, `withdrawn` as a distinct placement, and the batching acceptance test with its `one-at-a-time` negative.

## Found after landing

The drain places input with `Conversation.submit`, which skips the harness wake job. Commit `7d5a3b5` keeps the coordination alarm armed while Pi holds unsettled input.
