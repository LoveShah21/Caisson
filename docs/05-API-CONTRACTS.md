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

`INVALID_REQUEST`, `SESSION_NOT_FOUND`, `SESSION_NOT_READY`, `SESSION_EXPIRED`, `SCOPE_DENIED`, `POLICY_DENIED`, `POLICY_UNAVAILABLE`, `APPROVAL_REQUIRED`, `APPROVAL_DENIED`, `APPROVAL_TIMEOUT`, `SECRET_UNAVAILABLE`, `AUDIT_UNAVAILABLE`, `ADAPTER_NOT_FOUND`, `METHOD_NOT_FOUND`, `PARAMS_INVALID`, `SERVICE_TIMEOUT`, `SERVICE_ERROR`, `RATE_LIMITED`, `SANDBOX_FAILED`, `BINARY_NOT_ALLOWED`, `PATH_DENIED`, `INTERNAL`.

## 2. Operator REST API

### POST /v1/sessions
```jsonc
{
  "agent": { "image": "base-v3", "entrypoint": "default" },
  "scopes": ["warehouse.readonly", "github.repo.read"],
  "approvalMode": "rule",
  "ttlSeconds": 1800,
  "idleTimeoutSeconds": 300,
  "purpose": "Investigate the spike in failed checkouts since 09:00",
  "metadata": { "requestedBy": "love@example.com", "ticket": "INC-2291" }
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

### GET /v1/sessions/:id
Returns status, timings, scopes, driver, `hardwareIsolated`, counts by decision, pending approvals.

### DELETE /v1/sessions/:id
202, terminates within five seconds. Body `{ "reason": "..." }`.

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
- `POST /v1/policy/simulate` with a full policy input document, returns the decision and matched rule names without executing the action. Each request writes an audit record with `action_type='policy_simulate'`; these records are excluded from real per-session replay views. This is how you debug policy without burning a session.

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

Transport: vsock, length-prefixed frames, one request in flight per frame id. Never HTTP over a network interface, because a network interface is a thing the guest could otherwise reach.

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

### Other ops
`fs.read`, `fs.write`, `fs.edit`, `fs.search`, `proc.exec`, `user.ask`. All cross the same vsock transport and are audited outside the guest. Together with `broker.call`, they are the seven operations covered by FR-55 and INV-4.

`proc.exec` request body is `{ "argv": ["rg","-n","checkout","src/"], "cwd": "/workspace", "timeoutMs": 30000 }`. There is no `command` string field, no `shell` flag, and no way to add one. FR-41.

### What the guest never receives
A token value, a credential, an approval nonce, another session's identifier, or the host's view of its own identity. If a field would let the guest assert who it is, it does not exist in this protocol.

## 5. Interfaces (TypeScript)

```ts
interface IsolationDriver {
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  exec(h: SandboxHandle, req: ExecRequest): Promise<ExecResult>;
  snapshot(h: SandboxHandle, kind: 'base' | 'session'): Promise<SnapshotRef>;
  restore(ref: SnapshotRef, spec: SandboxSpec): Promise<SandboxHandle>;
  destroy(h: SandboxHandle): Promise<void>;
  capabilities(): DriverCapabilities;   // { hardwareIsolation, snapshotSupport, maxConcurrent }
}

interface ServiceAdapter {
  name: string;
  methods: Record<string, AdapterMethod>;
}

interface AdapterMethod {
  params: ZodSchema;
  scopeRequired: string;
  sideEffecting: boolean;
  summarise(params: unknown): string;          // the human sentence used in approvals
  execute(creds: Credentials, params: unknown, ctx: CallContext): Promise<unknown>;
}

interface SecretBackend {
  fetch(ref: CredentialRef): Promise<Credentials>;   // must never log, never cache to disk
  health(): Promise<boolean>;
}

interface Redactor {
  redact(value: unknown, sessionId: string): { value: unknown; count: number };
}
```

`summarise` is on the adapter for a reason: only the adapter knows how to turn its own parameters into a sentence a human can judge.
