# Code quality fixes

The full-project review and the request to fix all findings define this work. Execute the units below in this chat. Each unit must preserve current access checks and have a behavior check before completion.

- [x] Carry trusted tool metadata into current entitlement checks. Compare the bound current catalog registration with the session registration. Bind schemas, approval policy, retry policy, destination, and byte limits into its fingerprint.
- [x] Reserve internal skill tool names at registration and exclude those names from connector transcript dependencies. Test activation presentation and reads.
- [x] Replace per-record SQL conditions with relational joins against two JSON record sets. Retain version, generation, visibility, and dependency checks. Verify retrieval with more than 17,000 authorized records.
- [x] Add an optional source restriction to MemoryQuery. Intersect the agent's source grants with current user access before ranking, including an empty scope.
- [x] Store sealed empty accounts for anonymous connectors. Bootstrap must retain an existing account when credentials have been removed from runtime.json.
- [x] Record and flush an uncertain Slack dispatch before posting. Persist a retry state only after a definite rate-limit response. Test crash recovery.
- [x] Bind MCP fetch to the caller signal through initialization and cleanup. Give discovery a finite deadline. Test cancellation before tools/list.
- [x] Bound streamed model response bytes. Remove the unused per-run request limit rather than create another execution counter beside Pi. Update its configuration, producers, and documentation together.
- [x] Split workspace panels into focused modules. Replace creating, adminView, and tab with one discriminated view state. Preserve selection and request guards.
- [x] Fix the observed transcript test race by waiting for stream attachment.
- [x] Run formatting, types, build, React checks, affected integration suites, and browser verification on a fresh disposable stack. Keep evidence and remove only the stack owned by this verification run.

Verified with workspace type, build, lint, and React checks; policy, memory, channel, contract, identity, native runtime, and pilot suites; and 22 browser paths. Browser evidence is in `artifacts/verification/verify-quality-a1c214e8/`.
