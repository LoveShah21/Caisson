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

## Template for new entries

```
## ADR-n: <decision in one line>
**Status:** proposed | accepted | superseded by ADR-m
**Alternatives:** <what you did not do>
**Reasoning:** <why>
**Consequences:** <what this costs, including the bad parts>
```
