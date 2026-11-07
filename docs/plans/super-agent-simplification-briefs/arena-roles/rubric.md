# Rubric: derive Team roles from the coordinator agent

Score each candidate 0 to 3 per criterion. The candidates did not see this rubric.

1. Zero extra configuration. A newly published agent can start a Team with no second agent and no required `coordination` block. Count the steps a person performs.
2. Deletion. How much of today's profile, pin resolution, double authorization, and per-role agent loading disappears. More deletion scores higher if nothing load-bearing is lost.
3. Permission fidelity. The Team runs under exactly the coordinator agent's grants and enabled tools, pinned by version, and current permissions are still checked at execution and at content transfer.
4. Durable composition. After a Team cell restart, the roles compose from the saved admission the same way, with no race on a later agent republish and no ambiguity about which model or instructions a role used.
5. Extensibility without a second rewrite. The shape admits a later change to N workers as Pi child tasks, per-agent budgets instead of schema caps, and a stronger lead model, without changing the admission contract again.
6. Interface depth. The coordinator's `start_team` and the Team cell's `configure` see a small surface that hides the role composition. No wire or storage types leak into callers.
