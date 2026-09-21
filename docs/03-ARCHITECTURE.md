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

**B3: control plane to external services.** Credentials cross here and nowhere else.

The single most important architectural consequence: **the broker is on the host side of B1.** If it were in the guest, a compromised agent could read its memory, patch it, or attach a debugger, and every guarantee in `06-THREAT-MODEL.md` would be unenforceable. See ADR-2.

## 3. Components

### Control plane (`apps/control-plane`)
Fastify. Owns session records, the websocket hub for approvals and `ask_user`, the policy bundle loader, and the snapshot scheduler. Stateless apart from Postgres, Redis, and ClickHouse.

### Broker (`apps/broker`)
The choke point. One process per sandbox host. Holds a vsock listener, an adapter registry, a policy evaluator, a secret client, a redaction pipeline, and an audit writer. Deliberately small and deliberately boring; this is the code a security reviewer will read line by line.

### Isolation (`packages/isolation`)
`IsolationDriver` plus `FirecrackerDriver` and `ContainerDriver`. Firecracker is driven directly over its REST API on a unix socket; no third-party SDK is needed for the small surface used here. See ADR-4.

### Agent runtime (`apps/agent-runtime`)
Runs in the guest. Seven tools, a skill loader, a structured error handler, and a vsock client. It has no HTTP client and no shell.

### Interceptor
Transparent proxy on the host for destinations that cannot be brokered. mitmproxy in v1, eBPF as a stretch replacement. See ADR-6.

### Approval UI (`apps/approval-ui`)
Next.js. Subscribes to the websocket hub, renders pending requests in human-readable form, posts decisions.

## 4. Request path for a brokered action

1. Agent calls the `broker` tool.
2. Runtime writes a framed request to vsock.
3. Broker resolves the session from the connection binding. Not from the payload.
4. Broker checks token validity and loads the scope set from Postgres.
5. Broker resolves the adapter and method, validates params against the schema.
6. Broker builds the policy input and evaluates the wasm bundle.
7. On `require_approval`, broker creates an approval record and awaits resolution with timeout.
8. Broker writes `action.started` to ClickHouse. Failure here aborts.
9. Broker fetches the credential, applying any role-downgrade obligation.
10. Adapter executes with pooling and timeout.
11. Response passes through redaction if obliged.
12. Broker writes `action.completed`.
13. Result is framed back over vsock.

Steps 3 through 6 happen before any secret is touched. That ordering is a requirement, not an implementation detail.

## 5. Failure behaviour

| Failure | Behaviour |
|---|---|
| Policy engine unavailable | Fail closed, error `POLICY_UNAVAILABLE` |
| Secret backend unavailable | Fail closed, error `SECRET_UNAVAILABLE` |
| Audit store unavailable | Fail closed, error `AUDIT_UNAVAILABLE` |
| Downstream service timeout | Fail with `SERVICE_TIMEOUT`, logged, retryable by the agent |
| Approval timeout | Fail with `APPROVAL_TIMEOUT` |
| Sandbox crash | Resume from last mid-session snapshot, agent told the truth about the gap |
| Broker crash | All sessions on that host terminate. Sessions are disposable by design. |

Every one of these is a fail-closed decision. There is no configuration flag that makes any of them fail open, and there should never be one.

## 6. Deployment

Single control plane, one or more sandbox hosts, Postgres, Redis, ClickHouse, MinIO or S3, an OTel collector, Grafana. `deploy/docker-compose.yml` brings up dependencies plus the control plane with the container driver for local work. `deploy/terraform/` provisions a KVM-capable host for the real thing.
