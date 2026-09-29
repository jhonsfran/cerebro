# Session 3 identity and authorization

Status: local subsystem checks pass. Enterprise identity is optional and activates only when configured. A real Entra tenant round trip is required only before enabling Entra for a deployment. Protected runtime call sites still need current policy checks when those paths are enabled.

Branch: `codex/enterprise-identity`. Base commit: `38893f5`. The session owns `packages/auth/**`, `packages/authorization/**`, the identity schema and repository, the identity API router, and `tests/identity/**`. The coordinator changed shared package configuration, Worker routing and bindings, deployment bootstrap, and migration files in the same worktree.

## Gate 0 exception

The Worker PostgreSQL connection over publicly trusted TLS is **skipped for session 3 by explicit user instruction on 2026-09-29**. It has no successful test result. The separate real model provider check remains unrun. This exception does not change the Session 0 or Session 1 evidence and does not qualify a production deployment. The existing production `sslmode=verify-full` guard remains in place.

## Identity model

`identity_principal` is a stable, company-scoped identity for a human, service, or agent. Better Auth stores the login user and provider account. A principal stores the Better Auth user ID separately. The authorization policy reads the current principal, direct grants, SCIM projection grants, role permissions, and delegation scope from PostgreSQL for each decision. A service delegation permits only the intersection of the actor grant, represented principal grant, and delegation scope.

| Input | Check and mapping |
| --- | --- |
| OIDC `iss` | Must equal the administrator configured, tenant-specific issuer and the Better Auth account issuer. |
| OIDC `tid` | Must equal the configured Entra tenant ID. |
| OIDC `sub` | Must equal the verified Better Auth account subject. |
| OIDC `oid` | Must match an active SCIM User `externalId` in the configured connection and company. Entra SCIM mapping must send the object ID as `externalId`. |
| SCIM Group `externalId` | Maps through explicit configured group IDs to role IDs. Display names do not grant roles. |
| Email | Used as profile data only. Matching email addresses do not link identities or grant access. |

The optional `enterprise-identity.json` file in the deployment secret directory supplies `organizationId`, `tenantId`, `issuer`, `providerId`, `domain`, `clientId`, `clientSecret`, `scimConnectionId`, `scimBearerToken`, and `groupRoles`. Without this file, Better Auth runs without enterprise SSO or SCIM plugins. When the file exists, bootstrap validates its values before deployment, creates the configured organization after migration if it is absent, and passes the file to the Worker as `ENTERPRISE_IDENTITY_JSON`. Readiness checks both database access and authentication setup. SAML has no configured provider in this pilot.

## Provisioning and revocation

Pinned Better Auth, SSO, and SCIM versions are `1.7.6`. SCIM POST creates a directory-managed principal. SCIM deactivation disables it, removes its Better Auth sessions, revokes its delegations, and consumes outstanding Slack link challenges in the plugin transaction. Local principal controls reject state changes to directory-managed principals; SCIM remains the state authority. A decommissioning SCIM connection and a removed SCIM Group grant are denied on the next authorization read. A disabled principal also makes an existing Slack link unusable. Role permission replacement is serialized per organization. The local PostgreSQL tests observed denial on the next policy evaluation after removal or deactivation. There is no polling interval, but there is no measured external propagation bound. A changed `groupRoles` configuration needs a SCIM projection reconciliation run.

The identity RPC resolves a principal from the authenticated Better Auth user. It permits audit and usage export only after a current company-scoped export decision. An authorization read stops waiting when its deadline passes or its caller cancels; a database operation already in progress can still finish after that response. It does not use SSO claims to raise budgets. The Slack link initiation RPC stores a SHA-256 digest of a random one-use code with a ten-minute expiry. PostgreSQL consumes the digest atomically. Session 6 must verify the Slack request signature, derive the company from trusted workspace configuration, and then call `consumeSlackLinkChallenge`; this session does not expose an unverified completion route.

## Verification

| Check | Result | Scope |
| --- | --- | --- |
| `rtk proxy pnpm test:identity` | 18 passed | Local policy, OIDC claim, SCIM projection, identity RPC, Slack initiation, and deadline fixtures. |
| `rtk proxy env IDENTITY_TEST_DATABASE_URL=... pnpm test:identity:postgres` | 5 passed | Clean PostgreSQL 17 migration, SCIM User and Group HTTP changes, signed local OIDC callback, current grants, connection decommission, Slack challenge replay and revocation, and concurrent role replacement. |
| `rtk proxy pnpm check-types` | Passed | Workspace TypeScript projects. |
| `rtk proxy pnpm build` | Passed | Workspace packages, server bundle, and web build. |
| `rtk proxy pnpm test:boot` | 2 passed | Fresh Compose boot, authentication persistence, and artifact check. The production TLS configuration guard was tested; a trusted TLS connection was not. |
| `rtk proxy pnpm test:contracts` | 35 passed | Existing contract fixtures after the shared TypeScript configuration change. |
| `rtk proxy pnpm exec bun test tests/bootstrap/enterprise.test.ts` | 3 passed | Invalid enterprise config fails before deployment and invalid Worker auth settings make readiness fail. |
| Scoped `oxlint` and `oxfmt` | Passed | Session 3 source and tests. |
| `rtk proxy pnpm install --frozen-lockfile --offline` | Passed | Dependency lockfile consistency. |

The PostgreSQL tests used an isolated temporary PostgreSQL 17 container and applied migrations `0000` and `0001` to a clean database. The local OIDC server served discovery and JWKS data, signed an RS256 ID token, checked PKCE, and completed the Better Auth callback. This is a local fixture, not an Entra result. A live Entra tenant round trip has not been run. This does not block an installation without Entra configuration. Session 7 must connect current policy checks to each enabled sensitive read, tool call, approval, and resumed execution path; contract fixtures alone cannot verify those call sites. The repository-wide `pnpm check` remains red on existing UI and `.agents` files. Scoped lint and formatting pass for this session.
