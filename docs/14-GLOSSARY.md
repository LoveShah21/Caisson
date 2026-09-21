# 14 - Glossary

**Action.** One thing the agent did: a brokered call, a file operation, an exec, a question. The unit of the audit trail.

**Adapter.** Host-side code that knows how to talk to one external service. Declares methods, parameter schemas, required scopes, whether each method is side-effecting, and how to summarise a call in a sentence for a human approver.

**Approval.** A blocking request for a human decision, created when policy returns `require_approval`. Carries a nonce the guest never sees.

**Approval mode.** Per-session setting: `auto` (policy decides, nothing escalates), `rule` (escalate when policy says so), `always` (every action blocks on a human).

**Broker.** The host-side process that is the agent's only route to the outside world. Resolves identity, validates parameters, evaluates policy, holds credentials, executes, redacts, audits.

**Caisson.** A pressurised chamber used for underwater construction. Work happens inside a sealed box and everything entering or leaving passes through a lock. Also the name of this system.

**Container driver.** The development isolation driver. Shares a kernel with the host. Reports `hardwareIsolation: false` and is refused in production mode.

**Credential brokering.** The pattern where the agent names an action and a trusted component holds the secret and performs it. The agent never possesses the credential.

**Fail closed.** When a dependency is unavailable or a decision cannot be reached, refuse the action. The opposite, fail open, does not exist anywhere in this system and no flag enables it.

**Guest.** Everything inside the sandbox. Untrusted by definition.

**Interceptor.** A transparent host-side proxy for destinations that cannot be brokered, such as model provider APIs and git remotes. Injects credentials on egress.

**Invariant.** A security property that must hold regardless of agent behaviour, with a named test that proves it. Eight of them, in `06-THREAT-MODEL.md`. They are the product.

**Isolation driver.** The interface behind which sandbox creation, execution, snapshotting, and destruction sit. Two implementations: Firecracker and container.

**Obligation.** A condition attached to an `allow` decision, such as `redact_pii` or `role:readonly`. An obligation the broker cannot honour fails closed.

**Policy bundle.** A versioned set of Rego files compiled to wasm, stored in Postgres, signed, and referenced by the sessions evaluated against it. Never edited in place.

**Redaction.** Replacing detected sensitive values in a service response with stable per-session tokens before the response reaches the guest. Heuristic, and not a compliance control.

**Role.** A credential variant for a service, such as `readonly` or `writer`. Selected by a policy obligation at call time.

**Sandbox.** The isolated execution environment for one session. Destroyed at termination.

**Scope.** A named permission on a session, formatted `service.capability`. Snapshotted onto the token at mint time so the session record cannot widen an existing token retroactively.

**Session.** One bounded run of an agent, with a scope set, a TTL, an approval mode, a policy bundle, and a sandbox. Disposable.

**Skill.** A markdown instruction file loaded on demand into the agent's context. Version-controlled, reviewed like code, and recorded in the audit trail while active.

**Transport binding.** The record linking a live vsock connection to a session. How the broker knows who is calling, and the reason nothing the guest claims about its own identity matters.

**vsock.** The virtio socket used between guest and host. Not a network interface, which is the point.
