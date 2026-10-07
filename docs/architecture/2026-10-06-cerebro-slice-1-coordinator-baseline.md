# Cerebro slice 1 coordinator baseline

The coordinator accepted corrected S1-0 at `46a44e199b3bf43173602ea609f40a0b6958f201` from `codex/cerebro-slice-1-contracts`. It was imported into `codex/cerebro-slice-1` by fast-forward. The planning baseline and unchanged `main` are `1855fed13aafee0e7a3369f3e684564f35715086`. Shared dependency commit: `8ee8135ffc89e0789538ec32957d12d1b552711f`.

The contracts are frozen for implementation preparation. Snapshots require accepted user messages, approval identity and state, and tool identity, arguments, dependencies, state and output. Live updates use the same record schemas. Fresh inspect and attachment restore those records without submitting work. Snapshot copies cannot change stored fake state.

## Shared dependencies

| Dependency                       | Pin    |
| -------------------------------- | ------ |
| Effect                           | 4.0.1  |
| Agents                           | 0.26.0 |
| Pi Durable and Pi AI             | 1.0.4  |
| TanStack AI                      | 0.65.0 |
| TanStack AI client               | 0.37.0 |
| TanStack AI React                | 0.29.5 |
| AG-UI core, direct dependency    | 1.0.2  |
| React, React DOM and their types | 19.3.0 |
| TypeScript                       | 7.0.2  |
| Node types                       | 26.6.4 |
| esbuild                          | 0.28.2 |
| celld                            | 0.6.1  |

The two host Dockerfiles pin `ghcr.io/denoland/celld:0.6.1@sha256:acb0bc2dca628f0dac7c6b43eea42615a79f4943f316f6df7c1da0b86d52150b`. This preparation does not build or deploy that image.

The coordinator generated the application lockfile. All three existing Agents imports use 0.26.0. Root development pins for the existing `@ai-sdk/provider` 3.0.8 and `@opentelemetry/api` 1.9.1 give workspace consumers a shared optional-peer context. This resolves the nominal class type conflict without replacing the active chat. Three existing fixture handlers now use explicit async returns for TypeScript 7. The active AI SDK and OpenCode dependencies remain until S1-F; that removal must include the root provider pin.

`@cerebro/ag-ui` contains package metadata and TypeScript configuration only. Its exports are reserved for S1-C. Build and type scripts must be added after source exists; an empty `src` tree would fail `tsc -b`. The current workspace checks do not verify an AG-UI implementation.

The install policy disables the unnecessary `@google/genai` preinstall echo script. Exact release-age exclusions cover the approved TanStack packages and its event-client dependency. TanStack AI retains its publisher-pinned AG-UI core 1.0.0 alongside the direct 1.0.2 pin; browser protocol compatibility remains unqualified.

## Verification and limits

The tested dependency tree was committed unchanged as `8ee8135ffc89e0789538ec32957d12d1b552711f`. Hash comparison confirms that commit hooks did not change the tested files. Commands, logs and hashes are in [the coordinator evidence](../../tests/pi-durable-qualification/evidence/coordinator/review.json).

| Check | Result |
| --- | --- |
| Frozen workspace install | PASS |
| Contract tests | PASS, 50 tests |
| Forced workspace types | PASS, 13 tasks |
| Forced workspace build | PASS, 11 tasks |
| Changed source, manifest and format checks | PASS |
| Public TanStack observation test, isolated pinned graph | PASS, 1 test; zero submissions |
| Full workspace lint | FAIL, 212 existing diagnostics; no new file and rule pairs |
| Peer dependency check | FAIL; compatibility work remains open |

The peer check reports Agents requiring provider 4 while the retained application uses provider 3, Babel 8 plugins with Babel core 7, and `bun-ffi-structs` requesting TypeScript 5. Passing types and builds do not prove these optional paths. Resolve or remove each path during the later packet checks and S1-F dependency cleanup. The build also reports vendor eval and bundle-size warnings. No live application or browser acceptance ran here.

The historical host qualification at `7984e12712deb2b9f93d9e1a5ff4f341060c5a02` retains 12 PASS, 2 FAIL and 14 NOT_RUN results. The two accepted deviations concern `nodejs_compat` and native Stop withdrawing queued inputs. They remain FAIL. The local 90-second recovery probe does not prove the production 60-second budget, remote bucket durability or idle eviction. The coordinator did not rerun the Linux-specific host fixture on this Mac. The snapshot correction adds contract evidence, not new host passes. ADR 0001 remains proposed. Metering remains unbound.

## Coordination

The coordinator owns shared contract changes, manifests, lockfiles, dependency decisions, remote handoffs and final local integration. Later owners must start from the published head of `codex/cerebro-slice-1` and return an exact branch SHA. No S1-A through S1-D owner has been started by this preparation. No new runtime, execution queue, provider loop or application transport was implemented.
