CREATE TYPE session_status AS ENUM (
  'pending',
  'booting',
  'ready',
  'active',
  'suspended',
  'terminating',
  'terminated',
  'failed'
);

CREATE TYPE approval_mode AS ENUM ('auto', 'rule', 'always');

CREATE TABLE policy_bundles (
  id UUID PRIMARY KEY,
  version TEXT NOT NULL,
  rego_source TEXT NOT NULL,
  wasm_blob BYTEA NOT NULL,
  source_hash TEXT NOT NULL,
  signature TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  activated_at TIMESTAMPTZ,
  retired_at TIMESTAMPTZ,
  notes TEXT
);

CREATE UNIQUE INDEX policy_bundles_version_uidx ON policy_bundles (version);

CREATE TABLE sessions (
  id UUID PRIMARY KEY,
  status session_status NOT NULL DEFAULT 'pending',
  agent_image TEXT NOT NULL,
  entrypoint TEXT NOT NULL DEFAULT 'default',
  approval_mode approval_mode NOT NULL DEFAULT 'rule',
  scopes TEXT[] NOT NULL,
  roles TEXT[] NOT NULL DEFAULT '{}',
  policy_bundle_id UUID NOT NULL REFERENCES policy_bundles(id),
  requested_by TEXT NOT NULL,
  purpose TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  host_id TEXT,
  driver TEXT,
  hardware_isolated BOOLEAN NOT NULL,
  snapshot_ref TEXT,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  idle_timeout_s INTEGER NOT NULL DEFAULT 300,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  terminated_at TIMESTAMPTZ,
  termination_reason TEXT
);

CREATE INDEX sessions_active_status_idx
  ON sessions (status)
  WHERE status IN ('ready', 'active', 'suspended');
CREATE INDEX sessions_unterminated_expiry_idx
  ON sessions (expires_at)
  WHERE terminated_at IS NULL;
CREATE INDEX sessions_requester_created_idx
  ON sessions (requested_by, created_at DESC);

CREATE TABLE session_tokens (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  scopes TEXT[] NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT
);

CREATE UNIQUE INDEX session_tokens_token_hash_uidx ON session_tokens (token_hash);
CREATE UNIQUE INDEX session_tokens_session_id_uidx ON session_tokens (session_id);
