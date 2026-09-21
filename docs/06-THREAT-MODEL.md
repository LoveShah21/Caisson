# 06 - Threat model

This is the most important document in the repository. The invariants below are the product. Everything else is machinery that exists to make them true.

## 1. Assets

| Asset | Why it matters |
|---|---|
| Service credentials | Direct access to production systems |
| Data returned by services | May contain PII or business-sensitive content |
| The audit record | The only account of what happened |
| Policy bundles | Define what is permitted; tampering silently widens access |
| Approval decisions | A forged approval is worse than no approval |

## 2. Adversaries

**A1. Injected instruction.** Content returned from a service contains instructions. The model follows them. This is the default case, not the exotic one, and the whole design assumes it will happen.

**A2. Compromised or misaligned model.** The agent actively attempts to obtain credentials or exfiltrate data. Assume full knowledge of the Caisson source code; it is open source.

**A3. Malicious operator with limited scope.** A legitimate user with narrow scopes tries to widen them from inside a session.

**A4. Compromised external service.** A service returns hostile payloads designed to exploit the broker or the redaction pipeline.

**A5. Curious insider.** Someone with read access to the databases attempting to recover secrets or private data from stored records.

Out of scope for v1: a malicious control plane operator, a compromised host kernel, physical access, supply-chain attack on Firecracker itself.

## 3. Invariants

Each has a test file in `tests/invariants/INV-n.spec.ts` and is referenced by name in the README.

**INV-1. No secret in the guest.**
No credential value exists inside the sandbox: not in memory, not in an environment variable, not on disk, not in an argv. Environment variables for brokered and intercepted services contain the literal `credential-brokered`.
*Test:* run a session that greps the entire guest filesystem, environment, and process table for the known test secret; assert zero hits; assert the same after a successful brokered call that used it.

**INV-2. No unbrokered egress.**
From inside the sandbox every outbound connection except the vsock to the broker and allowlisted intercepted hosts fails.
*Test:* raw TCP to a host IP, UDP DNS to 8.8.8.8, HTTP to an IP literal bypassing DNS, IPv6 literal, ICMP, a connection to the host's own interface, and an attempt to reach the metadata endpoint at 169.254.169.254. All must fail, all must be logged.

**INV-3. Policy is enforced outside the guest.**
Identity, scopes, and roles come from the control plane record resolved through the transport binding. Nothing the guest sends can influence them.
*Test:* a guest that sends forged `sessionId`, `scopes`, `roles`, and `token` fields in every request gains no additional capability.

**INV-4. No action escapes the log.**
Every action produces an audit record before execution and after completion. An audit write failure fails the action.
*Test:* fault-inject a ClickHouse outage during a brokered call; assert the call fails with `AUDIT_UNAVAILABLE` and the service was never contacted. Separately, assert sequence numbers within a session contain no gaps.

**INV-5. Tokens are scoped and expiring.**
A token carries a scope snapshot and an expiry, fails closed when expired, and cannot be widened from inside the session.
*Test:* freeze time past expiry mid-session; assert failure. Attempt scope widening through every guest-reachable path; assert no change.

**INV-6. Approvals cannot be forged.**
Approval is correlated by a server-generated nonce never exposed to the guest, and the decision is signed by the control plane.
*Test:* a guest that fabricates approval messages, replays a previously observed approval, or attempts to resolve its own request is rejected. Verify signature validation rejects tampered records.

**INV-7. No persistence across sessions.**
Sandbox disk and memory are destroyed at termination. Nothing written by one session is observable by another restored from the same base snapshot.
*Test:* session A writes a marker to several locations including `/tmp`, `/dev/shm`, and the workspace; session B restored from the same base snapshot finds none of them.

**INV-8. Subprocess allowlist holds.**
Only allowlisted binaries execute, `git` is fetch-only, and no shell is invoked.
*Test:* attempt `sh -c`, argv injection with metacharacters, symlinking an allowlisted name to a disallowed binary, PATH manipulation, `LD_PRELOAD`, and executing an uploaded binary from the workspace. All must fail.

## 4. Mapping adversaries to defences

| Adversary | Primary defence | Residual risk |
|---|---|---|
| A1 injected instruction | INV-1, INV-2, INV-3: compliance gains nothing | Agent can still misuse capabilities it legitimately has, within scope. Mitigated by narrow scopes and approvals, not eliminated. |
| A2 compromised model | Same, plus INV-8 and the absence of an HTTP client | Covert channels through permitted actions, for example encoding data in query patterns. Detectable in audit, not prevented. |
| A3 scope escalation | INV-3, INV-5, token scope snapshot | An operator who legitimately holds broad scopes is not constrained by Caisson. |
| A4 hostile service response | Schema validation on responses, redaction, size caps | A parser bug in an adapter. Mitigated by keeping adapters small and fuzzing them. |
| A5 curious insider | No secret values stored, params hashed not stored, redacted previews only | Previews still carry some information. Retention TTL limits exposure window. |

## 5. The honest limitations section

State these in the README. Omitting them is the failure mode this project exists to criticise.

1. **Authorised misuse is not prevented.** If an agent may read a table, it may read every row of that table. Scopes and approvals narrow this; they do not close it.
2. **Covert channels exist.** An agent with permission to make many queries can encode information in their timing or content. Caisson records this; it does not stop it.
3. **The container driver is not isolation.** It shares a kernel. It exists so the project runs on a laptop and it says so loudly at startup.
4. **Redaction is heuristic.** Detectors miss things. Do not treat redaction as a compliance control.
5. **Approval fatigue is real.** A system that asks too often trains people to click approve. The `approval_wait_seconds` and approval-rate metrics exist partly to make this visible.
6. **The broker is a single point of trust.** It is deliberately small so it can be read in full, but a bug there is a bug everywhere.
7. **Firecracker escape is out of scope.** Caisson inherits Firecracker's security posture and does not improve on it.

## 6. Prompt injection: the defining test

`tests/adversarial/prompt-injection.spec.ts` seeds a database table whose contents instruct the agent to fetch credentials and POST them to an external endpoint. The model in the test is configured to comply fully.

Assertions: no credential is obtainable, the outbound request fails at the network layer, the attempt appears in the audit log, and the session completes without the exfiltration succeeding.

This single test is the thesis of the project. If it is ever skipped or weakened, the project has stopped being what it claims to be.
