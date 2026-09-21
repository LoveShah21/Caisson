# 04 - Database design

Two stores with different jobs. Postgres holds mutable operational state with referential integrity. ClickHouse holds the immutable, high-volume, query-heavy audit record. Do not put audit rows in Postgres and do not put session state in ClickHouse.

## 1. Postgres

Drizzle ORM. Migrations in `packages/db/migrations`. All timestamps `timestamptz`. All primary keys UUID v7 so they sort by creation time.

### 1.1 sessions

```sql
CREATE TYPE session_status AS ENUM (
  'pending','booting','ready','active','suspended','terminating','terminated','failed'
);
CREATE TYPE approval_mode AS ENUM ('auto','rule','always');

CREATE TABLE sessions (
  id                  UUID PRIMARY KEY,
  status              session_status NOT NULL DEFAULT 'pending',
  agent_image         TEXT NOT NULL,
  entrypoint          TEXT NOT NULL DEFAULT 'default',
  approval_mode       approval_mode NOT NULL DEFAULT 'rule',
  scopes              TEXT[] NOT NULL,
  roles               TEXT[] NOT NULL DEFAULT '{}',
  policy_bundle_id    UUID NOT NULL REFERENCES policy_bundles(id),
  requested_by        TEXT NOT NULL,
  purpose             TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}',
  host_id             TEXT,
  driver              TEXT,                       -- firecracker | container
  hardware_isolated   BOOLEAN NOT NULL,
  snapshot_ref        TEXT,
  valid_from          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL,
  idle_timeout_s      INTEGER NOT NULL DEFAULT 300,
  last_activity_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  terminated_at       TIMESTAMPTZ,
  termination_reason  TEXT
);

CREATE INDEX ON sessions (status) WHERE status IN ('ready','active','suspended');
CREATE INDEX ON sessions (expires_at) WHERE terminated_at IS NULL;
CREATE INDEX ON sessions (requested_by, created_at DESC);
```

`hardware_isolated` is denormalised onto the session deliberately. When someone asks in six months whether a given session ran with real isolation, the answer must be in the row, not inferred from configuration that has since changed.

### 1.2 session_tokens

```sql
CREATE TABLE session_tokens (
  id             UUID PRIMARY KEY,
  session_id     UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash     TEXT NOT NULL,          -- argon2id of the token; plaintext never stored
  scopes         TEXT[] NOT NULL,        -- snapshot at mint time
  issued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  revocation_reason TEXT
);
CREATE UNIQUE INDEX ON session_tokens (token_hash);
CREATE UNIQUE INDEX ON session_tokens (session_id);
```

V1 permits one token per session. Scopes are snapshotted at mint time so that widening the session record later cannot retroactively widen an existing token. Narrowing is applied by intersecting token scopes with session scopes at evaluation time.

### 1.3 transport_bindings

The mechanism behind FR-20. A guest is identified by which connection it is on, not by what it claims.

```sql
CREATE TABLE transport_bindings (
  id           UUID PRIMARY KEY,
  session_id   UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  host_id      TEXT NOT NULL,
  vsock_cid    INTEGER NOT NULL,
  token_id     UUID NOT NULL REFERENCES session_tokens(id),
  bound_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX ON transport_bindings (host_id, vsock_cid) WHERE released_at IS NULL;
```

### 1.4 policy_bundles

```sql
CREATE TABLE policy_bundles (
  id            UUID PRIMARY KEY,
  version       TEXT NOT NULL,
  rego_source   TEXT NOT NULL,
  wasm_blob     BYTEA NOT NULL,
  source_hash   TEXT NOT NULL,
  signature     TEXT,                    -- detached signature over source_hash
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at  TIMESTAMPTZ,
  retired_at    TIMESTAMPTZ,
  notes         TEXT
);
CREATE UNIQUE INDEX ON policy_bundles (version);
```

Bundles are never updated in place. A change is a new row. Sessions reference the bundle they started with, so a policy change mid-session cannot alter what an in-flight session is evaluated against. Retiring a bundle that live sessions reference is blocked.

### 1.5 services and credentials

Credential *metadata* only. Values live in the secret backend.

```sql
CREATE TABLE services (
  id               UUID PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,     -- matches adapter name
  adapter          TEXT NOT NULL,
  config           JSONB NOT NULL DEFAULT '{}',   -- host allowlists, region, etc. no secrets
  enabled          BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE credential_refs (
  id             UUID PRIMARY KEY,
  service_id     UUID NOT NULL REFERENCES services(id),
  role           TEXT NOT NULL,              -- readonly | writer | admin
  backend        TEXT NOT NULL,              -- vault | env | aws-sm
  backend_path   TEXT NOT NULL,              -- a path, never a value
  rotated_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON credential_refs (service_id, role);
```

A `CHECK` constraint and a CI grep must both enforce that nothing resembling a secret lands in `backend_path` or `config`. Add a test that inserts a plausible secret and asserts rejection.

### 1.6 approvals

```sql
CREATE TYPE approval_state AS ENUM ('pending','approved','denied','timed_out','cancelled');

CREATE TABLE approvals (
  id               UUID PRIMARY KEY,
  session_id       UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  action_id        UUID NOT NULL,
  nonce            TEXT NOT NULL,            -- never sent to the guest
  state            approval_state NOT NULL DEFAULT 'pending',
  service          TEXT NOT NULL,
  method           TEXT NOT NULL,
  params_summary   TEXT NOT NULL,            -- human-readable, redacted
  agent_intent     TEXT,
  policy_reason    TEXT NOT NULL,
  requested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  decided_at       TIMESTAMPTZ,
  decided_by       TEXT,
  decision_comment TEXT,
  decision_sig     TEXT                      -- control plane signature over (id, nonce, state)
);
CREATE UNIQUE INDEX ON approvals (nonce);
CREATE INDEX ON approvals (state, expires_at) WHERE state = 'pending';
```

### 1.7 snapshots

```sql
CREATE TABLE snapshots (
  id            UUID PRIMARY KEY,
  kind          TEXT NOT NULL,             -- base | session
  session_id    UUID REFERENCES sessions(id) ON DELETE CASCADE,
  object_key    TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL,
  checksum      TEXT NOT NULL,
  kernel_ref    TEXT,
  rootfs_ref    TEXT,
  built_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  promoted_at   TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ
);
CREATE INDEX ON snapshots (kind, promoted_at DESC);
```

Base-snapshot promotion is a single transaction updating a pointer row in `settings`, so FR-14 holds without a race.

### 1.8 settings

```sql
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);
```
Holds `active_base_snapshot`, `active_policy_bundle`, `interceptor_allowlist`, and similar.

### 1.9 Entity relationships

```
policy_bundles 1---* sessions 1---* session_tokens 1---* transport_bindings
                        |
                        +---* approvals
                        +---* snapshots (kind='session')
services 1---* credential_refs
```

## 2. ClickHouse

Append-only. No updates, no deletes outside TTL. One table plus two materialised views.

### 2.1 actions

```sql
CREATE TABLE actions (
  session_id       UUID,
  action_id        UUID,
  timestamp        DateTime64(3),
  seq              UInt32,                          -- monotonic within session
  event_type       LowCardinality(String),          -- started|completed|failed|denied|require_approval|approval_resolved|observed|lifecycle
  action_type      LowCardinality(String),          -- broker_call|exec|read|write|edit|search|ask_user|approval|lifecycle|policy_simulate|network_denied
  service          LowCardinality(String),
  method           LowCardinality(String),
  decision         LowCardinality(String),          -- allow|deny|require_approval|n/a
  policy_bundle    LowCardinality(String),
  policy_reason    String,
  obligations      Array(LowCardinality(String)),
  scope_used       LowCardinality(String),
  role_used        LowCardinality(String),
  params_hash      FixedString(64),
  params_preview   String,                          -- redacted, max 512 bytes
  result_bytes     UInt32,
  result_hash      FixedString(64),
  redaction_count  UInt16,
  duration_ms      UInt32,
  approval_id      Nullable(UUID),
  approval_wait_ms Nullable(UInt32),
  skill_loaded     LowCardinality(String),
  agent_intent     String,
  driver           LowCardinality(String),
  hardware_isolated UInt8,
  trace_id         String,
  span_id          String,
  error_code       LowCardinality(String),
  error_message    String,
  network_destination String,
  network_protocol LowCardinality(String)
) ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (session_id, seq)
TTL toDateTime(timestamp) + INTERVAL 13 MONTH;
```

Ordering by `(session_id, seq)` rather than timestamp makes the most common query, replaying one session in order, a single contiguous read. `seq` also makes gaps detectable, which matters for INV-4: a missing sequence number is evidence.

Executable operations use the same `action_id` for their `started` and terminal rows. Denials have one terminal row because nothing executes. Approval creation and resolution have separate rows linked by `approval_id`. A `network_denied` row is host-observed and stores only `network_destination`, `network_protocol`, and `timestamp`; parameter and result fields remain empty. A `policy_simulate` row is retained for audit but excluded from the real session replay query.

### 2.2 Materialised views

```sql
CREATE MATERIALIZED VIEW denials_mv
ENGINE = MergeTree PARTITION BY toYYYYMM(timestamp) ORDER BY (timestamp, service)
AS SELECT * FROM actions WHERE decision = 'deny';

CREATE MATERIALIZED VIEW service_activity_mv
ENGINE = SummingMergeTree ORDER BY (day, service, method, decision)
AS SELECT toDate(timestamp) AS day, service, method, decision,
          count() AS calls, sum(result_bytes) AS bytes, sum(duration_ms) AS total_ms
FROM actions GROUP BY day, service, method, decision;
```

### 2.3 The three canned queries

Implement these as named functions in `packages/audit` with typed results:

1. `replaySession(sessionId)` - ordered actions with previews, decisions, approvals, and loaded skills, excluding records where `action_type = 'policy_simulate'`.
2. `serviceActivity(service, from, to)` - what touched a service, by whom, with what outcome.
3. `denials(from, to, filters?)` - every refusal, with policy reason and the session's stated purpose.

## 3. Redis

Not the final store of record. Holds BullMQ queues (`approvals`, `snapshot-rebuild`, `session-reaper`), the approval wait registry, and a short-lived idempotency key set. It may also hold the persistent completion stream used when a direct post-execution ClickHouse write fails. Queue and registry state is reconstructible. A completion-stream entry is retained durably until ClickHouse acknowledges the corresponding terminal audit row; Redis persistence must be enabled when this implementation is selected instead of the on-disk broker WAL.

## 4. Rules

- No secret value in either store. Enforced by a CI check and a test.
- Postgres rows are mutable state; ClickHouse rows are facts. Never repurpose one for the other.
- Any schema change requires a migration, a note in `13-DECISIONS.md` if it changes meaning, and an update to this document in the same pull request.
