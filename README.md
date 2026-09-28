# Caisson

Caisson is an isolated execution environment for LLM agents. The agent has no
credentials and requests external actions through a host-side broker.

The container driver is for local development only. It shares the host kernel
and does not provide hardware isolation. Use Firecracker on a Linux KVM host
for the production isolation boundary.

## Quickstart

Requirements: Node 22 or newer, pnpm, and Docker Compose.

```bash
pnpm install
docker compose up -d
pnpm bootstrap:policy
```

`pnpm bootstrap:policy` compiles `policies/bootstrap/default.rego` with the
pinned OPA image, stores the source and wasm bundle in Postgres, and creates
`settings.active_policy_bundle` when none exists. It is idempotent.

Verify that the active bundle exists:

```bash
docker compose exec postgres psql -U caisson -d caisson -c \
  "SELECT value FROM settings WHERE key = 'active_policy_bundle';"
```

The command must return one row containing a `policyBundleId`.

For the current implementation and limits, start with
[`docs/00-INDEX.md`](docs/00-INDEX.md).
