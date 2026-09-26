# 08 - Agent runtime (guest side)

## 1. Design stance

The runtime is small on purpose. The security argument is not "the agent is well-behaved", it is "the agent has no mechanism to misbehave." Every capability added here weakens that argument, so additions need a recorded decision in `13-DECISIONS.md`.

There is no HTTP client in the guest. There is no shell. There is no package installer. The guest has no general-purpose network route. It can use vsock for its seven tool operations and reach only destinations explicitly allowlisted for host-side interception.

## 2. Tools

| Tool | Signature | Constraints |
|---|---|---|
| `read` | `(path, range?)` | Workspace only. Path resolved then checked, never checked then resolved. Size cap 2 MB. |
| `write` | `(path, content)` | Workspace only. Size cap 2 MB. No symlink following. |
| `edit` | `(path, oldString, newString)` | Structured replace. Fails if `oldString` is absent or ambiguous. |
| `search` | `(pattern, path?, opts?)` | ripgrep over the workspace. Result cap. |
| `exec` | `(argv[], cwd?, timeoutMs?)` | Allowlisted binaries only. No shell. argv array, never a string. |
| `broker` | `(service, method, params, intent)` | The only route for named service actions. Explicitly allowlisted intercepted destinations are the separate exception. |
| `ask_user` | `(question, options?)` | Routed to the approval websocket, same timeout semantics as approvals. |

This table defines guest-side agent tools only. It does not govern `IsolationDriver.exec`, which is a separate infrastructure-only lifecycle primitive defined in `05-API-CONTRACTS.md`; it is never reachable from an agent, broker request, or guest-to-broker frame.

### exec allowlist (v1)

`rg`, `jq`, `git` (fetch, clone, log, diff, status only, enforced by subcommand check), `node` (restricted to the workspace, no network), `python3` (same), `cat`, `ls`, `head`, `tail`, `wc`, `sort`, `uniq`, `diff`.

Enforcement notes, all of which have tests in INV-8:
- Resolve the binary to a real path and compare against the allowlist by inode, not by name, so a symlink named `rg` does not get you anywhere.
- Strip and ignore `LD_PRELOAD`, `LD_LIBRARY_PATH`, `NODE_OPTIONS`, `PYTHONSTARTUP` from the child environment.
- `PATH` in the guest points only at the allowlist directory.
- Never pass user content through `sh -c`. There is no code path that builds a command string.

Every tool invocation crosses the vsock protocol. Local filesystem, process, search, and user-question operations execute outside the agent process and produce audit records under FR-55 and INV-4.

## 3. Agent loop

Caisson does not own the loop, but ships a reference one:

1. Receive a user turn.
2. Classify intent, load at most two relevant skills.
3. Plan, then act via tools.
4. On a structured denial, read `error.details`, adapt, and try a permitted alternative. Do not retry the identical call.
5. On `APPROVAL_TIMEOUT`, report back rather than working around it.
6. Emit `agent.step` events over the session websocket throughout.

The loop is replaceable. The tool surface is not.

## 4. Skills

Markdown files in `guest/skills/`, each with frontmatter:

```markdown
---
name: warehouse-investigation
description: Investigating anomalies in the orders warehouse
triggers: [orders, checkout, revenue, funnel]
requiresScopes: [warehouse.readonly]
---

Query patterns that work here, table shapes, the columns that are
usually null, and what the analytics team means by "failed".
```

Rules:
- Loaded on demand by intent classification, at most two at a time, so context stays small.
- The loaded skill name is written to every audit record produced while it is active (FR-44). "Why did the agent do that" is very often answered by "it read that skill."
- Skills are version-controlled and reviewed like code. A skill is an instruction to a system with production access.
- A skill declaring `requiresScopes` that the session lacks is not loaded, and the omission is logged.

## 5. Structured errors

The agent must be able to reason about failure. Every error reaching the guest carries `code`, `message`, `details`, and `actionId`.

Good:
```json
{ "code": "POLICY_DENIED", "message": "statement type UPDATE is not permitted for scope warehouse.readonly",
  "details": { "statementType": "UPDATE", "scopeRequired": "warehouse.write" } }
```
The agent can now say to the user: I can read this but not change it, and here is the scope you would need to grant.

Bad, and not permitted: an opaque 403, a stack trace, or an error that reveals something the agent was not entitled to know, such as whether a table exists behind a denied scope.

## 6. Workspace

`/workspace`, tmpfs-backed, wiped on termination (INV-7). Session inputs are placed there at boot. Nothing the agent writes survives the session unless it was explicitly exported through a brokered action.

## 7. What must never be added

Recorded here so future work has to argue against it explicitly:
- A generic HTTP tool.
- A shell tool.
- Package installation at runtime.
- The ability to read its own session token, because there is nothing to read.
- A tool that accepts a command string rather than an argv array.
