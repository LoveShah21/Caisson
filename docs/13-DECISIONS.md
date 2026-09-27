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

## ADR-19: The broker owns host-side transport listeners
**Status:** accepted

**Alternatives:** Let each isolation driver create and accept its own host-side listener; release the listener before sandbox destruction.

**Reasoning:** B1 terminates at the host-side broker. A driver-owned listener would create a second hidden host boundary and leave the broker unable to own the connection lifecycle. `transportHost.reserve()` creates and owns the Firecracker vsock-side or container Unix-socket listener. Drivers only attach their sandbox-specific side to that endpoint. Destroying a listener while its sandbox remains live risks a connection being misclassified or dropped during teardown.

**Consequences:** `prepare(spec, transportHost)` invokes the broker-owned reservation before guest execution is possible. `destroy(handle)` always completes before `transportHost.release(descriptor)` is called. Driver code must never call `listen()` or `accept()` for guest broker transport.
