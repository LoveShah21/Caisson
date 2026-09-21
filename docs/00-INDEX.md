# Caisson documentation index

Caisson is an isolated execution environment for LLM agents. The agent runs sealed, holds no credentials, reaches nothing except a broker it cannot modify, and cannot take an action that is not logged.

These documents are the specification of record. If code and documents disagree, stop and resolve the disagreement explicitly rather than letting the code win silently.

## Reading order for a new contributor or agent

1. `01-PRD.md` - what is being built and why, scope boundaries, success criteria
2. `03-ARCHITECTURE.md` - components, trust boundaries, data flow
3. `06-THREAT-MODEL.md` - the eight security invariants, which are the product
4. `02-SRS.md` - numbered functional and non-functional requirements
5. `11-ROADMAP.md` - milestones and acceptance gates

## Load on demand

| Task | Read |
|---|---|
| Writing or changing a database table | `04-DATABASE.md` |
| Adding or changing an endpoint or message | `05-API-CONTRACTS.md` |
| Writing Rego, changing decisions or obligations | `07-POLICY-MODEL.md` |
| Working on the guest, tools, or skills | `08-AGENT-RUNTIME.md` |
| Writing tests of any kind | `09-TESTING-STRATEGY.md` |
| Adding spans, metrics, dashboards | `10-OBSERVABILITY.md` |
| Naming things, code style, error handling | `12-CONVENTIONS.md` |
| Making a decision that closes off alternatives | `13-DECISIONS.md` (append) |
| Unsure what a word means here | `14-GLOSSARY.md` |

## Requirement identifiers

- `FR-n` functional requirement, defined in `02-SRS.md`
- `NFR-n` non-functional requirement, defined in `02-SRS.md`
- `INV-n` security invariant, defined in `06-THREAT-MODEL.md`
- `ADR-n` architecture decision record, in `13-DECISIONS.md`
- `M-n` milestone, in `11-ROADMAP.md`

Every pull request description names the identifiers it implements. Every invariant test file is named for its invariant.
