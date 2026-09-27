CREATE TABLE transport_bindings (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL,
  vsock_cid INTEGER NOT NULL,
  token_id UUID NOT NULL REFERENCES session_tokens(id),
  bound_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX transport_bindings_active_peer_uidx
  ON transport_bindings (host_id, vsock_cid)
  WHERE released_at IS NULL;

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);
