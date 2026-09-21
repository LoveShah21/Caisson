# 01 - Product Requirements Document

## 1. Problem

Teams are putting LLM agents into production and then discovering they cannot let those agents near anything real. An agent that can query the warehouse, open a pull request, or restart a service needs credentials for those systems. Handing a model provider's API a long-lived database password is not a decision most engineering organisations will sign off on, and they are right not to.

The workarounds in use today are bad in predictable ways:

- **Give the agent the keys and hope.** Common, undefended, and one prompt injection away from an incident.
- **Wrap every tool by hand.** Works until you have eleven tools, at which point the policy logic is duplicated eleven times and nobody can answer what the agent is allowed to do.
- **Run it in a container.** Solves nothing about credentials, and a container shares a kernel with the host.
- **Buy an enterprise agent platform.** Heavy, expensive, and usually assumes you have adopted the vendor's agent framework.

The gap: nothing open source combines sealed execution, credential brokering, granular audit, and human approval in one system.

## 2. Product summary

Caisson runs an LLM agent inside a hardware-isolated microVM with no network route except a host-side broker. The agent never sees a credential. It requests actions by name. The broker resolves identity, evaluates policy, optionally blocks for a human, executes the call with the real secret, redacts the response, logs everything, and returns the result.

The claim Caisson makes, and must be able to defend with tests:

> Even if the agent is fully compromised by prompt injection, and even if the model actively tries to exfiltrate, it cannot obtain a credential, cannot reach an unapproved destination, and cannot take an action that does not appear in the audit log.

## 3. Users

**Primary: the platform engineer.** Owns agent infrastructure at a company with between twenty and five hundred engineers. Has been asked to let an agent touch production. Needs to be able to say yes with a defensible answer to security review.

**Secondary: the security reviewer.** Does not write the agent. Needs to read the threat model, ask what happens when the agent is compromised, and get a real answer. Will reject anything whose security argument is "the model is instructed not to."

**Tertiary: the incident responder.** Three weeks later, something is wrong. Needs to reconstruct what the agent did, in order, with what inputs, and who approved it.

## 4. Goals

- G1. An agent performs useful work against real systems with no credential present in its execution environment.
- G2. What the agent is permitted to do is expressed as policy in one place, versioned and testable, not scattered across tool implementations.
- G3. Every action, allowed or denied, is queryable months later.
- G4. Sensitive actions can require a named human to approve, with the request rendered in a form a human can actually judge.
- G5. Session start-up is fast enough for interactive use, target under one second warm.
- G6. A reviewer can run the whole system locally with one command, without special hardware.

## 5. Non-goals

- N1. Not an agent framework. Caisson does not own the reasoning loop, the prompt, or the model choice.
- N2. Not a general container platform. Sessions are single-agent, short-lived, and disposable.
- N3. Not high availability in v1. Single control plane. Restart loses nothing durable but does terminate live sessions.
- N4. Not multi-region, not multi-tenant in v1. Tenancy is a stretch item with real schema implications, called out in `11-ROADMAP.md`.
- N5. Not a polished UI product. The approval interface is functional and plain by design.
- N6. Not a secrets manager. Caisson consumes one through an interface.

## 6. Core user journeys

### J1. Run a task
A platform engineer creates a session scoped to `warehouse.readonly`, gives the agent a question, and gets an answer. No credential existed in the sandbox at any point. The audit log shows three queries and one denied write attempt.

### J2. Approve a sensitive action
An agent in `rule` approval mode tries to open a pull request. Policy returns `require_approval`. A reviewer sees the request rendered as a sentence, with the diff, the session's stated purpose, and the policy reason. They approve. The agent unblocks. The decision, the decider, and the wait time are recorded.

### J3. Deny by policy
The agent constructs a `DELETE` disguised inside a comment. The SQL is parsed, the statement type is `DELETE`, policy denies, the agent receives a structured error explaining what was refused, and the attempt is logged as a denial. The agent adapts instead of crashing.

### J4. Investigate afterwards
An incident responder queries the audit store by session and gets an ordered action list with parameter previews, result sizes, the skill the agent had loaded, and the trace id for each step.

### J5. Evaluate the project
A stranger clones the repo, runs one command, and has a working demo in under ten minutes on a laptop with no virtualisation support, with a visible warning that the development isolation driver does not provide hardware isolation.

## 7. Success criteria

Caisson v1 is done when:

- All eight invariants in `06-THREAT-MODEL.md` have passing named tests in CI.
- The adversarial suite contains at least forty distinct escape attempts across eight categories, all failing, all logged.
- A prompt-injection test proves the architecture holds regardless of model compliance.
- Warm session start is measured and reported with machine specifications, along with the cold number.
- Broker overhead p99 is measured, excluding downstream latency.
- Five service adapters exist: postgres, http, github, s3, slack.
- `docker compose up` produces a working demo on a machine without KVM.
- The README states limitations plainly, including everything the container driver does not protect against.

## 8. Explicitly out of scope for v1

Session replay, eBPF interception, policy learning, multi-tenancy, HA control plane, a managed hosted offering, SSO, and any billing concept. Some of these are roadmap stretch items. None of them gate v1.

## 9. Competitive position

E2B and similar give code execution without credential management. Anthropic's Computer Use reference implementation is a capability demonstration, not a security model. Vendor agent platforms bundle isolation with an opinionated framework. Caisson is the layer underneath any of them: it does not care what agent you run, only what that agent is allowed to touch.
