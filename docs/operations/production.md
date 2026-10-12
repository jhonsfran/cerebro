# How to run Cerebro in production

This guide deploys one company installation with `compose.production.yaml`. For a local stack, use `pnpm start` from the [README](../../README.md).

Production differs from local mode in four ways. Models and connectors must use public HTTPS. PostgreSQL must use `sslmode=verify-full`. The public URLs must use HTTPS. Secrets come from a directory you manage instead of generated Docker volumes.

## Prepare the secrets directory

Create a private directory outside the repository and put these files in it:

| File | Contents |
| --- | --- |
| `auth-secret` | A random value of at least 32 characters for Better Auth sessions |
| `postgres-password` | The PostgreSQL password, at least 32 characters |
| `minio-password` | The MinIO password, at least 32 characters |
| `runtime.json` | Models, tools, and storage. See the [runtime configuration reference](../reference/runtime-configuration.md). |
| `channels.json` | Optional. Enables Slack direct messages. See [How to connect Slack](slack.md). |
| `enterprise-identity.json` | Optional. Entra single sign-on and SCIM, parsed by `parseEnterpriseIdentityJSON` in `packages/auth/src/enterprise.ts` |

Set `bootstrapToken` or `trustedOwnerUserId` in `runtime.json` before the first start. Public signup never makes someone the owner.

## Start the stack

1. Put a TLS reverse proxy in front of the API port `18765` and the web port `3001`. Both listen on loopback.
2. Set the environment and start the stack:

```sh
export CEREBRO_PRODUCTION_SECRETS_DIR=/secure/cerebro
export CEREBRO_DATABASE_URL='postgres://cerebro:<PASSWORD>@db.example.com:5432/cerebro?sslmode=verify-full'
export CEREBRO_PUBLIC_API_URL=https://api.cerebro.example.com
export CEREBRO_PUBLIC_WEB_URL=https://cerebro.example.com
docker compose -f compose.yaml -f compose.production.yaml up --build --detach --wait
```

The web bundle contains its public API URL. If you change `CEREBRO_PUBLIC_API_URL`, rebuild the web image.

`bootstrap` applies database migrations and publishes the Worker each time the stack starts. To apply a changed `runtime.json`, start the stack again.

## Become the owner and grant access

1. Sign up in the web app.
2. Enter the `bootstrapToken` from `runtime.json` on the setup screen.

The owner can manage agents and read the audit. The web app manages agent access only: who may read, run, and approve an agent's work. Tools, memory sources, and exports need explicit grants. Insert them into `identity_grant`:

```sql
INSERT INTO identity_grant (organization_id, principal_id, action, resource_kind, resource_id, source)
VALUES ('<ORGANIZATION_ID>', '<PRINCIPAL_ID>', 'execute', 'tool', 'search-tickets', 'manual');
```

A person needs `read` and `execute` on a tool, and `execute` on its `connectorId`, before an agent can use the tool for them. A write tool also needs `write` and `approve`. Grant `export` on the `audit` resource only to people who need audit exports.

## Back up and upgrade

Follow the [backup guide](backup.md) for backups and restore rehearsals.

To upgrade:

1. Record the deployed Git release, the image IDs, `runtime.json`, and the public URLs.
2. Take a complete backup.
3. Restore the backup into a fresh project and start the new release there. Point it at a restored copy of the database with a restore-specific `CEREBRO_DATABASE_URL`.
4. Check readiness at `/ready`, sign in as an existing user, open a conversation, and run one tool call.
5. Move traffic only after these checks pass.

Migrations only move forward. To roll back, restore the full backup with its recorded images, not an older binary against newer data.

## Rotate secrets

Do this in a maintenance window, after active runs finish.

- **Model or connector credentials**: update `runtime.json`, start the stack again, and run one permitted call.
- **`gatewaySigningKey`**: replace the key and start the stack again. Session requests signed with the old key stop working, so open chats reconnect.
- **`auth-secret`**: every user signs in again.
- **Database or MinIO passwords**: change each service and its clients in the same window. Keep the old credentials with old backups.

## Check an unknown tool outcome

A tool shown as an unknown outcome was dispatched, and Cerebro could not record its result. Cerebro does not retry an `at-most-once` tool. Look up the operation ID in the target system. The connector executor sends it as `Idempotency-Key` and `X-Cerebro-Operation-Id`. Asking the agent to repeat the action creates a new operation that needs its own approval.
