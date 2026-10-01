# 13 - Decision record

Append-only. Newest at the bottom. Every entry names the alternative it rejected. If you make a decision that closes off an alternative and it is not here, it is not a decision, it is an accident.

Format: id, date, status, decision, alternatives, reasoning, consequences.

---

## ADR-1: Two stores, Postgres and ClickHouse
**Status:** accepted

Postgres for mutable operational state, ClickHouse for the immutable audit record.

**Alternatives:** Postgres only, simpler to operate; ClickHouse only, one system to learn.

**Reasoning:** The audit table is append-only, high volume, and queried analytically over long ranges. Postgres handles that badly at volume and the index maintenance competes with the operational workload. Session state needs foreign keys, transactions, and enums, which ClickHouse does not provide. Two stores with clearly separate jobs is less complexity than one store doing a job it is bad at.

**Consequences:** Two migration paths, two clients, two failure modes. A local stack with more moving parts. Accepted.

---

## ADR-2: The broker runs on the host, not in the guest
**Status:** accepted, load-bearing

**Alternatives:** proxy inside the sandbox on localhost:3000, which is how most similar designs are drawn.

**Reasoning:** A proxy inside the guest is inside the untrusted boundary. A compromised agent can read its memory, attach a debugger, patch the binary, or simply read the credential out of the proxy's heap. Every guarantee in the threat model becomes unenforceable. The cost is that the transport must be vsock or an equally constrained channel rather than plain HTTP.

**Consequences:** More complex transport, a framed protocol to implement, no ability to use off-the-shelf HTTP middleware in the guest. This is the single most important structural decision in the project and it is not revisitable.

---

## ADR-3: TypeScript everywhere, no Go
**Status:** accepted

**Alternatives:** Go for the VMM supervisor using firecracker-go-sdk, TypeScript elsewhere.

**Reasoning:** The Firecracker control surface used here is small: create, configure, boot, snapshot, restore, destroy, all REST over a unix socket. Driving it from Node is straightforward. A second language doubles the toolchain, the CI matrix, the test harness, and the review burden for one solo maintainer, in exchange for an SDK wrapping calls that are already simple.

**Consequences:** Slightly more code in the isolation package. If the VMM surface grows substantially, revisit.

---

## ADR-4: Isolation behind a driver interface with a container fallback
**Status:** accepted

**Alternatives:** Firecracker only, which is the honest security position.

**Reasoning:** Firecracker requires KVM. Most laptops, most CI runners, and most people who will ever open this repository do not have it. A project that cannot be run by a reader effectively does not exist. The risk is that someone runs the container driver and believes they have hardware isolation, so the driver reports `hardwareIsolation: false`, warns loudly at startup, and the system refuses to start in production mode with it.

**Consequences:** Two implementations to maintain, and every invariant test runs against both. The README must be explicit about the difference, and being explicit about it is itself a point in the project's favour.

---

## ADR-5: SQL restrictions evaluate parsed statement type, never substrings
**Status:** accepted

**Alternatives:** substring matching for `DELETE`, `DROP`, and similar, as commonly written.

**Reasoning:** Substring matching is defeated by string literals (`SELECT 'DELETE'`), inline comments (`DEL/**/ETE`), case, encoding, and dynamic execution. It also produces false positives that make the rule annoying enough that someone eventually loosens it. Parsing in the broker and handing structured facts to Rego is correct and also keeps Rego simple. Unparseable input is denied.

**Consequences:** A SQL parser becomes part of the trust base and needs fuzzing. Multi-statement input must be rejected before parsing. Worth it.

---

## ADR-6: mitmproxy first, eBPF as a stretch
**Status:** accepted

**Alternatives:** eBPF from the start, which is the more impressive component.

**Reasoning:** The eBPF interceptor is the highest-risk item in the plan and the most likely to consume weeks without producing anything shippable. A working mitmproxy interceptor delivers the same security property at higher latency, and the latency is not on any critical path that matters in v1.

**Consequences:** Higher egress latency for intercepted destinations. The README states which interceptor is running. eBPF remains a stretch item with mitmproxy retained as fallback.

---

## ADR-7: Audit writes are on the critical path
**Status:** accepted

**Alternatives:** asynchronous fire-and-forget writes, which are faster and never block a user action.

**Reasoning:** The product claim is that no action escapes the log. If a write can fail silently, the claim is conditional and the audit trail cannot be relied on in an investigation, which is the only time it matters. Failing the action is the correct trade.

**Consequences:** Audit store availability becomes session availability. NFR-4 caps the write at ten milliseconds p99. A ClickHouse outage stops work, and that is the intended behaviour.

---

## ADR-8: Policy evaluated in-process via wasm, not a sidecar
**Status:** accepted

**Alternatives:** OPA as a sidecar over its REST API.

**Reasoning:** Policy evaluation is on every action. A network hop per action makes NFR-3 hard and adds a failure mode between two components that should not be able to disagree. wasm evaluation is sub-millisecond for bundles of this size.

**Consequences:** Bundles must be compiled to wasm at activation time, which the activation endpoint does after running the bundle's Rego tests. Compilation failure blocks activation, which is correct.

---

## ADR-9: Seven tools and no extension mechanism in the guest
**Status:** accepted

**Alternatives:** a plugin system so tools can be added without changing the runtime.

**Reasoning:** The security argument is that the agent has no mechanism to misbehave. A plugin system is a mechanism. Capability is added by writing an adapter on the host side, where it is subject to policy, schema validation, and audit, rather than by adding a tool in the guest.

**Consequences:** Extending Caisson means writing an adapter, which is the intended path.

---

## ADR-10: Audit is fail-closed before execution and fail-durable after execution
**Date:** 2026-09-21
**Status:** accepted

**Decision:** This decision supersedes ADR-7 for post-execution writes; ADR-7 remains in force before execution. A required audit write before execution is synchronous and fail-closed. An executable operation writes `action.started`; a denial writes one terminal record; an approval writes a record when created and another when resolved. No credential is fetched and no operation executes until the required pre-execution record is durable in ClickHouse. After execution, `action.completed` or `action.failed` is fail-durable. ClickHouse remains the fast path, but a failed direct write is appended to a persistent Redis stream or an on-disk broker WAL and retried until accepted. The result is returned only after ClickHouse or the durable buffer accepts the record. A reconciliation job flags stale starts without terminal records as orphaned and drains the buffer. Retries retain the original session sequence and action identity so consumers can collapse duplicate delivery.

**Alternatives:** Treat every audit failure as fail-closed, including after execution; write all audit records asynchronously; use a distributed transaction with each external service.

**Reasoning:** Before execution, failing the action preserves the invariant because no external effect has occurred. After a side-effecting call succeeds, refusing to return its result cannot undo the effect and can cause the agent to retry it. Asynchronous fire-and-forget writes can be lost. A distributed transaction is unavailable across the supported services. A durable completion path records what actually happened and exposes incomplete pairs for repair.

**Consequences:** The broker needs a durable completion buffer and idempotent retry behavior. Redis must have persistence enabled if its stream is used; otherwise the broker WAL must survive process restart. Operators need backlog and orphan alerts. ClickHouse outages still stop new actions at the pre-execution write, while already-executed completions continue through the durable path. A crash between the external effect and durable enqueue can still leave an orphaned start; reconciliation makes that condition visible but cannot reconstruct an unknowable service result.

---

## ADR-11: IsolationDriver.exec is an infrastructure primitive, not an agent capability
**Status:** accepted

**Alternatives:** Add `echo`, and by extension whatever else lifecycle probes need, to the guest v1 allowlist in `08-AGENT-RUNTIME.md`.

**Reasoning:** `IsolationDriver.exec` is used by the control plane to verify that a sandbox booted and is alive. It is a health check, not something an agent invokes. The guest-side `exec` tool and its INV-8 allowlist govern agent capability during a live session and are implemented separately in `apps/agent-runtime`, reachable only through the broker. Widening the agent-facing allowlist to accommodate an infrastructure health check would be capability creep with no corresponding product need. The agent never needs to run `echo`.

**Consequences:** Two things share the name `exec` at different layers. Anyone extending `IsolationDriver.exec` usage must confirm that it remains confined to control-plane and test contexts and is never wired into the broker request path for live agent actions.

---

## ADR-12: Temporary M-1 Firecracker development probe
**Status:** accepted

**Alternatives:** Delay Firecracker driver verification until the M-3 guest runtime exists; add a shell or an unrestricted command mechanism to the agent runtime.

**Reasoning:** Firecracker has no host-side exec API. M-1 needs a narrow mechanical check that a booted microVM can receive an infrastructure command and return output. The temporary static probe listens only on reserved vsock port `9999`, accepts one newline-delimited JSON argv request per connection, executes it without a shell, returns stdout and stderr, and closes the connection. It has no authentication, policy, or allowlist because it is not an agent capability. The probe is built only into `m1-dev-probe-rootfs.ext4`, and the Firecracker driver refuses that artifact when `CAISSON_ENV=production`.

**Consequences:** The probe is deliberately unsafe for a live agent session and exists only for opt-in M-1 verification. It must never be included in a rootfs or snapshot eligible for promotion, must never be reachable from the broker or guest-to-broker protocol, and must be removed once the M-3 guest runtime exec tool exists. While `CAISSON_MANUAL_FC_TEST=1`, failed and destroyed driver instances retain their runtime directory and Firecracker log for host diagnosis; this mode must not be used for production sessions.

---

## Template for new entries

```
## ADR-n: <decision in one line>
**Status:** proposed | accepted | superseded by ADR-m
**Alternatives:** <what you did not do>
**Reasoning:** <why>
**Consequences:** <what this costs, including the bad parts>
```

---

## ADR-13: M-1 readiness requires a completed probe command
**Status:** accepted

**Alternatives:** Treat Firecracker's `CONNECT` acknowledgement as guest readiness.

**Reasoning:** The vsock multiplexer can acknowledge a host stream before the temporary guest probe is ready to read it. Completing a harmless `/bin/echo` request and response proves the probe accept loop, request parsing, command execution, and response path are usable.

**Consequences:** M-1 boot readiness includes one guest command round trip and is therefore slower than a transport-only handshake. This remains infrastructure-only development scaffolding from ADR-12, not an agent capability or INV-8 test.

---

## ADR-14: The M-1 probe rootfs is writable only for boot support
**Status:** accepted

**Alternatives:** Mount the probe rootfs read-only and rely on an implicit `/dev/null`; introduce a general writable-root option for all Firecracker images.

**Reasoning:** The temporary probe needs devtmpfs and device nodes during boot. Its specifically named rootfs is therefore attached writable. The build creates `/dev` and fixes executable modes explicitly. The probe also supplies an in-memory empty stdin, so command execution does not depend on `/dev/null` being available.

**Consequences:** Only `m1-dev-probe-rootfs.ext4` is writable. It remains ineligible for production and snapshot promotion under ADR-12. Other rootfs images remain read-only until a separately reviewed persistent-workspace design exists.

---

## ADR-15: Align milestone requirements with their implementable dependencies
**Status:** accepted

**Alternatives:** Leave FR-1 through FR-17 and FR-62 assigned to M-1 despite the narrower M-1 gate; defer all lifecycle and snapshot requirements until M-4.

**Reasoning:** M-1 establishes the isolation-driver boundary and verifies both drivers. Session endpoints, token binding, lifecycle orchestration, snapshot scheduling and storage require the M-2 control-plane and broker work. The blocked-egress monitor requires the M-4 interception work. Assigning those requirements to the milestones that provide their dependencies keeps the roadmap and acceptance gates consistent.

**Consequences:** M-1 covers FR-8 through FR-12 only. M-2 additionally covers FR-1 through FR-7 and FR-13 through FR-17. M-4 additionally covers FR-62. The M-1 tag is recreated only after its corrected gate is complete.

---

## ADR-16: Move broker prerequisites into M-2
**Status:** accepted

**Alternatives:** Build the broker against a placeholder policy decision and defer all audit writing until M-5; leave core policy and its simulator in M-3.

**Reasoning:** FR-22 requires policy evaluation before a credential is fetched, and FR-23 and FR-26 require durable audit handling around execution. A broker cannot truthfully satisfy its M-2 requirements without these controls. M-2 therefore includes the in-process wasm evaluator, bundle loading, default-deny and scope checks, the `redact_pii` and `role:<name>` obligations, `POST /v1/policy/simulate`, the minimum ClickHouse actions writer, and the durable completion buffer. The security-sensitive SQL parsing and evasion resistance remain in M-3 with the agent runtime. Approval-mode policy remains in M-4 with approvals.

**Consequences:** M-2 expands to FR-33 through FR-36 and FR-39a, plus the minimum audit infrastructure required by FR-23 and FR-26. M-3 retains SQL parsing, Rego test gating, runtime-facing policy, and the seven-tool runtime. M-5 completes audit coverage, queries, views, dashboards, and alerts. The M-2 bootstrap creates a default policy bundle and records its id in `settings.active_policy_bundle`, so every session has a valid immutable policy reference.

---

## ADR-17: Bind identity to a host-issued transport descriptor
**Status:** accepted

**Alternatives:** Assume vsock everywhere; derive Firecracker CIDs from session ids; accept an identity field from the guest.

**Reasoning:** The container driver has no vsock, and pretending otherwise would be isolation theater for a development-only driver. Both drivers instead issue a host-only descriptor before guest traffic is accepted. Firecracker allocates CIDs from a per-host monotonic pool with a freelist and rejects any duplicate allocation. The container driver creates a restrictive, per-session Unix socket outside the container filesystem and bind-mounts only that socket into the container. `transport_bindings` records `(host_id, transport_kind, peer_identifier)` as the sole identity source.

**Consequences:** `prepare()` returns a host-only transport descriptor. The broker resolves identity from the peer endpoint selected by the driver and rejects every guest-supplied identity field. The binding migration replaces the vsock-specific column with an opaque peer identifier. Container transport provides the same identity guarantee as vsock, but not hardware isolation; production mode remains prohibited for the container driver.

---

## ADR-18: Split sandbox preparation from guest execution
**Status:** accepted

**Alternatives:** Keep `IsolationDriver.create()` as the only lifecycle method and persist a binding through a callback invoked by the driver.

**Reasoning:** The control plane must persist a host-issued transport binding before Firecracker receives `InstanceStart` or a container starts. A callback hides this security-critical order inside the driver and makes the persistence failure path harder to test and audit. `prepare()` returns allocated resources and a descriptor while guest execution is impossible; the control plane persists the binding and calls `start()` only after success. This modifies the M-1 `IsolationDriver` interface shipped at `cdb625a`.

**Consequences:** Every driver mechanism test and benchmark uses `prepare()` then `start()`. A binding persistence failure calls `destroy()` on the prepared handle and fails closed. `create()` may exist only as a private convenience inside an implementation; it is not part of the public interface.

---

## ADR-19: The broker owns host-side transport lifecycle
**Status:** accepted

**Alternatives:** Let each isolation driver create and accept its own host-side listener; release the listener before sandbox destruction.

**Reasoning:** B1 terminates at the host-side broker. A driver-owned connection lifecycle would create a second hidden host boundary and leave the broker unable to own identity allocation or teardown. The two drivers differ at the operating-system boundary. For a container, `transportHost.reserve()` directly creates and owns the owner-only Unix-socket listener. For Firecracker, `transportHost.reserve()` allocates the CID and random private UDS path and owns the connection lifecycle, but the trusted host-side Firecracker process performs the required `bind()` when configured with `uds_path`. The guest cannot reach, influence, or observe that path. Destroying an attachment while its sandbox remains live risks a connection being misclassified or dropped during teardown.

**Consequences:** `reserve()` returns a runtime-only host attachment. For container transport, `peerIdentifier` and the attachment endpoint are the same random absolute Unix-socket path beneath a mode-0700 host directory and the driver bind-mounts only that socket. For Firecracker, `peerIdentifier` remains the persisted CID while the attachment supplies a separate random private UDS path. Attachment paths are never persisted. `restore()` reserves a new attachment and leaves the VM paused until the replacement binding is persisted and `start()` resumes it. A broker crash terminates sessions on that host, so endpoint recovery across a broker restart is neither supported nor attempted. `destroy(handle)` always completes before `transportHost.release(descriptor)` is called. Driver code must never call `listen()` or `accept()` for guest broker transport.

---

## ADR-20: Postgres audit outbox is the durable audit delivery source
**Status:** accepted

**Alternatives:** Redis stream; an on-disk broker WAL; a distributed transaction spanning Postgres and ClickHouse; changing `actions` to `ReplicatedMergeTree`.

**Reasoning:** Postgres already holds the session state and can atomically allocate a per-session sequence number and record an audit event before execution. A single-node `MergeTree` keeps the specified ClickHouse engine and avoids adding ClickHouse Keeper to v1. Delivery holds a Postgres advisory lock per session and processes events in sequence order. Before retrying an ambiguous ClickHouse insert, the writer queries `(session_id, seq)`, so an insert that committed before the client timed out is not repeated. This supersedes ADR-10's Redis stream or on-disk WAL wording for the durable buffer.

**Consequences:** The outbox is not an audit store and contains only hashes, redacted previews, and safe metadata. Pre-execution records commit to the outbox and then synchronously reach ClickHouse before execution can proceed. Post-execution and terminal records are fail-durable once their outbox row commits. The optional finite ClickHouse non-replicated deduplication window is defence in depth only and requires a separate decision before it is enabled.

---

## ADR-21: Session teardown revokes before destruction and retains failed cleanup bindings
**Status:** accepted

**Alternatives:** Release transport before destroy; keep a token live until cleanup completes; store raw driver errors as failure reasons.

**Reasoning:** Revoking the token is a small idempotent database operation that removes authorization before a potentially slow or failing sandbox destroy. A binding cannot be released while destroy is unconfirmed because a still-live sandbox could retain or regain a host identity. Coarse failure reasons are sufficient for lifecycle state and avoid storing host or driver detail in an operator API response.

**Consequences:** Start failure and delete attempt revoke, destroy, then release. A revoke failure never skips destroy, but release is permitted only after both revoke and destroy are confirmed. A revoke, destroy, or release failure marks the session `failed` with `cleanup_pending` and leaves the binding reserved for reconciliation. The reconciler retries all incomplete cleanup steps idempotently, with a per-session Postgres advisory lock so separate control-plane instances cannot process the same session concurrently. The control plane reconciles stale booting sessions at startup and periodically. Lifecycle state changes append durable outbox events.

---

## ADR-22: Define approver authentication before the M-4 websocket hub
**Status:** proposed

**Alternatives:** Treat the session event URL as a bearer credential; accept unauthenticated websocket connections; infer an approver from a client-supplied field.

**Reasoning:** `websocketUrl` is a routing location returned by session creation, not a credential. The current API contract names websocket frames and says that the REST approval decision endpoint requires an authenticated approver, but it does not define a websocket authentication handshake or how the REST endpoint derives the approver identity. An unauthenticated approval channel would violate the approval trust boundary.

**Consequences:** M-4 must choose and document an authentication mechanism before implementing the websocket hub or approval decision endpoint. Until then, both endpoints must reject unauthenticated connections and decisions by default. The session URL alone must never grant subscription or decision authority.

---

## ADR-23: Base snapshots use signed manifests and storage-layer encryption
**Status:** accepted

**Alternatives:** Trust object-store metadata alone; store local paths in `SnapshotRef`; use application-level envelope encryption in M-2.

**Reasoning:** A Firecracker snapshot has multiple artifacts and a restored guest is unsafe if any one is stale, truncated, or modified. A signed manifest with artifact hashes and sizes provides a single immutable restore reference. M-2 uses object-store SSE because Caisson does not yet own key management. Application-level encryption and per-session snapshot keys need a separate design.

**Consequences:** `SnapshotRef` identifies an immutable manifest object, not host paths. The manifest includes compressed state, memory, rootfs, and kernel artifacts, a rotation key id, and an HMAC from a host-held `ManifestKeyProvider`; M-2 provides only a required environment implementation. Uploads request SSE and verify stored encryption metadata. Downloads verify into a temporary cache directory before atomic rename. Base snapshots are built from a clean boot without session input or agent work. Per-session snapshots are deferred to M-3 by ADR-26.

---

## ADR-24: A restored guest requires confirmed fresh entropy before readiness
**Status:** accepted

**Alternatives:** Assume the guest kernel or agent runtime reseeds automatically after restore; permit restored guests to generate security-sensitive randomness unchanged.

**Reasoning:** The current M-1 guest probe has no RNG reseed path and the Firecracker driver does not configure a virtual entropy device. Restoring a memory snapshot can therefore resume identical guest RNG state. This is not safe to assume away. Firecracker VMGenID may help a supporting Linux kernel reseed its kernel CRNG, but it is not sufficient until Caisson pins and verifies the Firecracker and guest-kernel versions, eliminates the resume race, and proves the required output distinction. User-space state also requires separate consideration.

**Consequences:** The M-1 development probe remains ineligible for promoted base snapshots. The Firecracker and guest-kernel pair is pinned in `deploy/runtime-versions.env` and checked in CI; changing it requires a fresh entropy verification. A restored guest must remain not-ready until a trusted entropy-refresh mechanism completes and confirms success. KVM-capable Firecracker testing must restore two guests from one snapshot and show different `getrandom`/`urandom` output; environments without KVM explicitly skip this case. No warm-restored guest may serve a real session before that test passes. Per-session snapshot design must include this requirement.

---

## ADR-25: A shared base rootfs is immutable; writable session state is per-VM
**Status:** accepted

**Alternatives:** Mount one writable rootfs backing file in multiple restored guests; copy or mutate the cached base rootfs for each session.

**Reasoning:** Firecracker snapshots require their backing rootfs at the original host path. The verified cache therefore stages one immutable backing artifact at a stable path. Sharing writable filesystem state between sessions would violate INV-7 and allow cross-session persistence. The M-1 probe is the only writable-root exception, and it is structurally ineligible for production and promoted snapshots.

**Consequences:** Every eligible base rootfs is mounted read-only. M-2 implements no writable per-session filesystem layer and must not start real sessions from a shared writable rootfs. M-3 must select and review a per-VM writable layer, such as a unique overlay or tmpfs workspace, before the runtime can write session state. The shared cache entry remains immutable throughout its use.

---

## ADR-26: Move per-session snapshots from M-2 to M-3
**Status:** accepted

**Alternatives:** Implement FR-16 alongside clean base snapshots in M-2.

**Reasoning:** Per-session snapshots depend on the eligible runtime rootfs, confirmed restore entropy handling, session-scoped encryption, explicit retention/deletion, and a restore model that preserves INV-7. Those security properties are not specified or implemented by the base-snapshot storage slice.

**Consequences:** M-2 implements clean base snapshots only. FR-16 moves to M-3 and blocks M-3 closure until its design and tests are complete. FR-17a stays in M-2 as the restore-readiness requirement; FR-17b moves with FR-16 to M-3.

---

## ADR-27: Credentials are structured, redacting, and backend paths are constrained
**Status:** accepted

**Alternatives:** Pass a connection URI to adapters; keep raw strings in a generic credential map; let Vault read arbitrary paths; use a long-lived production Vault token without transport restrictions.

**Reasoning:** A structured, adapter-discriminated credential prevents URI parsing ambiguity and makes TLS posture explicit. A redacting secret wrapper reduces accidental disclosure through normal logging and inspection paths, but does not replace the prohibition on logging secrets. Credential references originate in trusted control-plane data, yet Vault paths still require strict validation because an incorrect path could cross a secret boundary.

**Consequences:** M-2 Postgres credentials are `{ host, port, database, username, password, sslMode }`, with `verify-full` as the default, `require` allowed, and `disable` limited to development. S3 credentials are `{ accessKeyId, secretAccessKey }`; bucket and prefix permissions remain host-side service configuration and IAM policy, not credential fields. Values are fetched per call or held only in a bounded in-memory TTL and are never durable. Vault uses `VAULT_ADDR` and `VAULT_TOKEN`, KV-v2, request timeouts, HTTPS outside development, and paths constrained below the configured mount prefix. Production must replace the token with AppRole or platform authentication using short-lived credentials and a Vault policy limited to the Caisson path.

---

## ADR-28: Build the development MinIO image from a pinned upstream source commit
**Status:** accepted

**Alternatives:** Continue relying on an unavailable Quay or Docker Hub image; download an unverified MinIO binary; postpone snapshot-store integration tests.

**Reasoning:** On 2026-09-29, Quay returned 401 for the prior pinned image, Docker Hub denied anonymous pulls for both prior and current MinIO tags, and MinIO's binary download endpoints returned HTTP 410. The official MinIO release directs container users to build from source. Caisson therefore pins the release commit, verifies the checkout's `HEAD` during the Docker build, pins the Go toolchain, and uses `go build -mod=readonly` so module content is verified against the source release's `go.sum`.

**Consequences:** `deploy/minio/image.env` is the one image reference used by Compose, Testcontainers, and CI. The detailed provenance record names the checked upstream tag and commit and documents unavailable verification paths. The development image also includes a source-built, pinned `mc` client only so the real MinIO test fixture can create a prefix-restricted IAM user and prove storage-side enforcement. This is not a complete supply-chain solution: the Go module proxy and base image remain external dependencies. M-2 tracks a later decision for an image mirror or freshness check because pinned-image disappearance has affected two registries.

---

## ADR-29: M-2 PostgreSQL queries permit SELECT only
**Status:** accepted

**Alternatives:** Add EXPLAIN support with the current parser; add a new SQL parser dependency under M-2 delivery pressure.

**Reasoning:** The current parser rejects EXPLAIN syntax. Allowing it through a prefix check would violate ADR-5. The parser is a security boundary, so M-2 must not add a parser dependency reactively for a convenience feature. M-2 therefore explicitly denies EXPLAIN and permits one parsed SELECT only. Read calls use separate read credentials with database SELECT-only grants, so the database remains a second enforcement layer if adapter validation is bypassed.

**Consequences:** EXPLAIN support is a later reviewed task. It must select a parser deliberately and prove compatibility with the SELECT bypass suite, maintenance, and coverage criteria. `readCredentials` use the same redacting secret path as write credentials and must have no INSERT, UPDATE, DELETE, or DDL grants.

---

## ADR-30: HTTP connections use validated pinned IPs and S3 uses the reviewed SDK
**Status:** accepted

**Alternatives:** Let a standard HTTP client perform a second hostname lookup; allow redirects; implement S3 signing directly; add an unreviewed HTTP dispatcher dependency.

**Reasoning:** A host allowlist alone does not prevent DNS rebinding to private or metadata addresses. The HTTP adapter resolves the allowlisted hostname once with Node DNS, rejects prohibited IPv4 and IPv6 ranges, then connects to that exact IP with the original hostname retained only for TLS SNI and the Host header. Redirects, userinfo, and guest-supplied Host or Authorization headers are rejected. The existing pinned AWS S3 SDK is added directly to the broker package so S3 signing is not reimplemented. S3 bucket and prefix restrictions are enforced both by host configuration and by the credential's storage policy.

**Consequences:** HTTP method scope and side-effect declarations are parameter-dependent: safe methods use `http.read` and mutating methods use `http.write`. Both remain computed before policy evaluation. S3 uses `s3.read`, `s3.write`, and `s3.delete`, preserving the `service.capability` convention. The broker never accepts an S3 endpoint override or creates a presigned URL.

---

## ADR-31: The broker evaluates the bootstrapped OPA WASM bundle in process
**Status:** accepted

**Alternatives:** Shell out to an `opa` binary for every request; reimplement the bootstrap policy in TypeScript; connect to a remote policy service.

**Reasoning:** The policy bundle already produced by `pnpm bootstrap:policy` is the source selected for every session. A broker request must evaluate that exact stored WASM blob without adding a shell, a network hop, or a second policy representation. The pinned `@open-policy-agent/opa-wasm` runtime loads the bundle once and evaluates it in process. A bundle load or result-shape failure is an authorization failure, so startup and request handling fail closed. Policy simulation calls this same evaluator rather than a separate implementation.

**Consequences:** `packages/policy` owns bundle loading, strict decision parsing, and evaluation. It is a reviewed dependency boundary. The control plane refuses readiness when its active bundle cannot load. Activating or reloading a bundle replaces the in-memory evaluator only after the new blob has loaded successfully.

---

## ADR-32: Broker frames are bounded UInt32BE JSON messages
**Status:** accepted

**Alternatives:** Newline-delimited JSON; an unbounded length prefix; one-mebibyte frames with response chunking; lower the configured adapter response caps.

**Reasoning:** A four-byte unsigned big-endian length prefix is deterministic, permits UTF-8 JSON payloads containing newlines, and bounds allocation before payload parsing. The maximum payload is 16 MiB. Existing S3 and HTTP raw-byte response caps can expand under base64 encoding, so a one-mebibyte transport frame would reject permitted adapter results. Chunking adds state, ordering, partial-result, and audit complexity for a response that is already bounded. Reducing adapter caps to fit a transport limit would make the transport impose an arbitrary service restriction. Instead, startup computes the worst encoded frame from active adapter caps and refuses to start if it exceeds the protocol bound.

**Consequences:** One malformed, oversize, timed-out, or truncated frame closes its socket and is never reused. Complete frames with invalid JSON or schema receive one diagnostic error frame when writable before close. Stage D tests the protocol over a host-bound loopback Unix socket. M-1's `VsockInfrastructureProbe` remains an infrastructure-only readiness probe and is not part of this request path. Live Firecracker guest-to-broker vsock remains Stage E work.

---

## ADR-33: Broker audit records use active OpenTelemetry span context
**Status:** accepted

**Alternatives:** Leave audit trace fields empty; generate unrelated identifiers in the audit writer; rewrite every existing instrumentation call site.

**Reasoning:** FR-58 requires audit rows to join with the trace that represents the action. The existing instrumentation uses the OpenTelemetry API but has no SDK provider, so it cannot produce exportable span contexts. An SDK-backed tracer provider and optional OTLP exporter make current spans real without changing their call sites. Where export is not configured, the SDK still creates local span contexts; the production exporter configuration remains explicit.

**Consequences:** The broker copies the active `traceId` and `spanId` into all action records. Span attributes remain hashes, sizes, types, and identifiers only. Trace export configuration never accepts or emits credentials through span attributes.

---

## ADR-34: Service metadata is bootstrapped and rejects secret-shaped values
**Status:** accepted

**Alternatives:** Store service configuration only in process memory; add a multi-tenant administration API in M-2; permit arbitrary metadata values because the secret backend is the primary control.

**Reasoning:** The broker needs a durable trusted mapping from a service name to its host-side configuration and a credential reference. `pnpm bootstrap:services` follows the existing source-controlled policy bootstrap pattern and gives a self-hosted operator an idempotent path without introducing a tenant-facing administration surface. Database checks and CI scanning reject known secret-shaped values from metadata. This is defence in depth, not a substitute for the secret backend boundary. The detector deliberately accepts false positives because a rejected configuration is safer than durable credential material.

**Consequences:** The bootstrap command validates its entire declaration before a single transaction upserts services by name and references by `(service_id, role)`. It rejects normalized key names `password`, `secret`, `token`, `apikey`, `privatekey`, `credential`, and `accesskey`, and values matching AWS access keys, PEM private-key headers, JWT shapes, or long `sk-` values. No entropy heuristic is used. M-2 has no multi-tenant service-administration API; adding one requires authentication and authorization design.

---

## ADR-35: Policy simulation uses a non-session system audit record in M-2
**Status:** accepted

**Alternatives:** Insert simulation records into `actions` with a fabricated session id; omit audit because the endpoint is administrative; introduce authentication in M-2.

**Reasoning:** Policy simulation is development and administrative tooling, not a guest action. M-2 has no trusted caller identity and therefore cannot truthfully attach it to a session audit sequence. A separate direct Postgres record captures an input hash, outcome, duration, trace and span identifiers, and nullable connection metadata. The input is checked for secret-shaped values before anything derived from it is stored. The session outbox is intentionally not generalized because its order and recovery guarantees are defined per session.

**Consequences:** `POST /v1/policy/simulate` fails closed when its system audit write fails. It records no placeholder identity. M-4 authenticated-caller work must revisit whether the endpoint requires authentication and whether these audit records should carry verified identity.

---

## ADR-36: M-2 uses a minimal immutable guest runtime and confirmed entropy refresh
**Status:** accepted

**Alternatives:** Wait for M-3's seven-tool agent runtime before proving live vsock and restore readiness; reuse the unrestricted M-1 development probe; rely on VMGenID or a best-effort kernel reseed.

**Reasoning:** M-2 requires a real Firecracker broker path, an eligible base rootfs, and FR-17a before warm restores can serve sessions. The M-1 probe is deliberately unrestricted and structurally ineligible. Pulling the full agent runtime forward would expand M-2 with seven tools and their M-3 security work. A narrow static `/init` can instead implement only bounded framed `broker.call` messages and a dedicated entropy-control message. After restore, the host sends 256 bits of fresh entropy over the trusted vsock channel; the guest mixes it with `RNDADDENTROPY` or an equivalent kernel operation and acknowledges success. The host cannot mark the guest ready without that acknowledgement. The real proof is two restored guests from one snapshot producing distinct random output.

**Consequences:** The eligible rootfs contains only the static runtime and minimal init/device setup. An inventory test enforces an explicit file allowlist and rejects credentials, tokens, fixtures, and build artifacts. The runtime accepts no token or credential material, and the snapshot harness inspects every message delivered to the guest for secret-shaped values before capture. The full seven-tool runtime remains M-3. FR-17a and this minimal runtime move to M-2; FR-16 and FR-17b remain M-3.

---

## ADR-37: M-2 guest runtime receives a one-shot broker call through boot configuration
**Status:** accepted

**Alternatives:** Add a guest-local listener for a future agent runtime; compile a fixed test request into the rootfs; defer live vsock verification.

**Reasoning:** M-2 must prove guest-initiated broker transport without inventing the M-3 agent-runtime interface. The host supplies one validated `broker.call` request as a base64 boot parameter when starting a verification guest. It is immutable from the guest's perspective and permits test runs to vary inputs without changing the rootfs.

**Consequences:** The rootfs contains no request fixture. The control plane validates the decoded request with `BrokerCallRequestSchema` before constructing Firecracker boot arguments. The M-2 runtime executes exactly one request, validates its bounded frame transport, then remains idle as PID 1 so a clean base snapshot stays runnable. This is a verification interface only and must not be presented as the M-3 agent interface.

---

## ADR-38: Test diagnostics are a separate ineligible runtime artifact
**Status:** accepted

**Alternatives:** Add marker and random-output commands to the eligible M-2 runtime; keep using the unrestricted M-1 probe for KVM verification; infer restored entropy freshness from an acknowledgement alone.

**Reasoning:** INV-7 and the entropy-distinctness test need observable marker and random values, but those commands are not a production capability and do not belong in the minimal guest surface. The diagnostic rootfs is built from the same runtime source with a compile-time `diagnostic` tag. It adds only a host-initiated vsock diagnostic port after the initial entropy acknowledgement and broker round trip. The production artifact has no diagnostic listener or handlers. A fresh host entropy message is required both for cold boot and every restore; the acknowledgement gates readiness, while distinct kernel-random output across two restores proves the property.

**Consequences:** `caisson-runtime-diagnostic-rootfs.ext4` and `m1-dev-probe-rootfs.ext4` are permanently rejected for production and base-snapshot promotion. The eligible `caisson-runtime-rootfs.ext4` contains only `/init`, `/dev`, and `/proc` plus unavoidable ext4 metadata, checked by the rootfs build. Its explicit `/dev` allowlist is `null`, `random`, and `urandom`; these static nodes let the read-only rootfs mix host-provided entropy without mounting `devtmpfs`. KVM-only tests use the diagnostic artifact but exercise the same entropy, framing, and vsock code as the eligible runtime. Before snapshot capture, the verification harness asserts that every recorded guest-visible broker message is free of secret-shaped content.

---

## ADR-39: M-2 runtime benchmarks are a distinct measurement series
**Status:** accepted

**Alternatives:** Compare M-2 runtime timings directly with M-1 probe or pre-runtime prepare/start timings; omit the timing-model labels.

**Reasoning:** The M-2 measurements use the immutable runtime rootfs, entropy acknowledgement, framed broker-call round trip, and verified S3 cache-hit restore. Those are different workloads and lifecycle boundaries from the M-1 probe and the earlier prepare/start measurements. Comparing them directly would imply a performance conclusion the measurements do not support.

**Consequences:** `bench-boot.mjs` records an explicit `timingModel` and writes the non-comparability note alongside the WSL2 resource-allocation note. The 2026-09-30 KVM measurement records 200 samples: cold p50 1684 ms and p99 1949 ms; S3 cache-hit warm restore p50 177 ms and p99 226 ms. These measurements verify the M-2 runtime path but do not accept or tag M-2; the remaining gate requirements stay listed in the roadmap.

---

## ADR-40: INV-2 verification moves to M-4 with the egress monitor
**Status:** accepted

**Alternatives:** Claim that the no-network-interface Firecracker configuration proves every INV-2 case in M-2; add an unreviewed network monitor only to close the M-2 gate.

**Reasoning:** INV-2 requires more than a failed connection. It requires the host-side egress monitor to record each blocked attempt with destination, protocol, and timestamp within one second. That monitor is explicitly part of M-4's interception and blocked-egress work. M-2 has no implementation that can truthfully verify the complete invariant.

**Consequences:** M-2's gate excludes INV-2. M-4 owns both the monitor and the full raw-TCP, DNS, HTTP-IP-literal, IPv6, ICMP, host-interface, and metadata-endpoint test matrix. This is a scope correction, not a claim that guest egress is permitted in M-2.

---

## ADR-41: FR-7 capacity proof moves to M-4
**Status:** accepted

**Alternatives:** Retain a 50-concurrent-session proof in M-2; silently drop the proof.

**Reasoning:** M-2 establishes the single-session lifecycle, broker path, adapters, and base snapshot mechanics. A meaningful 50-session proof also needs the M-4 operational egress and approval components that affect live-session resource use. It is deferred for scope and time rather than represented by an unmeasured claim.

**Consequences:** M-4 must run and publish the FR-7 50-concurrent-session proof. M-2 makes no concurrency-performance claim beyond the measured driver and broker benchmarks.

---

## ADR-42: Diagnostic preflight pauses the one-shot call only for INV-1 inspection
**Status:** accepted

**Alternatives:** Inspect only after the broker call; add diagnostic commands to the eligible runtime; make the one-shot request wait on a guest-local M-3 interface.

**Reasoning:** INV-1 requires inspection both before and after a brokered action. The diagnostic rootfs already exists solely for KVM verification, but its normal listener starts after the one-shot call, which cannot prove the pre-call state. A diagnostic-only boot argument pauses that call after the entropy acknowledgement until the trusted host diagnostic client sends one bounded `continue_broker` command. The eligible runtime cannot enable this path because it has no diagnostic build.

**Consequences:** The INV-1 test uses `scan_canary` before and after a real Postgres broker call. The host supplies only a SHA-256 digest of the distinct AWS-access-key-shaped test canary in boot configuration, so the scanner can compare candidate values without receiving the canary itself. It returns locations only, never values, and inspects environment variables, every process command line, and the fixed minimal-rootfs footprint plus its diagnostic tmpfs mount. This is test scaffolding, not an agent capability or a production boot option.

---

## ADR-43: Audit inserts use ClickHouse acknowledged async batching
**Status:** accepted

**Alternatives:** One synchronous HTTP insert per audit record; enqueue without waiting for ClickHouse; change the audit store or relax NFR-2/NFR-4.

**Reasoning:** A new action must not execute before `action.started` is accepted by ClickHouse, but serial one-row inserts make the audit store dominate broker overhead on the local single-node deployment. ClickHouse's `async_insert=1` with `wait_for_async_insert=1` batches host-side inserts and responds only after the buffered insert has flushed. Its one-millisecond busy timeout bounds batching delay while retaining the same acknowledgement requirement as a normal insert.

**Consequences:** The audit writer uses these settings only for action inserts. It serializes the pending events for one locked session into one sequence-sorted JSONEachRow request, so an earlier terminal record and the next `action.started` do not pay two HTTP round trips. A successful pre-execution response remains the fail-closed boundary. A failed or ambiguous batch leaves every attempted row pending, increments each attempt count, and retries under the existing per-session lock with `(session_id, seq)` lookup. The M-2 benchmark must measure the configured path; this ADR does not claim that NFR-2 or NFR-4 is met until a real result is recorded.

---

## ADR-44: M-3 local tools require host authorization and audit before guest execution
**Status:** accepted

**Alternatives:** Execute workspace and subprocess tools in the guest without host involvement; move the guest workspace to a host-visible mount and execute every tool on the host; defer the runtime until M-4 approval authentication exists.

**Reasoning:** `/workspace` is guest tmpfs and must remain private to the session, so host-side filesystem execution would add an unnecessary shared writable surface. Local tools therefore execute in the guest only after a host-side framed authorization request resolves the transport-bound session, evaluates policy, and synchronously persists an `action.started` record. A terminal record carries only a bounded, secret-scrubbed preview. `process.exec` uses one scope because the normative fixed binary allowlist, enforced independently by the host and guest, is the M-3 capability boundary. `user.ask` cannot create an approval channel until M-4 defines approver authentication.

**Consequences:** The M-3 protocol adds `fs.read`, `fs.write`, `fs.edit`, `fs.search`, `proc.exec`, and `user.ask` beside `broker.call`. Their scopes are `workspace.read`, `workspace.write`, `process.exec`, and `user.ask`. Missing or invalid local-result preview configuration prevents startup. Preview values that are secret-shaped are never persisted. `user.ask` validates and audits its request, then returns the structured `APPROVAL_UNAVAILABLE` denial until M-4 ships an authenticated websocket hub. Per-binary process scopes are deliberately deferred to a later scope-design task.

---

## ADR-45: M-3 agent runtime uses a verified, locked Alpine rootfs
**Status:** accepted

**Alternatives:** Keep the M-2 static-only rootfs and provide command shims; use a moving distro image or package index; build every tool from source immediately.

**Reasoning:** M-3 needs real `rg`, `jq`, restricted `git`, `node`, and `python3` binaries, while preserving an inspectable, reproducible rootfs. The build pins Alpine 3.21.6 x86_64 and the exact SHA-256 of `alpine-minirootfs-3.21.6-x86_64.tar.gz`. It imports `ncopa.asc` only after comparing its primary fingerprint, `0482D84022F52DF1C4E7CD43293ACD0907D9495A`, to Alpine's independently hosted official downloads page. It then verifies the detached release signature and the pinned SHA-256 in the checked-in build script. The release announcement for 3.21.6 was published on 2026-01-27; the release key comes from the separate `alpinelinux.org` key endpoint. Every additional package archive is locked by filename, version, and SHA-256 before extraction. The lock was generated from currently reachable v3.21 repositories; rebuilds do not resolve dependencies from a live index.

**Consequences:** The runtime uses musl. This is acceptable only while it has no native Node addons, no Python C-extension packages, and no guest package installation. Any change to those conditions requires a rootfs and toolchain design review. `node` and `python3` are real Alpine runtimes; their lack of general network access comes from the guest's absent network interface, not language-level restrictions. The inventory test lists the complete files and shared libraries supplied by the locked base and package closure. If Alpine's release artifacts or locked packages cease to be available, the fallback is a reviewed per-tool source build, following the same supply-chain posture as the MinIO fallback in ADR-28.
