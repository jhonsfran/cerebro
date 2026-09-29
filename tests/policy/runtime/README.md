# Session 4 runtime proof

Run `pnpm test:policy:runtime` from the repository root. Docker must be running. The test builds the pinned experiment and MinIO images from the committed experiment Dockerfile. It creates a unique `cerebro-s4-tools-*` Compose project, dynamic localhost ports, and owned volumes. It removes them after success or failure. A cold Docker build can exceed the 300 second test deadline. Build the prerequisite targets first if needed.

The bootstrap verifies celld 0.6.0, OpenCode SDK and plugin 0.0.0-dev-18697, and Agents 0.24.0. It compiles the current tools and contracts source with `celld deploy`. The experiment image supplies its reviewed SDK shared-storage patch. No provider credentials or live providers are used.

The deployed Worker imports the new tools registry, broker, dynamic executor, signed MCP gateway, and OpenCode plugin. The test proves reachable parent egress, denied global fetch from a restricted dynamic Worker, successful registered gateway calls with required MCP 2026-07-28 metadata and SSE replies, tampered and widened connector rejection, bound write approval, SDK tool error records, and replay after celld restart. A separate provider stores its own SQLite effect count and deliberately has no effect deduplication. A duplicate dispatch therefore fails the count assertion.

The read registration uses `https://fixture.invalid/mcp`. A trusted gateway fetch adapter maps that fixed URL to the isolated local HTTP provider. This fixture tests gateway routing and capability validation. It does not test TLS trust or an external MCP server.

The durable journals in this directory are test fixtures. Broker and gateway have separate namespaces and Durable Objects. Production session storage and application composition remain Session 7 work.

`pnpm test:policy` runs the host policy tests and journal reopen tests. If `POLICY_TEST_DATABASE_URL` is set, the caller must provide a migrated fixture database. Otherwise the runner creates PostgreSQL 17, waits for TCP readiness, applies committed migrations, runs tests, and removes its owned container.
