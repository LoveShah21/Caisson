ALTER TABLE transport_bindings ADD COLUMN transport_kind TEXT;
ALTER TABLE transport_bindings ADD COLUMN peer_identifier TEXT;
UPDATE transport_bindings
SET transport_kind = 'vsock', peer_identifier = vsock_cid::text;
ALTER TABLE transport_bindings ALTER COLUMN transport_kind SET NOT NULL;
ALTER TABLE transport_bindings ALTER COLUMN peer_identifier SET NOT NULL;
DROP INDEX transport_bindings_active_peer_uidx;
ALTER TABLE transport_bindings DROP COLUMN vsock_cid;
CREATE UNIQUE INDEX transport_bindings_active_peer_uidx
  ON transport_bindings (host_id, transport_kind, peer_identifier)
  WHERE released_at IS NULL;
