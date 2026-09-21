# 02 - Software Requirements Specification

Requirements are normative. "Must" is a gate. "Should" is a strong default that needs a recorded ADR to deviate from.

## 1. Scope and definitions

See `14-GLOSSARY.md`. Key terms used below: session, sandbox, broker, adapter, scope, obligation, approval, invariant.

## 2. Actors

| Actor | Description |
|---|---|
| Operator | Creates sessions via the control plane API |
| Agent | The LLM-driven process inside the sandbox |
| Approver | Human who resolves approval requests |
| Auditor | Reads the audit store, never writes |
| Service | External system reached through an adapter |

## 3. Functional requirements

### 3.1 Session lifecycle

- **FR-1** The system must expose `POST /v1/sessions` accepting an agent image reference, a scope set, an approval mode, a TTL, an idle timeout, and free-form metadata.
- **FR-2** A session must follow the normal lifecycle `pending -> booting -> ready -> active -> suspended -> terminating -> terminated`. `terminated` and `failed` are terminal states. `terminated` records a clean end, including explicit `DELETE`, TTL expiry, or idle-timeout termination. `failed` records an unrecoverable driver boot failure, snapshot restore failure, fault-injection failure with no recovery path, or invariant-violation abort. Entry into `failed` is permitted from `pending`, `booting`, `ready`, `active`, or `suspended`, but not from `terminating`. An error during `terminating` must still resolve to `terminated`, with `termination_reason` recording the problem. Neither terminal state may transition again. All other illegal transitions must be rejected and logged.
- **FR-3** The control plane must mint one session token at session creation. Only its argon2id hash may be persisted in `session_tokens.token_hash`; the plaintext token must never be returned to the API caller or made readable inside the sandbox. The guest never presents a token, and the guest-to-broker protocol must contain no token field. On every call, the broker must resolve the host-established `transport_bindings` record for the vsock connection, load its token row, and check `expires_at` and `revoked_at`. The binding is fixed by the host at boot and cannot be influenced by guest content. V1 does not rotate a token mid-session. Termination or manual revocation must set `revoked_at`, and token lifetime must not exceed session TTL.
- **FR-4** A session must terminate automatically at TTL expiry and must suspend after the idle timeout with no broker call and no exec.
- **FR-5** The system must expose `GET /v1/sessions/:id` returning state, timing, scope set, action counts by decision, and pending approval count.
- **FR-6** `DELETE /v1/sessions/:id` must terminate a session within five seconds and must destroy sandbox memory and disk.
- **FR-7** The system must support at least fifty concurrent sessions on a single host pool without boot serialisation.

### 3.2 Isolation

- **FR-8** Isolation must sit behind an `IsolationDriver` interface with `create`, `exec`, `snapshot`, `restore`, `destroy`, and `capabilities`.
- **FR-9** A Firecracker driver must be provided and must be the default when `/dev/kvm` is present and writable.
- **FR-10** A container driver must be provided for development and CI. It must emit a startup warning, must report `hardwareIsolation: false` from `capabilities()`, and must never be selected silently when the Firecracker driver is available.
- **FR-11** The system must refuse to start in production mode (`CAISSON_ENV=production`) with a driver reporting `hardwareIsolation: false`.
- **FR-12** Sandbox filesystem and memory must be destroyed on termination. No artefact from one session may be observable from another.

### 3.3 Snapshots

- **FR-13** A base snapshot containing kernel, rootfs, runtime, allowlisted binaries, and agent runtime code must be built on a schedule with a default cadence of thirty minutes.
- **FR-14** Snapshot promotion must be atomic. Sessions already booting or running must continue against the snapshot they started with.
- **FR-15** Snapshots must be stored in an S3-compatible store, compressed, and cached on local disk with an LRU policy.
- **FR-16** Mid-session snapshots must be taken every five minutes while a session is active.
- **FR-17** On resume from a mid-session snapshot the agent must be informed truthfully of the suspension point. The system must not silently replay or fabricate continuity.

### 3.4 Broker

- **FR-18** The broker must run on the host, outside the sandbox trust boundary. See ADR-2.
- **FR-19** The broker must accept exactly one request shape: `{ service, method, params, idempotencyKey, intent }`, where `intent` is a required, non-empty, agent-authored description of why the call is being made. The schema must not impose a length cap. A missing or empty `intent` must fail with `PARAMS_INVALID` before policy evaluation. Audit storage may truncate `agent_intent` according to its storage limit.
- **FR-20** The broker must resolve session identity from the transport binding, never from request content.
- **FR-21** The broker must validate `params` against the adapter method's schema and must reject unknown fields.
- **FR-22** The broker must evaluate policy before any credential is fetched.
- **FR-23** Before fetching a credential or executing an operation, the broker or control plane must synchronously persist a pre-execution audit record. An executable operation writes `action.started`. A policy denial writes one terminal deny record before returning to the guest. An approval request writes `require_approval` when it is created and writes a second resolution record when it is approved, denied, or timed out. If any required pre-execution write fails, the operation must abort before a credential is fetched or an operation is executed.
- **FR-24** The broker must apply obligations returned by policy, including role downgrade and redaction.
- **FR-25** The broker must enforce a per-call timeout and must pool connections per service and credential.
- **FR-26** After execution, the broker must durably accept an `action.completed` or `action.failed` record containing duration, result size, result hash, and redaction count before returning the result. A direct ClickHouse write is the fast path. If it fails, the record must be appended to a durable completion buffer, implemented as a persistent Redis stream or an on-disk broker WAL, and retried until ClickHouse accepts it. A post-execution audit failure must never be represented as though the external effect did not happen, and the completion record must never be dropped.
- **FR-27** Idempotency keys must suppress duplicate side-effecting execution within a session for a configurable window.

### 3.5 Adapters

- **FR-28** Adapters must declare, per method: a params schema, a required scope, whether the method is side-effecting, and an execute function.
- **FR-29** Five adapters must ship in v1: postgres, http, github, s3, slack.
- **FR-30** The postgres adapter must separate read and write methods with distinct scopes.
- **FR-31** The http adapter must only permit destinations matching a configured host and path allowlist.
- **FR-32** Adding an adapter must require no change to the broker, the policy engine, or the guest.

### 3.6 Policy

- **FR-33** Policy must be expressed in Rego, versioned, stored in Postgres, and evaluated in-process via wasm.
- **FR-34** Policy input must contain session identity, scopes, roles, validity window, the action, and contextual counters.
- **FR-35** Policy output must be one of `allow`, `deny`, `require_approval`, with a human-readable reason and a list of obligations.
- **FR-36** Policy bundles must hot-reload without restarting the broker.
- **FR-37** SQL restrictions must be evaluated against a parsed statement type, never by substring matching. See ADR-5.
- **FR-38** Policy must support time windows, scope requirements, per-session rate limits, and escalation for side-effecting methods.
- **FR-39** Every shipped policy must have Rego unit tests run in CI.
- **FR-39a** The system must expose `POST /v1/policy/simulate`, accepting a complete policy input and returning the decision with matched rule names without executing the action. Every simulation must write an audit record tagged `action_type='policy_simulate'`. Simulation records must be excluded from the real per-session replay view.

### 3.7 Agent runtime

- **FR-40** The guest runtime must expose exactly seven tools: `read`, `write`, `edit`, `exec`, `search`, `broker`, `ask_user`.
- **FR-41** `exec` must accept an argv array, must never invoke a shell, and must reject any binary not on the allowlist.
- **FR-42** `read`, `write`, `edit`, and `search` must be confined to the session workspace with traversal rejected after path resolution.
- **FR-43** The runtime must have no capability to open a network connection other than via `broker`.
- **FR-44** Skills must be markdown files loaded on demand, and the identity of the loaded skill must be recorded with each action.
- **FR-45** Policy denials must reach the agent as structured, machine-readable errors that permit the agent to adapt.

### 3.8 Approvals

- **FR-46** Three approval modes must be supported per session: `auto`, `rule`, `always`.
- **FR-47** Approval requests must carry a server-generated nonce that is never exposed to the guest.
- **FR-48** Approval requests must be delivered over websocket to subscribed approvers and persisted so that a reconnecting approver sees pending items.
- **FR-49** An approval request must render: session id, requester, stated purpose, service, method, a human-readable parameter summary, the policy reason, and the agent's stated intent.
- **FR-50** Approval must time out at a configurable default of three hundred seconds and must fail closed with error code `APPROVAL_TIMEOUT`.
- **FR-51** Decision, decider identity, latency, and optional comment must be persisted and audited.

### 3.9 Redaction

- **FR-52** The `redact_pii` obligation must run responses through detectors for email, phone, national identifier formats, and payment card numbers with a Luhn check.
- **FR-53** Redaction must use stable per-session tokens so repeated values remain correlatable without disclosure.
- **FR-54** Redaction counts must be recorded per action.

### 3.10 Audit

- **FR-55** Every guest operation must produce audit records: `read`, `write`, `edit`, `exec`, `search`, `broker`, and `ask_user`. Denials, approval events, lifecycle transitions, policy simulations, and host-observed blocked egress attempts must also be audited.
- **FR-56** Audit records must store a hash of full parameters and a redacted truncated preview, not raw parameters.
- **FR-57** The system must provide queries for: all actions in a session; all actions against a service in a time range; all denials in a time range.
- **FR-58** Audit records must carry trace and span identifiers correlating to the OpenTelemetry trace.

### 3.11 Egress interception

- **FR-59** Destinations that cannot be brokered (model provider APIs, git remotes) must be reached through a transparent host-side interceptor that injects credentials on egress.
- **FR-60** Guest-visible environment variables for intercepted services must contain the literal string `credential-brokered`.
- **FR-61** The interceptor allowlist must be configuration, not code.
- **FR-62** The host must observe blocked direct egress with an nftables or iptables log rule placed immediately before the final DROP on the guest network path. The rule must cover the Firecracker tap interface and the container driver's network namespace. A host-side collector must convert each logged drop into a `network_denied` audit record containing only destination, protocol, and timestamp within one second of the attempt.

## 4. Non-functional requirements

- **NFR-1** Warm session start must be under one second at p50 on the reference machine. Cold start must be measured and published.
- **NFR-2** Broker overhead excluding downstream call latency must be under fifty milliseconds at p99.
- **NFR-3** Policy evaluation must be under five milliseconds at p99.
- **NFR-4** Each direct audit write on the critical path must be under ten milliseconds at p99. A failed pre-execution write must fail the operation. A failed direct post-execution write must enter the durable completion buffer rather than be dropped.
- **NFR-5** The system must run end to end on a developer laptop with no hardware virtualisation via `docker compose up`.
- **NFR-6** All boundaries must validate with schemas. TypeScript strict mode. No `any` outside vendored type declarations.
- **NFR-7** All published performance numbers must be reproducible from a script in `benchmarks/` and must state machine specifications.
- **NFR-8** No secret value may be written to a log, a span attribute, an error message, or an audit record.
- **NFR-9** Invariant tests must run on every pull request and must not be skippable.
- **NFR-10** The system must degrade safely: an unavailable policy engine or secret backend must fail closed. An unavailable audit store must fail closed before execution and fail durable after execution as specified by FR-23, FR-26, and ADR-10.

## 5. Constraints

- Linux host. KVM required for the production driver.
- Node 22 or later. TypeScript throughout. See ADR-3.
- Single control plane process in v1.

## 6. Assumptions

- The operator is trusted. The agent is not.
- The model provider is semi-trusted: assumed not malicious, assumed compromisable by injected content.
- External services enforce their own authorisation as a second layer. Caisson does not rely on that.
