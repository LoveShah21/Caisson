## What this is

**Caisson**: an isolated execution environment for LLM agents. The agent runs sealed, holds no credentials, reaches nothing except a host-side broker it cannot modify and destinations explicitly allowlisted for interception, and cannot act without being logged.

## Before you do anything

Read `docs/00-INDEX.md`. It routes you to the right document for the task. The documents in `docs/` are normative; if code and documents disagree, resolve it explicitly rather than letting the code win.

For any task touching security, read `docs/06-THREAT-MODEL.md` first. The eight invariants there are the product.

## Non-negotiables

- The broker runs on the host, never in the guest. ADR-2.
- Everything fails closed. There is no flag that makes anything fail open.
- Audit writes are on the critical path. A failed log write fails the action. ADR-7.
- Invariant tests in `tests/invariants/` are never skipped, never conditional.
- No secret value in a log, a span, an error, or a database row.
- No number in the README that was not measured by a script in `benchmarks/`.
- SQL restrictions evaluate a parsed statement type, never a substring. ADR-5.

## Where things live

| I need to | Read |
|---|---|
| Understand the product | `docs/01-PRD.md` |
| Understand the components | `docs/03-ARCHITECTURE.md` |
| Find a numbered requirement | `docs/02-SRS.md` |
| Change a table | `docs/04-DATABASE.md` |
| Change an endpoint or message | `docs/05-API-CONTRACTS.md` |
| Write Rego | `docs/07-POLICY-MODEL.md` |
| Work on the guest | `docs/08-AGENT-RUNTIME.md` |
| Write a test | `docs/09-TESTING-STRATEGY.md` |
| Add a span or metric | `docs/10-OBSERVABILITY.md` |
| Know what milestone we are in | `docs/11-ROADMAP.md` |
| Name something, handle an error | `docs/12-CONVENTIONS.md` |
| Know why something is the way it is | `docs/13-DECISIONS.md` |

## Style

Plain prose. No marketing adjectives, no em dashes, no inflated significance. State limitations rather than hiding them.
