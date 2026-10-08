# Native policy host proof

Run `rtk proxy pnpm test:policy:runtime` from the repository root with Docker available. The gate builds the selected dependency and MinIO image targets from `tests/runtime/Dockerfile`. It uses a fresh `cerebro-s1-policy-native-*` project, dynamic loopback ports, and owned volumes. Successful runs remove their containers and volumes. Failed runs preserve their project for diagnosis.

The bootstrap checks the installed Agents, PiAI, PiDurable, and Effect versions against the isolated runtime manifest. It checks celld against the selected image pin, copies the production runtime, tools, contracts, and database packages, then bundles the Worker with `celld deploy`. It saves actual versions and the source identity. The host uses the production `SessionAgent`, official PiHarness and Lifecycle, production Effect coordinator, controlled executor, and celld receipt store. It uses an injected local caller proof and persisted fixture grants. Product HTTP authentication remains a separate application check.

The gate preserves these assertions:

- The parent can reach the local provider. A restricted dynamic Worker with `globalOutbound: null` cannot use ambient network access. Its named registered gateway succeeds.
- Unauthenticated private routes, a foreign caller, cross-company addresses, tampered signatures, changed arguments, changed tool versions, widened connectors, and another audience produce no physical read or write.
- Real Pi calls only advertise the two registered tools. A registered read has redacted output. A write waits for an actual bound approval and creates one physical effect.
- Exact event and controlled executor replay preserve the result before and after SIGKILL. The reopened host has a different instance ID. The production receipt and independent gateway journal remain complete.
- Current access checks reject history, receipt reads, dispatch replay, and duplicate admission after grant revocation. The revocation survives SIGKILL. Restored access permits the existing result without a new physical effect.
- Forced `shell`, `webfetch`, `execute`, and `mcp_unregistered` calls produce durable Pi `toolResult` errors and zero production tool receipts. They create no physical effect. The connector secret is absent from model input.

The provider keeps independent SQLite counts and has no write deduplication. A second dispatch increments the count and fails the gate. Registered MCP reads require the selected 2026-07-28 transport metadata and SSE response parsing. A trusted gateway adapter maps the registered `https://fixture.invalid/mcp` URL to the isolated provider; this does not qualify an external MCP server or TLS trust.

The independent gateway journal retains the selected gateway's operation and approval storage. The production SessionAgent SQLite store is the product domain and receipt authority. There is no fixture audit outbox. Application audit publication and outage checks belong to the full application gate.

Each case saves source identity, actual dirty checkout state, package and host versions, owned container/image/volume IDs, domain state, receipts, native errors, and provider counts under `/tmp/cerebro-policy-native-evidence/<project>/`. The selected host explicitly uses `CELLD_WAKER_TICK_MS=1000`; alarm performance is qualified by the separate native runtime gate.
