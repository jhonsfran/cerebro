# Session 7 work record

Base is 62aadee. Branch is codex/pilot-integration.

## Workflow

1. Read the Principles section of the poteto-mode skill. Complete.
2. Frame. Complete. Traced the deployed graph and captured subsystem baselines.
3. Design the workflow. Complete. Compared two designs and selected direct composition with a separate tool gateway.
4. Run the loop. Complete. Runtime, product adapters, and backup have separate owners. Independent review findings are resolved.
5. Keep the audit trail. Complete. Committed decisions identify evidence, rejected approaches, and remaining external qualification.
6. Verify and hand back. Complete. Integration28, runtime13, contracts35, policy63, channels25, identity18, memory24, forced types13, build11, and scoped lint pass. Browser acceptance, active-load samples, and seven-volume application restore pass. Existing whole-repository lint failures and external qualification remain explicit in the receipt.

## Throughput checkpoint

- Blocking first steps. Trace the contracts and capture the current checks before edits.
- Independent workstreams. Read-only explorers trace runtime and product adapters. Implementation has one owner per unit.
- Shared mutable state. The coordinator owns manifests, composition, and the decision log. Test projects use distinct ports and volumes.
- Smallest safe decomposition. One owner implements the connected runtime graph. A separate unit owns backup and restore.

## Definition of done

The deployed API uses production adapters, durable sessions, current authorization, controlled tools, paid-work admission, PostgreSQL projections, and MinIO memory. A reproducible acceptance test verifies replay, revocation, recovery, budget limits, and restore. Configured external providers require a live result. Missing credentials remain incomplete.

## Implementation ownership

- Runtime owner. Session journal, SDK model admission, broker/gateway, actual server composition, deployment graph, and native acceptance.
- Product owner. Channel options, catalog, source/audit reads, memory router binding, exports, source dependency checks, and required setup UI.
- Backup owner. Snapshot/restore command and isolated Docker verification.
- Coordinator. Shared design, review, operations receipt, workspace checks, and UI verification.

These scopes have separate write targets. Runtime and product owners coordinate additive contract shapes before dependent edits.
