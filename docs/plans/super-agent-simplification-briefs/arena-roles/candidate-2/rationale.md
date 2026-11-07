# Candidate 2: admission carries the composition, the row carries the definition

## Problem

Every published agent must get background Teams with no second agent and no `coordination` block. Today the admission pins two agents (`lead`, `worker`) resolved from `runtime.json` IDs, the coordinator loads and authorizes both at `latest`, and the Team cell loads `1 + maxWorkers` definitions by version. The shape is non-obvious because of three things the code fixes in place: the admission rides inside every `TeamCommand` and `PrivateInspectionQuery` under a 120 000-byte queue bound next to 16 000-char goal and input texts; `pinnedDenial` treats the pinned row's `grants`/`enabledToolIds` as the ceiling while `createCurrentEntitlements` re-reads `latest` on every model and tool call and rejects any model other than `latest.model`; and the cell cannot compose or run without PostgreSQL regardless (`checkSession`, entitlements, `ownerContext`, catalog, skills). The starting direction, a self-contained definition snapshot in the admission, fails all three, so this candidate snapshots only the decision and leaves the definition in its immutable `agent_version` row.

## Usage (caller's view)

`runtime.json` needs nothing. Optionally:

```json
{ "coordination": { "leadModel": "openai/gpt-5", "maxTurns": 8 } }
```

Coordinator, inside `start_team` (`coordinator-work.ts`):

```ts
const [team, contentDependencies] = await Promise.all([
  services.resolveTeam(),            // authorizes `execute` with the lead model; no PG read
  services.contentDependencies(),
]);
const admission = decode(WorkAdmissionSchema)({ version: 3, team, limits: services.limits, goal, key, ... });
```

Team cell (`TeamAgent.configure`):

```ts
const pinned = await loadPinnedAgent(env, work.key.organizationId, work.team.agent); // one immutable row
return Promise.all(teamRoles(work).map(async (role) =>
  createExecutionComposition(env, storage, work.sourceEventAddress,
    await teamRoleAddress(work, role.index), composeRoleDefinition(pinned, role),
    work.key.ownerPrincipalId, metadata, true, () => importedDependencies(role.index))));
```

Inspector: `definition: work.team.agent` for every slot; `modelId` from Pi's `AgentDoc` as today.

## Shape

Data first. `WorkAdmission` v3 replaces `lead`/`worker` with `team: { agent: RolePin, lead: { model }, worker: { model } }`. A schema filter requires `team.agent.agentId === sourceEventAddress.agentId`, so a Team can only act as the agent whose conversation admitted it (per encode-lessons-in-structure). `lead`/`worker` are templates, not an enumerated list: worker count stays `limits.maxWorkers` now and becomes a budget consumed by Pi child tasks in Unit 7 without touching this struct. `TeamDefaultsSchema` replaces `CoordinationProfileSchema`: all fields optional, `{}` valid, `leadModel` refined against configured models at bootstrap.

Flow. `composeTeam(agent, defaults)` (pure, runtime) builds the composition from the version the coordinator session is already running. `resolveTeam` authorizes it through the session's agent authority with `pinnedAgent = composeRoleDefinition(agent, lead)`, so a lead model the latest definition or runtime config does not enable fails at `start_team` (per boundary-discipline: validate once at the admission boundary, trust the admission inside). The cell reads the one pinned row and calls `composeRoleDefinition(pinned, role)` per slot: keeps `grants`, `enabledToolIds`, `version` from the row, substitutes the admitted model, prefixes the system overlay. `requireRoleConfigurations` checks every composed configuration against `work.team` (per make-boundaries-visible).

Load-bearing decisions. The overlay is constant text in `team-composition.ts`: the system owns it, the person does not configure it, and prompt text does not belong in durable payloads. The lead model lives in `runtime.json` as an installation default and is recorded into the admission; the only authorization change is one `||` in `createCurrentEntitlements` accepting the configured lead model, scoped in practice by `pinnedDenial` to lead compositions. Limits come from runtime defaults and are snapshotted into `limits` as today. The pin is the coordinator session's running version, not `latest`: no read, and the Team shares the version of the coordinator that started it.

Interface depth. The public surface shrinks: `CoordinationServices` loses `profile` and `resolveRolePins` and gains `limits` and `resolveTeam`; `createCoordinatorServices` loses the profile and the `undefined`-when-unconfigured branch; `TeamAgent.configure` becomes one read plus a map. Behind that surface, `team-composition.ts` is the single owner of slot layout, overlay, and model substitution, replacing four inline `index === 0 ? lead : worker` branches and two copies of the slot range check. Authorization checks that remain: owner context plus `execute` with the lead definition at admission; per role, the unchanged `createExecutionComposition` authority (`checkSession`, entitlements against latest, identity grants, pinned ceiling); `admitDependencies`/`permit`/`authorizeEventSource` unchanged. What the shape deliberately does not do: snapshot instructions or grants, add a field to `AgentDefinition`, or enumerate roles.

## Synthesis decision

Filled in by arena.

## Tradeoffs accepted

- We accept two short model ids in the admission that the cell could not derive (the lead model comes from runtime config, which can change) in exchange for an admission that records what was decided and lets the cell verify what it composes.
- We accept one PostgreSQL read of the immutable pinned row at Team open in exchange for keeping the grant and tool ceiling anchored in the row rather than in a queue payload.
- We accept that removing or changing `coordination.leadModel` denies in-flight leads at their next call, the same rule that already applies to a republished model, in exchange for not adding a per-agent field now.
- We accept an entitlement widening of one configured model, reachable only by lead compositions, in exchange for a stronger lead with no `AgentDefinition` or editor change.
- We accept the overlay changing for in-flight Teams on deploy in exchange for not shipping prompt text through durable payloads.
- We accept the `version: 3` literal and no migration, per the plan's no-pre-cutover-data assumption.

## Alternatives considered

- Full definition snapshot in the admission (the starting direction). Hides the PostgreSQL read from the cell but exposes a size failure to callers: 50 KB of instructions plus a few hundred grants leaves no room for `message_team` text under the 120 000-byte bound, a 413 that depends on how the person wrote their agent. It also moves the authorization ceiling into a payload the cell cannot verify without the read it was meant to avoid. Lost on both depth and safety.
- Single pin only, everything derived in the cell (`lead.model` from a per-agent `AgentDefinition.team.leadModel`). Smallest admission and the most principled authorization (the publisher chooses the lead model). Lost because it adds a contract field, editor and publish validation for a feature the grounding placed in `runtime.json`, and because the cell would then compose from two sources (row plus config) with nothing in the admission to check against.
- Enumerated `roles: [{kind, model}, ...]` list. Self-describing, but it bakes the worker count into the admission shape that Unit 7 replaces with a budget, forcing a second rewrite. Lost on constraint 5.

## Open questions and risks

- Installation-level `leadModel` or a per-agent field? This candidate chose installation-level to avoid an `AgentDefinition` change; is the entitlement `||` acceptable, or should the publisher own the choice even at the cost of an editor change?
- Pin the coordinator session's running version or `latest`? Running avoids a read and keeps coordinator and Team on one version; a staged-but-not-adopted publish would start a Team on the old version. Is that the intended semantics?
- Should workers get a narrower tool set than the lead? The templates make a per-role tool policy a one-field addition, but nothing here needs it; confirm it stays out.
- `requireTeamAdmission` compares the whole admission canonically on every command; v3 is smaller than v2, so no new risk, but the Inspector contract tests that build v2 admissions all need rewriting.

## Next implementation step

Replace `lead`/`worker` with `team` in `WorkAdmissionSchema` (v3) and delete `CoordinationProfileSchema`, then fix the type errors outward from `coordinator-work.ts` and `team-agent.ts` into the new `team-composition.ts`.
