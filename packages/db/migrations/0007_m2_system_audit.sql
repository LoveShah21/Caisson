CREATE TABLE system_audit_events (
  id                UUID PRIMARY KEY,
  timestamp         TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type        TEXT NOT NULL,
  input_hash        TEXT NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  outcome           TEXT NOT NULL,
  duration_ms       INTEGER NOT NULL CHECK (duration_ms >= 0),
  trace_id          TEXT NOT NULL,
  span_id           TEXT NOT NULL,
  caller_connection TEXT
);

CREATE INDEX system_audit_events_timestamp_idx ON system_audit_events (timestamp DESC);
