# Session 6 review synthesis

Intent. Deliver the web product and linked Slack direct-message channel against persisted local fixtures. Keep real production adapters as session 7 composition work. Review the implementation against its immutable base, not main while other sessions advance it.

Three Interrogate reviewers used the configured `inherit-parent` aliases. They were independent tasks. They did not use different model families. The original reports were read from `/tmp/cerebro-s6-interrogate-{a,b,c}.md`. The coordinator reviewed the source and made the judgments below.

## Accepted findings

| Finding | Final change | Repeatable evidence |
| --- | --- | --- |
| Dispatcher imported a missing router export | Import the channel drain directly. | Native Worker build and product test. |
| Slack reply could contain only the first stream batch | Require stored completed-run evidence before the one reply. | `tests/channels/slack.test.ts` covers more than 100 output records. |
| Completion between stream and inspect could leave a conversation idle before its terminal cursor | Keep projection active until the snapshot cursor is consumed. | `tests/channels/slack.test.ts` covers completion after the first batch. |
| One unavailable pending session stopped unrelated work | Handle retryable failure per session and rotate attempts with a stored timestamp. | `tests/channels/web.test.ts` covers unavailable rows ahead of healthy admission. |
| Stale access retry restored a revoked grant | Commit the operation digest, result, and manual grant replacement together. | `tests/channels/web.test.ts` covers stale replay and changed input. |
| Optional budget denial cleared a permitted conversation | Treat only optional budget403 as a local denial. Keep401 and other resource denials strict. | `tests/channels/ui.test.ts`. |
| Agent save retries created duplicate agents | Keep an operation ID for equivalent canonical input. Rotate after a confirmed new intent. | `tests/channels/ui.test.ts`. |
| Agent selection retained another agent's conversation | Clear the conversation route on agent selection; resolve saved routes from validated conversation metadata. | Actual browser selection and saved-route verification. |
| Slack link text omitted the required command | Display `link CODE`. | Actual browser link instruction and signed Slack tests. |
| Audit read ignored its separate grant | Require current company audit permission and conversation permission. | `tests/channels/web.test.ts` covers missing grant and revocation. |
| A late successful response restored data after denial or logout | Advance access generation before clear; reject stale responses, stream records, and state setters. | `tests/channels/ui.test.ts`. |
| Browser CORS preflight returned500 | Return the direct Hono CORS Response from the outer middleware. | Native product test asserts204 and the allowed origin; actual browser sign-in. |

All accepted source findings are fixed. The code review found no remaining blocking source issue.

## Judgments and limits

The judge preferred oRPC. No reviewer demonstrated a transport defect in the selected REST handlers. They retain cookie authentication, Origin checks, Zod input/output validation, current policy, stable operation identities, and bounded SSE reads. A transport rewrite was dismissed as a preference without evidence of a defect.

A suspected copy of SCIM permissions into manual grants was dismissed after the reviewer traced the actual repositories. SCIM permissions come from a separate derived projection. The editable agent view queries direct grants; its current writers use manual grants. The initially stated copy path was not reachable.

The independent audit permission is strict. A user without that permission can still see an audit button. Clicking it receives403 and clears the private interface. This is a remaining UX limit. A future capability flag can hide the unavailable action. It does not bypass policy.

Real model, tool, memory, budget, catalog, and audit adapters remain session 7 work. Fixture recovery, citations, tools, and balances do not establish real integration. Unknown Slack delivery requires operator reconciliation. Live Slack and the inherited production TLS/model checks are unrun. These are explicit delivery limits.

The comment review kept sequential-effect and browser-timer suppressions because the API or cursor order requires them. It also kept style-only sort suppressions on fresh arrays and the test that deliberately changes key order. No TypeScript safety suppression or narration comment was added.

The independent [handoff audit](session-6-handoff-audit.md) checked the recorded results against the active transcript. The timing label and screenshot extensions were corrected. No open handoff correction remains.
