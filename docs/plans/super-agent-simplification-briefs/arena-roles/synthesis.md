# Synthesis: Team roles from the coordinator agent

The rubric is [rubric.md](rubric.md). Three runners produced candidates; a separate judge scored them and verified their repository claims.

| Candidate | Shape | Judge score |
| --- | --- | --- |
| 1 | One agent pin in the admission, constant role overlay in code | 18 of 18 |
| 2 | Agent pin plus recorded role models, lead model from `runtime.json` | 14 of 18 |
| 3 | Optional `team` section on the published agent definition | 14 of 18 |

## Base

Candidate 1. It has the smallest durable contract, deletes the most code, and passes the unmodified pinned definition to every authority check, so `packages/authorization` and `apps/server/src/access.ts` stay unchanged. The judge verified its reading of the authority path end to end: the coordinate check at `start_team` already covers ownership and execute, and the model entitlement is rechecked at command receipt and before every provider request.

## Grafts

- From candidate 2: one owning module, `packages/runtime/src/team-composition.ts`, replaces the scattered slot-to-role branches and range checks.
- From candidate 3: `teamRoleDefinition` as a copying projection, so a role can never hold more than the agent and a later per-agent lead model is a one-field change.

## Rejected

- An installation-level lead model and its entitlement widening (candidate 2). The judge found the widening keyed by agent ID only, so it would exempt unrelated conversations from the republish denial.
- Per-role instruction overrides and worker model overrides on the agent definition (candidate 3) as unrequested surface. Unit 7 later adopted only the `team.limits` part of candidate 3's section.
