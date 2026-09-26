# 03 - Architecture

## 1. Shape

```
        operator
           |
           v
+-------------------------------------------------+
|                 Control Plane                    |
|  session-manager  policy-loader  audit-writer    |
|  approval-hub(WS) snapshot-scheduler             |
+-----+----------------------+--------------------+
      |                      |
   Postgres              ClickHouse          Approval UI (WS)
      |
      v
+-------------------------------------------------+
|                  Sandbox host                    |
|                                                  |
|   +-----------------+        +---------------+   |
|   |  GUEST (microVM)|        |    Broker     |   |
|   |                 | vsock  |   (host-side) |   |
|   |  agent runtime  |------->|               |---+---> external services
|   |  7 tools        |        |  identity     |   |
|   |  workspace      |        |  policy       |   |
|   |  no routes out  |        |  secrets      |   |
|   +-----------------+        |  redaction    |   |
|            |                 |  audit        |   |
|            | allowlisted     +---------------+   |
|            | hosts only              ^           |
|            v                         |           |
|      +-------------+                 |           |
|      | interceptor |-----------------+           |
|      | (mitm/eBPF) |  injects keys on egress     |
|      +-------------+                             |
+-------------------------------------------------+
```

## 2. Trust boundaries

There are exactly three, and they are the only structure that matters.

**B1: guest to host.** Everything inside the microVM is untrusted. The agent, its prompt, its context, any data a service returned to it. Crossing B1 means crossing a vsock into the broker, or crossing a network namespace into the interceptor. Nothing else crosses.

**B2: host to control plane.** The broker is trusted to execute correctly but is not trusted to author policy or mint identity. It reads policy bundles and session records; it does not write them.

**B3: broker to external services.** Credential values cross here and nowhere else. The control plane handles only `credential_refs`, which are backend paths and never secret values.

The single most important architectural consequence: **the broker is on the host side of B1.** If it were in the guest, a compromised agent could read its memory, patch it, or attach a debugger, and every guarantee in `06-THREAT-MODEL.md` would be unenforceable. See ADR-2.

## 3. Components

### Control plane (`apps/control-plane`)
Fastify. Owns session records, the websocket hub for approvals and `ask_user`, the policy bundle loader, and the snapshot scheduler. Stateless apart from Postgres, Redis, and ClickHouse. It handles credential references but never credential values.

### Broker (`apps/broker`)
The choke point. One process per sandbox host. Holds a vsock listener, an adapter registry, a policy evaluator, a secret client, a redaction pipeline, an audit writer, and a durable completion buffer. A direct ClickHouse write is the fast path. A persistent Redis stream or on-disk WAL retains post-execution records when ClickHouse is unavailable. Deliberately small and deliberately boring; this is the code a security reviewer will read line by line.

### Isolation (`packages/isolation`)
`IsolationDriver` plus `FirecrackerDriver` and `ContainerDriver`. Firecracker is driven directly over its REST API on a unix socket; no third-party SDK is needed for the small surface used here. Its stdin is detached from the controlling terminal and stdout and stderr are written to a per-sandbox host log file. See ADR-4.

### Agent runtime (`apps/agent-runtime`)
Runs in the guest. Seven tools, a skill loader, a structured error handler, and a vsock client. All seven tool operations cross vsock and are audited outside the guest. It has no HTTP client and no shell.

### Interceptor
Transparent proxy on the host for destinations that cannot be brokered. mitmproxy in v1, eBPF as a stretch replacement. See ADR-6.

### Egress monitor
Host-side collector for direct network attempts that never enter the broker. An nftables or iptables LOG rule sits immediately before the final DROP on the Firecracker tap interface or container network namespace. The collector maps that host-owned interface or namespace to its session, then converts each drop into a `network_denied` audit record containing destination, protocol, and timestamp within one second.

### Approval UI (`apps/approval-ui`)
Next.js. Subscribes to the websocket hub, renders pending requests in human-readable form, posts decisions.

## 4. Request path for a brokered action

1. Agent calls the `broker` tool.
2. Runtime writes a framed request to vsock.
3. Broker resolves the session from the connection binding. Not from the payload.
4. Broker checks token validity and loads the scope set from Postgres.
5. Broker resolves the adapter and method, validates params against the schema.
6. Broker builds the policy input and evaluates the wasm bundle.
7. On `deny`, broker writes one terminal deny record before returning. Failure here aborts the return and no credential is touched.
8. On `require_approval`, broker persists the approval and writes a `require_approval` audit record before waiting. A denial or timeout writes a terminal resolution record and returns. An approved decision is persisted before the action continues, and the eventual execution outcome records the resolution.
9. For an executable action, broker writes `action.started` to ClickHouse. Failure here aborts before a credential is touched.
10. Broker fetches the credential, applying any role-downgrade obligation.
11. Adapter executes with pooling and timeout.
12. Response passes through redaction if obliged.
13. Broker writes `action.completed` or `action.failed` directly to ClickHouse. If the direct write fails, it appends the record to the durable completion buffer for retry.
14. The result is framed back over vsock only after the completion record is accepted by ClickHouse or the durable buffer.
15. A reconciliation job flags every `action.started` without a matching terminal record past the configured threshold as orphaned and retries buffered records until the pair is complete.

Steps 3 through 9 happen before any secret is touched. That ordering is a requirement, not an implementation detail. Pre-execution audit is fail-closed. Post-execution audit is fail-durable because an external side effect cannot be undone by refusing to return its result.

## 5. Failure behaviour

| Failure | Behaviour |
|---|---|
| Policy engine unavailable | Fail closed, error `POLICY_UNAVAILABLE` |
| Secret backend unavailable | Fail closed, error `SECRET_UNAVAILABLE` |
| Audit store unavailable before execution | Fail closed, error `AUDIT_UNAVAILABLE` |
| Direct completion write unavailable after execution | Append to the durable completion buffer and retry; never discard the record or misreport the external effect |
| Downstream service timeout | Fail with `SERVICE_TIMEOUT`, logged, retryable by the agent |
| Approval timeout | Fail with `APPROVAL_TIMEOUT` |
| Sandbox crash | Resume from last mid-session snapshot, agent told the truth about the gap |
| Broker crash | All sessions on that host terminate. Durable buffered completions are reconciled on restart; unmatched starts are flagged as orphaned. |

Every one of these is a fail-closed decision. There is no configuration flag that makes any of them fail open, and there should never be one.

## 6. Deployment

Single control plane, one or more sandbox hosts, Postgres, Redis, ClickHouse, MinIO or S3, an OTel collector, Grafana. `deploy/docker-compose.yml` brings up dependencies plus the control plane with the container driver for local work. `deploy/terraform/` provisions a KVM-capable host for the real thing.
