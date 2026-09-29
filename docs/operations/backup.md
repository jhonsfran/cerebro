# Back up and restore a Compose project

Use this procedure for the named-volume Compose deployment. Reserve a maintenance window. Prevent other operators and schedulers from starting containers during the backup or restore.

## Create a backup

1. Check out the exact deployed Git release. Keep all local deployment changes with the backup.
2. Confirm that Docker has the pinned Node helper image from `deploy/Dockerfile`.
3. Select a new backup directory on a protected filesystem. Keep its parent directory private.
4. Run the backup from the repository root.

```sh
node deploy/backup.mjs backup --project cerebro --directory /secure/backups/cerebro-2026-09-30
```

If the deployment uses extra Compose files, supply every file in merge order.

```sh
node deploy/backup.mjs backup --project cerebro --directory /secure/backups/cerebro-2026-09-30 --file compose.yaml --file compose.local.yaml
```

Wait for `Backup complete`. Retain the Docker images whose IDs appear in `manifest.json`. Export those IDs with `docker image save` to protected storage before you remove the source images. The backup records the operator checkout in `release` and its dirty state in `sourceCheckoutDirty`. The image IDs identify the deployed binaries. A Git release alone does not identify a dirty build. Check that the source services resume. The tool starts only services that were running before the backup. It also attempts this recovery after a backup error or SIGINT or SIGTERM. If a service cannot resume, inspect the source project before you retry. Do not use SIGKILL during the maintenance window.

The backup stops API, web, celld, and other clients before PostgreSQL and both MinIO services. It then archives all seven stopped volumes. PostgreSQL uses a cold data-directory snapshot. Keep its exact pinned image. This backup does not provide a portable SQL dump.

Protect the complete backup directory as a secret. Its `secrets.tar`, `postgres-credential.tar`, and `minio-credential.tar` contain credentials. The tool creates the directory with mode `0700` and its files with mode `0600`. Encrypt the directory with your approved backup system before you copy it elsewhere. The SHA256 manifest detects corruption. It does not prove who created the backup.

Do not use a directory that contains a failed backup. A failed backup has no complete `manifest.json`. Keep the failed files for diagnosis or remove them under your retention policy. Retry with a new directory.

## Restore into a fresh project

1. Verify the backup source and integrity through your backup system.
2. Check out the Git release in `manifest.json`. Apply the saved deployment configuration.
3. Keep the exact PostgreSQL image reference from the manifest.
4. Load every recorded Docker image ID onto the restore host with `docker image load`. Retain the pinned Node helper image too.
5. Select a new Compose project name. Do not create its containers or volumes first.
6. Run the restore with the same Compose files.

```sh
node deploy/backup.mjs restore --project cerebro-restored --directory /secure/backups/cerebro-2026-09-30
```

The tool rejects the source project, existing target containers, and existing target volumes. It verifies all archive hashes before it creates a volume. It then creates seven volumes and restores each archive into an empty volume. It never deletes existing data. If a restore fails after volume creation, retain that project for diagnosis. Retry with another fresh project.

7. Set unused host ports and the correct public URLs for the restored project.
8. Start the restored project with the generated image override. Do not rebuild its images.

```sh
CEREBRO_API_PORT=18766 CEREBRO_WEB_PORT=3002 docker compose -p cerebro-restored -f compose.yaml -f /secure/backups/cerebro-2026-09-30/cerebro-restored.images.yaml up -d --wait
```

9. Verify the API readiness response.
10. Verify an existing auth user and session with the original auth credentials.
11. Verify a conversation, its ledger, source access, runtime state, memory records, and an artifact.
12. Compare those results with the source records captured before the backup.

## Back up production bind-mounted secrets

Do not use this tool with `compose.production.yaml`. It refuses bind mounts before it stops a service. Production secrets live outside the seven named volumes.

Use a separate approved procedure for that deployment. Stop API, web, and celld first. Stop both MinIO services and PostgreSQL next. While all stores are stopped, archive their data volumes and the full `CEREBRO_PRODUCTION_SECRETS_DIR` directory. Preserve file ownership and modes. Protect `postgres-password`, `minio-password`, and `auth-secret` together with the snapshots. Also retain the PostgreSQL connection configuration and any externally managed database backup. Restore those secrets before the production secrets check or any service starts. Do not generate new secrets for old data.

For restore rehearsal, use a fresh production project, fresh data volumes, and a separate secret directory. Use the same pinned images and external database release. Check the deployed API records before you move traffic.
