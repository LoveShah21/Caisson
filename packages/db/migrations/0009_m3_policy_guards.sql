-- A policy bundle may be loaded only after its exact source, test source, and
-- WASM bytes have passed the pinned OPA test/build path. Existing bundles stay
-- unverified until bootstrap:policy re-attests them.
ALTER TABLE policy_bundles
  ADD COLUMN rego_test_source TEXT,
  ADD COLUMN test_attestation_sha256 TEXT
    CHECK (test_attestation_sha256 ~ '^[a-f0-9]{64}$');

-- The counter is cumulative per session and method, including denied calls.
-- Its update and the corresponding outbox event must commit in one transaction.
CREATE TABLE session_method_attempts (
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  method TEXT NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count > 0),
  PRIMARY KEY (session_id, service, method)
);
