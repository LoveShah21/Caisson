# Caisson

Caisson is an isolated execution environment for LLM agents. The agent has no
credentials and requests external actions through a host-side broker.

The container driver is for local development only. It shares the host kernel
and does not provide hardware isolation. Use Firecracker on a Linux KVM host
for the production isolation boundary.

## Quickstart

Requirements: Node 22 or newer, pnpm, and Docker Compose.

Copy the environment template and replace the snapshot KMS and manifest-key
placeholders with independent base64-encoded 32-byte values. The MinIO static
KMS setting is for local development only. Production must use platform
SSE-KMS.

```bash
cp .env.example .env
openssl rand -base64 32
```

Set generated values in `.env` before starting Compose.
`CAISSON_SNAPSHOT_CACHE_MAX_BYTES` must be a positive integer.

```bash
pnpm install
docker compose --env-file .env --env-file deploy/minio/image.env -f deploy/docker-compose.yml up -d
pnpm bootstrap:policy
pnpm bootstrap:services
```

`pnpm bootstrap:policy` compiles `policies/bootstrap/default.rego` with the
pinned OPA image, stores the source and wasm bundle in Postgres, and creates
`settings.active_policy_bundle` when none exists. It is idempotent.

`pnpm bootstrap:services` applies the source-controlled non-secret service and
credential-reference declaration in `services/bootstrap.json`. It is
idempotent. Set the referenced credential values in the configured secret
backend before starting a session.

Verify that the active bundle exists:

```bash
docker compose -f deploy/docker-compose.yml exec postgres psql -U caisson -d caisson -c \
  "SELECT value FROM settings WHERE key = 'active_policy_bundle';"
```

The command must return one row containing a `policyBundleId`.

For the current implementation and limits, start with
[`docs/00-INDEX.md`](docs/00-INDEX.md).
