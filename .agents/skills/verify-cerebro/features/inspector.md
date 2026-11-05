# Development Inspector

The Inspector shows saved private Team execution beside the coordinator chat. Its reads require current owner, source, and content access. Local mode opens it by default in the built frontend.

## Entry points

Open the persistent agent conversation. Region `Development Inspector` contains button `Inspector` and `Refresh Inspector`. The panel is independent of the composer and remains available in a historical closed conversation.

## Product proof

1. Require the local panel to open with `Active, queued, and recent work`. Opening the panel reads only overview metadata. It does not select or load a private Team.
2. Send a team request through `Message` and `Send message`. Select its goal in region `Inspector work`. Require `Selected work`, `Private Team cell`, the actual saved model, a held slot, deadline, and request reservations.
3. Require `Team conversations`, `Lead conversation`, and started workers. These are Pi conversations inside one private Team cell. They are not additional Durable Objects or public chats.
4. Choose `Lead transcript`, `Lead tools`, and `Lead tasks and retries`. Require saved safe text, `delegate_worker` input and results, actual task state, attempts, and retry metadata. Repeat for `Worker 1` and `Worker 2` when present.
5. Expand `Lead token usage`. Require actual tokens. Keep `Model request reservations` separate. Monetary cost is `Unavailable`, not zero dollars.
6. Open `Work history` and `Owned events`. Page with the rendered Older and Latest controls. An empty page with a next cursor must still offer paging. History replaces its current page and retains completed work after reload.
7. Send a different goal while the first Team is held at the model boundary. Require two work IDs and continued composer use. Select each Team and require details for only that selection. Rapid changes and close must cancel stale reads and clear the retired private view.
8. When a Team is sealed, repeat reads and reload. Saved role IDs, models, result IDs, reservations, tokens, tasks, and transcripts remain unchanged. Fixture counters show no added terminal model request. Other running work can keep overview refresh active while sealed details stop polling. Source status and slot ownership must still update when report settlement finishes. They must not remain accepted or Held beside a completed source row.
9. Close `Inspector`. Require no Inspector requests or timer work while closed. Reopen and select again. An idle source has no recurring Inspector requests.
10. Revoke current source or recorded content READ through the authorized fixture preparation. Require details to clear and access denial. A second owner cannot read the endpoint. Restore access before cleanup. A transient non-auth failure must use constant safe error text and retain only the last known liveness needed for bounded retry.

Capture browser DOM and screenshots, the actual product requests, safe saved frames, provider counters, and read-only persistence. Use the fixture boundary only for model timing. Do not inject chat, Team, or result state. Never save cookies, runtime keys, task payloads, system instructions, or provider reasoning in proof.

## Limits

A cold active cell can resume already accepted work through normal recovery. Inspection admits no new work. A cold sealed read does not prove the separate crash window between report commit and unfinished native role cleanup. Root must state that proof separately.
