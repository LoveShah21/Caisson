ALTER TABLE sessions
  ADD COLUMN next_audit_seq INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN action_allow_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN action_deny_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN action_require_approval_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN failure_reason TEXT CHECK (
    failure_reason IS NULL OR failure_reason IN ('start_timeout', 'driver_error', 'cleanup_pending')
  );

CREATE TABLE audit_outbox (
  id                UUID PRIMARY KEY,
  session_id        UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL CHECK (seq > 0),
  payload           JSONB NOT NULL,
  delivery_state    TEXT NOT NULL DEFAULT 'pending'
                    CHECK (delivery_state IN ('pending', 'delivered')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at      TIMESTAMPTZ,
  CONSTRAINT audit_outbox_session_seq_uidx UNIQUE (session_id, seq),
  CONSTRAINT audit_outbox_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT audit_outbox_payload_safe CHECK (
    payload::text !~ '"(params|rawParams|raw_params|credential|credentials|secret|secrets|result|rawResult|raw_result)"[[:space:]]*:'
  )
);

CREATE INDEX audit_outbox_pending_session_seq_idx
  ON audit_outbox (session_id, seq)
  WHERE delivery_state = 'pending';
