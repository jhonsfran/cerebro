# Chat simplification

Revised on 2026-10-09. This document explains why the chat path was cut down after the first-slice integration and what the browser, the API and the conversation Durable Object do now. It supersedes the [Pi chat boundary design](2026-10-07-pi-chat-boundary-design.md) where the two disagree.

## Why

The first slice shipped a working chat that was too slow to use. The cost was not in Pi or in the model. It was in the layers Cerebro had put between Pi and the browser:

- Observation delivery checked access on every frame and on a 250 ms idle tick, in the API and again in the session store. The API check loaded every channel item of the conversation and authorized each one, so the cost grew with conversation length, and a 500 ms timeout closed the stream when one check ran long.
- One Pi text delta crossed four encode and decode passes. The store stamped a domain frame, the Durable Object re-mapped it into an AG-UI batch with the whole domain frame embedded as a custom event, the API decoded and re-encoded the batch, and the browser decoded the chunk, pulled the domain frame back out and re-ran the domain projection before handing the rest to TanStack.
- The browser kept two transcripts for one conversation, TanStack messages and the Cerebro projection, and updated both on every chunk.
- The Pi adapter re-derived execution membership from Pi's submission records and re-ran the canonical projection on every event batch, including pure text deltas.

AG-UI and TanStack were not pulling their weight. Submissions already went through Cerebro commands, so TanStack only assembled messages, which Pi already does. No client other than the web app consumed AG-UI.

## What the chat path is now

Pi still runs inside the conversation Durable Object through the official PiHarness and Lifecycle. Cerebro still owns approvals, tool receipts, citations and canonical history. The change is the wire and the browser.

| Stage | Before | Now |
| --- | --- | --- |
| Durable Object output | Domain NDJSON, then an AG-UI batch per frame on the chat route | Domain NDJSON only |
| API | Decoded each batch, authorized on every frame and every 250 ms, re-encoded | Authorizes on attach and every 2 seconds, forwards bytes |
| Browser | AG-UI client plus TanStack `ChatClient` plus a Cerebro projection | One loop: read a frame, check its epoch and sequence, apply it to the projection |
| Transcript source | TanStack messages | `projectionMessages(projection)` |
| Dependencies | `@cerebro/ag-ui`, `@tanstack/ai`, `@tanstack/ai-client`, `@tanstack/ai-react`, `@ag-ui/core` | None of these |

The observation frame types did not change. A snapshot carries the full `DomainSnapshot` plus the current partial text and thinking. An update carries one `DomainUpdate`. An `access-denied` frame ends the attachment. The browser decodes each frame with the contract schema, reconnects from a fresh snapshot on EOF or a sequence gap, and clears protected state on denial. Reconnect never submits work.

### Access checks

| Check | Where | When |
| --- | --- | --- |
| Authentication and conversation ownership | API | On attach and every 2 seconds |
| Agent read and content dependencies of the snapshot | Session store | On attach, on resnapshot and once per interval |
| Content dependencies of a committed record | Session store | On every committed record |

Provisional text and thinking carry no governed content and ride on the interval check. Sign-out or revocation is visible to an open attachment within the interval instead of within one tick. The live chat fixture bounds this at 3 seconds.

### Submission

The web submit path keeps the session `inspect` before `submit`. Removing it was tried: the Durable Object authorizes the submission itself, but only after the Postgres inbox row exists, and the pilot revocation gate requires a viewer who lost access to cited content to be denied before any row exists. The receipt cursor now reads one aggregate instead of every channel item. The Postgres inbox stays, because the channel dispatcher uses it to retry Slack and web submissions that reached Postgres but not the session.

## Trade-offs

- **No AG-UI compatibility.** A third-party AG-UI client cannot attach today. If one is needed later, add one mapper at the API edge over the domain frames. The domain frames are the contract.
- **Revocation latency is an interval, not a frame.** Two seconds is a documented constant in `packages/api/src/observation-delivery.ts` and `packages/runtime/src/celld-session-store.ts`.
- **No exact chunk replay.** Reconnect restores the current partial text from the snapshot. This was already the case; the AG-UI layer did not add replay.
- **The API no longer inspects frames.** It used to drop frames whose address or access generation did not match the attachment and to cap frame size. The browser still checks both and caps a frame at 1 MiB. The session is addressed by a signed request to one Durable Object per conversation, so a mislabeled frame would be a Durable Object bug, not a client path. If a second client ever attaches, add the address check back at the API as one line per frame.

## Verification

The [chat simplification plan](../plans/2026-10-09-chat-simplification.md) records the executed checks for each cut and the decision trail lives in [chat-simplification-decisions.tsv](../../implementation/chat-simplification-decisions.tsv).
