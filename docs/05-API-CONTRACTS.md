# 05 - API contracts

Three surfaces: the operator REST API, the approval websocket, and the guest-to-broker protocol. All payloads are zod schemas in `packages/protocol` and are the single source of truth; this document describes them, the code defines them.

## 1. Conventions

- JSON, `application/json`, UTC ISO-8601 timestamps.
- Errors are always this shape:

```jsonc
{ "error": { "code": "POLICY_DENIED", "message": "human readable", "details": {}, "traceId": "..." } }
```

- Error codes are a closed enum in `packages/protocol/errors.ts`. Adding one is a deliberate act.
- Idempotency via `Idempotency-Key` header on all POSTs.

### Error code enum (v1)

`INVALID_REQUEST`, `SESSION_NOT_FOUND`, `SESSION_NOT_READY`, `SESSION_EXPIRED`, `SCOPE_DENIED`, `POLICY_DENIED`, `POLICY_UNAVAILABLE`, `APPROVAL_REQUIRED`, `APPROVAL_DENIED`, `APPROVAL_TIMEOUT`, `APPROVAL_UNAVAILABLE`, `SECRET_UNAVAILABLE`, `AUDIT_UNAVAILABLE`, `ADAPTER_NOT_FOUND`, `METHOD_NOT_FOUND`, `PARAMS_INVALID`, `SERVICE_TIMEOUT`, `SERVICE_ERROR`, `RATE_LIMITED`, `SANDBOX_FAILED`, `BINARY_NOT_ALLOWED`, `PATH_DENIED`, `INTERNAL`.

## 2. Operator REST API

### POST /v1/sessions
```jsonc
{
  "agent": { "image": "base-v3", "entrypoint": "default" },
  "scopes": ["warehouse.readonly", "github.repo.read"],
  "approvalMode": "rule",
  "policyBundleId": "018f...",
  "ttlSeconds": 1800,
  "idleTimeoutSeconds": 300,
  "requestedBy": "love@example.com",
  "purpose": "Investigate the spike in failed checkouts since 09:00",
  "metadata": { "ticket": "INC-2291" }
}
```
201:
```jsonc
{
  "sessionId": "018f...",
  "status": "booting",
  "driver": "firecracker",
  "hardwareIsolated": true,
  "expiresAt": "2026-09-21T12:30:00Z",
  "websocketUrl": "wss://.../v1/sessions/018f.../events"
}
```
No token in the response. Ever. FR-3.

`policyBundleId` is optional. When omitted, the control plane reads
`settings.active_policy_bundle`; bootstrap creates the initial active bundle
before sessions can be created. `requestedBy` is required for audit labelling,
but is self-reported in v1 and is not an authentication or access-control
signal.

### GET /v1/sessions/:id
```jsonc
{
  "sessionId": "018f...", "status": "ready", "scopes": ["warehouse.readonly"],
  "driver": "firecracker", "hardwareIsolated": true,
  "intent": "Investigate the spike in failed checkouts since 09:00",
  "requestedBy": "love@example.com", "policyBundleId": "018f...",
  "createdAt": "...", "expiresAt": "...", "lastActivityAt": "...",
  "failureReason": null,
  "actionCounts": { "allow": 3, "deny": 1, "requireApproval": 0 },
  "pendingApprovals": 0
}
```
`intent` is the session's operator-stated `purpose`. Counts come from Postgres
counters updated with audit-sequence allocation, not ClickHouse. `failureReason`
is a nullable coarse enum: `start_timeout`, `driver_error`, or `cleanup_pending`.
Token material, host ids, transport identifiers, and socket paths are never returned.

### DELETE /v1/sessions/:id
202, terminates within five seconds. Body `{ "reason": "..." }`. Response is
`{ "sessionId": "...", "status": "terminated" | "failed" }`. Repeating a
delete of a terminal session is a no-op returning that terminal state.

For session creation, the initial lifecycle audit record is synchronous only to
the Postgres `audit_outbox`: the session, token hash, binding, and sequence-1
outbox record commit in one transaction before the `201 booting` response.
ClickHouse delivery is asynchronous. Guest execution starts only after that
transaction commits.

### POST /v1/sessions/:id/messages
Sends a user turn to the agent. `{ "content": "..." }`.

### GET /v1/sessions/:id/actions
Paginated audit replay. Query params `limit`, `cursor`, `decision`, `service`.

### POST /v1/approvals/:id/decision
```jsonc
{ "decision": "approve" | "deny", "comment": "optional" }
```
Requires an authenticated approver. Returns the signed decision record.

### GET /v1/approvals?state=pending
For approver reconnect (FR-48).

### Policy administration
- `POST /v1/policy/bundles` with `{ version, regoSource, notes }`. Compiles to wasm, runs the bundle's Rego tests, rejects on failure.
- `POST /v1/policy/bundles/:id/activate`
- `POST /v1/policy/simulate` with a full policy input document, returns the decision and matched rule names without executing the action. Each request writes a non-session `system_audit_events` record with an input hash, outcome, duration, trace identifiers, and nullable connection metadata. It never fabricates a session or authenticated caller. This is how you debug policy without burning a session.

### Health
- `GET /healthz` liveness.
- `GET /readyz` checks Postgres, ClickHouse, Redis, secret backend, policy bundle loaded, driver available. Reports `hardwareIsolated` so a deployment check can refuse an unisolated production start (FR-11).

## 3. Approval and event websocket

`wss://.../v1/events` for approvers, `wss://.../v1/sessions/:id/events` for a single session.

Server to client:
```jsonc
{ "type": "approval.requested", "data": {
    "approvalId": "...", "sessionId": "...", "requestedBy": "...",
    "purpose": "...", "service": "github", "method": "createPullRequest",
    "summary": "Open a PR against acme/api titled \"Fix checkout retry\" with 2 changed files",
    "paramsPreview": { },
    "agentIntent": "The failing checkouts come from a missing retry; I want to propose the fix.",
    "policyReason": "side-effecting method requires approval under rule mode",
    "expiresAt": "..." } }
```
`summary` is a sentence, not JSON. FR-49 exists because an approver shown raw JSON will rubber-stamp, which is worse than no approval because it manufactures a false record of human judgement.

Other server events: `approval.resolved`, `approval.expired`, `session.status`, `agent.step`, `agent.question`, `agent.output`.

Client to server: `subscribe`, `unsubscribe`, `approval.decide`, `question.answer`.

## 4. Guest to broker protocol

Transport: vsock, length-prefixed frames, one request in flight per frame id. Never HTTP over a network interface, because a network interface is a thing the guest could otherwise reach. A frame begins with a four-byte unsigned big-endian payload length (`UInt32BE`), followed by that many UTF-8 JSON payload bytes. The length excludes the prefix and may not exceed 16 MiB (16,777,216 bytes). The host reads no more than the declared bounded length. A declared oversize length, a read timeout, a truncated frame, or an unexpected close closes the connection without a response. A syntactically complete frame whose JSON or Zod schema is invalid receives one error frame when writable, then the connection closes. No connection is reused after a malformed frame. `broker.call` is single-frame. The local-tool authorization exchange below is the only M-3 multi-frame connection mode.

### broker.call
```jsonc
{ "id": "f-17", "op": "broker.call", "body": {
    "service": "postgres", "method": "query",
    "params": { "sql": "SELECT count(*) FROM orders WHERE status='failed'" },
    "intent": "count failed orders in the last hour",
    "idempotencyKey": "..." } }
```

Response:
```jsonc
{ "id": "f-17", "ok": true, "body": {
    "result": { "rows": [ { "count": 412 } ] },
    "meta": { "durationMs": 61, "redactionCount": 0, "roleUsed": "readonly", "actionId": "018f..." } } }
```

Denial:
```jsonc
{ "id": "f-17", "ok": false, "error": {
    "code": "POLICY_DENIED",
    "message": "statement type DELETE is not permitted for scope warehouse.readonly",
    "details": { "statementType": "DELETE", "scopeRequired": "warehouse.write" },
    "actionId": "018f..." } }
```
Denials are structured so the agent can adapt rather than retry blindly (FR-45). `details` never leaks anything the agent was not already entitled to know.

The broker's startup validation computes the largest response frame implied by
the configured adapter raw-byte caps, including base64 inflation and response
envelope overhead. Startup fails closed if that size exceeds the protocol
limit. This prevents a later adapter-cap increase from silently producing an
unframeable response.

### Other ops
`fs.read`, `fs.write`, `fs.edit`, `fs.search`, `proc.exec`, `user.ask`. All cross the same vsock transport and are audited outside the guest. Together with `broker.call`, they are the seven operations covered by FR-55 and INV-4.

The request bodies are:

| Operation | Body |
|---|---|
| `fs.read` | `{ path, range?: { start, end } }`, where the range is byte-based, start-inclusive, and end-exclusive |
| `fs.write` | `{ path, content }` |
| `fs.edit` | `{ path, oldString, newString }`; `oldString` must be non-empty and match exactly once |
| `fs.search` | `{ pattern, path?, opts?: { fixedStrings?, caseSensitive? } }` |
| `proc.exec` | `{ argv, cwd?, timeoutMs? }` |
| `user.ask` | `{ question, options? }` |

Every request is `{ id, op, body }`, where `id` is at most 128 UTF-8 bytes. Unknown fields are rejected. Paths are subsequently resolved and confined to `/workspace`; schema validation alone is not a path authorization decision. Content is capped at 2 MiB, patterns and paths at 4096 characters, argv at 128 entries of at most 8192 characters each, questions at 8192 characters, and options at twenty entries of at most 1024 characters each. Implementations also enforce byte caps before allocation or execution.

#### Local-tool authorization exchange

`broker.call` uses the existing host vsock port `1024`. Local tools use host vsock
port `1027`, then add a stateful, one-operation connection with exactly this sequence:

```text
guest -> host: { id, op: fs.* | proc.exec | user.ask, body }
host  -> guest: { id, ok: true, body: { actionId, authorized: true } }
guest executes the authorized local operation
guest -> host: { id, op: "local.completed", body: { actionId, outcome, result } }
host  -> guest: { id, ok: true, body: { result, meta: { actionId, durationMs } } }
host closes the connection
```

The host sends `authorized: true` only after transport-bound identity resolution, policy evaluation, host-side `proc.exec` allowlist validation where applicable, and synchronous `action.started` delivery. A denied authorization has the ordinary structured error response and closes without guest execution.

For `outcome: "success"`, `local.completed.body` is `{ actionId, outcome: "success", result }`. For `outcome: "failure"`, it is `{ actionId, outcome: "failure", error: { code, message, details } }`. `local.completed` is transport control, not an eighth agent operation; it cannot initiate an action and is rejected unless the same connection has one pending authorized local operation.

`CAISSON_LOCAL_TOOL_COMPLETION_TIMEOUT_MS` is required positive startup configuration. It bounds the interval from `local.authorized` until a complete `local.completed` frame arrives. A missing completion because the guest hangs, crashes, is killed, closes the connection, or exceeds this timeout produces durable terminal event `action.abandoned`, with error code `SANDBOX_FAILED` and no guest-provided result. The host closes the connection. This terminal event is distinct from a guest-reported execution failure.

`local.completed` contains a bounded frame `result`, not guest-reported byte counts or an audit preview. For every local operation, the host computes `serializedResult = JSON.stringify(result)`. `resultBytes` is the UTF-8 byte length of `serializedResult` only: it includes result-object field names and JSON punctuation, but excludes the outer `local.completed` frame and final response envelope. `resultHash` is SHA-256 over that same UTF-8 serialization. The host derives the only persisted preview itself using required `CAISSON_LOCAL_TOOL_AUDIT_PREVIEW_MAX_BYTES`. If `serializedResult` exceeds required `CAISSON_LOCAL_TOOL_RESULT_MAX_BYTES`, the action remains truthfully completed but the host returns `{ truncated: true, preview }` in place of the original result. `preview` is host-derived and bounded to the result cap; the audit record retains the original `resultBytes` and `resultHash`. The audit preview is scrubbed with `containsSecretShape`; it is never accepted from the guest. This makes the host, rather than the guest, authoritative for `resultBytes`, `resultHash`, and `paramsPreview`.

A syntactically invalid, schema-invalid, duplicate, wrong-id, or wrong-`actionId` completion after authorization produces durable terminal event `action.invalid_completion`, with error code `PARAMS_INVALID`, no raw malformed payload stored, and a structured error frame if the socket remains writable. The host then closes the connection. A frame, close, or timeout failure between `local.authorized` and the terminal response is never reusable: the connection closes and the already-started action receives exactly one durable terminal event (`action.abandoned` or `action.invalid_completion`).

The final guest response waits for the terminal event to commit to the Postgres `audit_outbox`, then closes. It does not wait for ClickHouse delivery. This is the M-2 fail-durable completion model: the queued event is durable and ordered, while ClickHouse delivery is retried by the existing outbox drainer. No latency estimate is asserted here; M-3 must measure this path with the benchmark scripts before making an NFR-2 claim.

M-3 uses one shared required completion timeout across local operations. This is an intentional interim limit, not an assertion that `fs.read`, `fs.search`, and `proc.exec` have identical expected durations. Per-operation timeout policy is deferred to a later capability-policy review; M-3 operators choose a value appropriate for the enabled allowlist.

The host validates both request and final response before forwarding them to the agent.

`proc.exec` has no `command` string field, no `shell` flag, and no way to add one. FR-41. Its `process.exec` scope gates the fixed v1 allowlist as a whole; per-binary scopes are outside M-3.

`user.ask` is structurally present in M-3, but M-4 owns approver authentication and the websocket hub. In M-3 it validates and audits the request, then returns `APPROVAL_UNAVAILABLE`. The endpoint does not treat the unauthenticated websocket URL as a credential.

### What the guest never receives
A token value, a credential, an approval nonce, another session's identifier, or the host's view of its own identity. If a field would let the guest assert who it is, it does not exist in this protocol.

## 5. Interfaces (TypeScript)

```ts
interface IsolationDriver {
  prepare(spec: SandboxSpec, transportHost: TransportHost): Promise<PreparedSandbox>;
  start(handle: SandboxHandle, options?: { resume?: { lastAuditSeq: number; lastActionId: string; resumedAt: string } }): Promise<void>;
  exec(h: SandboxHandle, req: ExecRequest): Promise<ExecResult>;
  snapshot(h: SandboxHandle, kind: 'base' | 'session'): Promise<LocalSnapshot>;
  restore(ref: ResolvedSnapshot, spec: SandboxSpec, transportHost: TransportHost): Promise<PreparedSandbox>;
  destroy(h: SandboxHandle): Promise<void>;
  capabilities(): DriverCapabilities;   // { hardwareIsolation, snapshotSupport, maxConcurrent }
}

interface SnapshotRef {
  id: string;
  kind: 'base' | 'session';
  manifest: { bucket: string; key: string; versionId?: string; sha256: string; sizeBytes: number };
  manifestKeyId: string;
  createdAt: string;
  sessionId?: string;       // required only for kind: 'session'
  baseSnapshotId?: string;  // required only for kind: 'session'
}

For `kind: 'session'`, `sessionId` and `baseSnapshotId` are required and
host-derived. A resolver rejects a snapshot before I/O when either differs from
the requesting session or immutable base lineage. Session artifacts are
AES-256-GCM encrypted under per-snapshot DEKs wrapped by a per-session KEK;
neither key reaches the guest.

Before a session snapshot, `SessionActionGate` closes broker and local-tool
admission synchronously, then waits at most the required
`CAISSON_SESSION_SNAPSHOT_DRAIN_TIMEOUT_MS` for existing actions to reach a
durable terminal audit record. New calls receive `SESSION_SUSPENDED` plus a
durable `action.denied` record; they are not queued. Timeout aborts without a
restorable snapshot. The exclusive hold includes artifact capture and upload,
DEK wrapping, and the database commit that stores the wrapped DEK together with
`resume_audit_seq` and `resume_action_id`.

After restore, port 1028 carries one bounded newline-terminated JSON resume
control object `{ lastAuditSeq, lastActionId, resumedAt }`. This control socket
is exposed only after the ADR-24 entropy acknowledgement. The guest validates
the object, persists it only in `/run/caisson/resume.json`, and replies
`RESUME_OK\n`; any invalid object returns `RESUME_ERROR\n`. `start()` does not
resolve and the session cannot become ready without the acknowledgement. On
the initial boot, the runtime waits for the resume listener to bind before it
exposes either the diagnostic control listener or `/run/caisson/agent.sock`.
Consequently, every guest state eligible for a session snapshot already
contains a live resume listener; listener startup is not allowed to race
snapshot capture.

interface LocalSnapshot {
  id: string;
  kind: 'base' | 'session';
  statePath: string;
  memoryPath: string;
  rootfsPath?: string;
  kernelPath?: string;
  createdAt: string;
}

interface ResolvedSnapshot {
  ref: SnapshotRef;
  statePath: string;
  memoryPath: string;
  rootfsPath?: string;
  kernelPath?: string;
}

interface SandboxHandle {
  id: string;
  driver: 'firecracker' | 'container';
}

interface PreparedSandbox {
  handle: SandboxHandle;
  transport: TransportDescriptor;
}

interface TransportHost {
  reserve(descriptor: TransportDescriptor): Promise<TransportAttachment>;
  release(descriptor: TransportDescriptor): Promise<void>;  // only after destroy(handle)
}

interface TransportAttachment {
  descriptor: TransportDescriptor;  // persisted identity source
  endpointPath: string;             // runtime-only host path, never persisted
}

interface TransportDescriptor {
  kind: 'vsock' | 'unix';
  hostId: string;
  peerIdentifier: string;             // host-only and opaque to the guest
}

interface ServiceAdapter {
  name: string;
  methods: Record<string, AdapterMethod>;
}

interface AdapterMethod {
  params: ZodSchema;
  scopeRequired: string | ((params: unknown) => string);
  sideEffecting: boolean | ((params: unknown) => boolean);
  summarise(params: unknown): string;          // the human sentence used in approvals
  execute(creds: Credentials | undefined, params: unknown, ctx: CallContext): Promise<unknown>;
}

interface SecretBackend {
  fetch(ref: CredentialRef): Promise<Credentials>;   // must never log, never cache to disk
  health(): Promise<boolean>;
}

type Credentials = PostgresCredentials | S3Credentials;

interface PostgresCredentials {
  kind: 'postgres';
  host: string;
  port: number;
  database: string;
  username: SecretString;
  password: SecretString;
  readCredentials: {
    username: SecretString;
    password: SecretString;
  };
  sslMode: 'verify-full' | 'require' | 'disable'; // disable is development-only
}

interface S3Credentials {
  kind: 's3';
  accessKeyId: SecretString;
  secretAccessKey: SecretString;
}

interface CredentialRef {
  backend: 'env' | 'vault';
  backendPath: string;
  role: string;
}

interface Redactor {
  redact(value: unknown, sessionId: string): { value: unknown; count: number };
}
```

Credentials are structured, discriminated by adapter kind, and exist only in
memory. Secret values use a wrapper whose string, JSON, and inspection forms
are `[redacted]`. The env backend reads one JSON credential document from an
environment variable named by `backendPath`. The Vault backend reads a KV-v2
document at a validated path beneath its configured mount prefix. Vault uses
`VAULT_ADDR` and `VAULT_TOKEN`; HTTPS is mandatory outside development.

For the container driver, `endpointPath` is the same random absolute Unix-socket
path as `peerIdentifier`, and `TransportHost` creates the listener. For the
Firecracker driver, `peerIdentifier` remains the assigned CID while
`endpointPath` is a separate random private UDS path. Firecracker binds that
path as trusted host infrastructure; the guest cannot observe or influence it.
`restore()` reserves a new attachment and loads the snapshot paused. The control
plane persists its new descriptor before calling `start()` to resume the VM.
Attachment paths are never persisted. A broker crash terminates sessions on
that host, so a restarted broker must establish new live transport rather than
recovering an old endpoint.

`summarise` is on the adapter for a reason: only the adapter knows how to turn its own parameters into a sentence a human can judge.

The HTTP adapter exposes `request({ url, method, headers?, body? })`. `body`,
when supplied, is `{ encoding: 'utf8' | 'base64', data: string }`. It maps
`GET`, `HEAD`, and `OPTIONS` to `http.read`, and `POST`, `PUT`, `PATCH`, and
`DELETE` to `http.write`; all other methods fail closed. `Host` and
`Authorization` request headers are rejected. Its response is
`{ status, headers, body }`, using the same explicit body envelope. Text-like
content types are UTF-8 and all other content is base64. Limits apply to raw
bytes before base64 encoding.

The S3 adapter exposes `getObject({ bucket, key })`,
`putObject({ bucket, key, body, contentType? })`, `deleteObject({ bucket, key })`,
and `listObjects({ bucket, prefix })`. Its scopes are `s3.read`, `s3.write`,
and `s3.delete`. S3 endpoints, bucket and prefix allowlists, timeouts, and
size limits are host-side service configuration. No method accepts an endpoint
override or returns a presigned URL. Object bodies use the same explicit
UTF-8/base64 envelope and their raw-byte size is capped before encoding.
