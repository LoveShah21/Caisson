CREATE TABLE snapshots (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('base', 'session')),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  bucket TEXT NOT NULL,
  manifest_key TEXT NOT NULL,
  manifest_version TEXT,
  manifest_sha256 TEXT NOT NULL,
  manifest_size_bytes BIGINT NOT NULL CHECK (manifest_size_bytes > 0),
  manifest_key_id TEXT NOT NULL,
  built_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  promoted_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  CHECK ((kind = 'base' AND session_id IS NULL) OR kind = 'session')
);

CREATE INDEX snapshots_kind_promoted_idx ON snapshots (kind, promoted_at DESC);
