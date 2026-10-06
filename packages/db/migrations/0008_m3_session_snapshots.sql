-- FR-16 / ADR-48. The raw session KEK and every snapshot DEK are never
-- persisted. Removing a snapshot-key row erases that snapshot; removing the
-- session-key row orphans every child snapshot key for session-wide erasure.
CREATE TABLE session_snapshot_keys (
  session_id UUID PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  root_kek_key_id TEXT NOT NULL,
  wrap_nonce BYTEA NOT NULL CHECK (octet_length(wrap_nonce) = 12),
  wrapped_session_kek BYTEA NOT NULL CHECK (octet_length(wrapped_session_kek) = 48),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE snapshot_keys (
  snapshot_id UUID PRIMARY KEY REFERENCES snapshots(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  wrap_nonce BYTEA NOT NULL CHECK (octet_length(wrap_nonce) = 12),
  wrapped_dek BYTEA NOT NULL CHECK (octet_length(wrapped_dek) = 48),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX snapshot_keys_session_idx ON snapshot_keys (session_id);

ALTER TABLE snapshots
  ADD COLUMN base_snapshot_id UUID REFERENCES snapshots(id),
  ADD COLUMN lineage_session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  ADD COLUMN resume_audit_seq INTEGER CHECK (resume_audit_seq > 0),
  ADD COLUMN resume_action_id UUID,
  ADD COLUMN deletion_state TEXT NOT NULL DEFAULT 'active'
    CHECK (deletion_state IN ('active', 'crypto_erased', 'physically_deleted'));

ALTER TABLE snapshots
  ADD CONSTRAINT snapshots_session_lineage_check CHECK (
    (kind = 'base' AND session_id IS NULL AND lineage_session_id IS NULL AND base_snapshot_id IS NULL
      AND resume_audit_seq IS NULL AND resume_action_id IS NULL)
    OR
    (kind = 'session' AND session_id IS NOT NULL AND lineage_session_id = session_id
      AND base_snapshot_id IS NOT NULL AND resume_audit_seq IS NOT NULL AND resume_action_id IS NOT NULL)
  );

CREATE INDEX snapshots_session_lineage_created_idx
  ON snapshots (session_id, built_at DESC)
  WHERE kind = 'session' AND deletion_state = 'active';

-- The base lineage is pinned when a Firecracker session is created. Capture
-- must never consult the mutable active-base pointer because promotion may
-- happen while the session is running.
ALTER TABLE sessions
  ADD COLUMN base_snapshot_id UUID REFERENCES snapshots(id);

-- Retry state is deliberately separate from audit_outbox: it tracks physical
-- deletion work, while audit_outbox remains the append-only audit delivery log.
CREATE TABLE snapshot_deletion_outbox (
  snapshot_id UUID PRIMARY KEY REFERENCES snapshots(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  bucket TEXT NOT NULL,
  manifest_key TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX snapshot_deletion_outbox_pending_idx
  ON snapshot_deletion_outbox (created_at)
  WHERE completed_at IS NULL;
