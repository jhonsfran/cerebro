# Rubric: coordinator events through Pi's inbox

Score each candidate 0 to 3 per criterion. The candidates did not see this rubric.

1. Batching. N events queued during one turn run in one coordinator turn with one provider request sequence, and the design says how a test proves it.
2. Deletion. How much of the delivery task, predecessor wait, pending queue, admission states, and answer-entry binding disappears, with nothing load-bearing lost.
3. Durability. No event is lost and none is placed twice across a process kill at any step; replay by operation ID returns the same receipt; the re-drive path is simple and bounded.
4. Reply fidelity. A Slack reply is posted only to the destination recorded for the named event, with the existing post-time authorization and uncertain-post rule, and the design handles a model that forgets to reply.
5. Publication safety. A published definition applies at a safe boundary and is in force before waiting inputs run; no input runs under a stale profile.
6. Interface depth and extensibility. The coordinator, the web send path, the Slack adapter, timers, and reports call a small surface; adding a channel adds an adapter and a reply destination type, nothing in the runtime core.
