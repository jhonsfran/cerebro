# Policy adapters

`createPaidWork` owns current authorization, entitlement, durable dispatch, and accounting. Inject the runtime operation journal. A pending dispatch cannot invoke the provider again. A known outcome is saved before settlement. Replaying it resumes accounting and checks current policy before it returns the saved output. Unknown usage keeps the maximum reserved.

`createUnpriceAdapter` uses `@unprice/api` 0.3.1. Configure each company with its actual customer, currency, unit conversion, feature slugs, and verified meter. The adapter pins that mapping when it records reserve intent. Change `meter.version` whenever the properties transformation or its commercial meaning changes. Deployment must verify that version against the configured provider meter. A mapping change requires a new operation. Settlement uses `runs.settle`, saves its receipt, and then ends the run. Billable usage cannot also go through `usage.record`.

`createJevAdapter` uses `@typesafe-ai/sdk` 0.6.0 with pinned `jev-1.13.0` pricing. Its explicit USD minor-unit configuration reserves a conservative 65,536 input tokens. Automatic retries are disabled. Missing configuration denies before a live provider call. Local fixtures use injected transports and need no external credentials.

Run `node tests/policy/run.mjs` for the policy tests. The runner creates isolated PostgreSQL when `POLICY_TEST_DATABASE_URL` is absent.
