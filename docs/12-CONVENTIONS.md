# 12 - Engineering conventions

## 1. Language and tooling

TypeScript, strict mode, Node 22+. pnpm workspaces, Turborepo. Biome for lint and format. Vitest for tests. Drizzle for Postgres. zod at every boundary.

No `any` outside vendored type declarations. `unknown` plus a schema parse instead. `strictNullChecks`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` all on.

## 2. Boundaries

Every value crossing a boundary is parsed, not cast. Boundaries are: the REST API, the websocket, the vsock protocol, adapter parameters, adapter responses, policy output, and anything read from a database as JSON.

```ts
// wrong
const body = req.body as CreateSessionRequest;
// right
const body = CreateSessionRequest.parse(req.body);
```

## 3. Errors

```ts
class CaissonError extends Error {
  constructor(
    readonly code: ErrorCode,      // closed enum in packages/protocol
    message: string,
    readonly details?: Record<string, unknown>,
    readonly cause?: unknown,
  ) { super(message); }
}
```

Rules:
- Never throw a bare `Error` outside a test.
- Never put a secret, a credential path, or raw parameters in a message or `details`.
- Never swallow an error to keep going on the security path. Fail closed.
- `details` must contain only information the recipient was already entitled to.

## 4. Naming

- Files `kebab-case.ts`. Types `PascalCase`. Functions and variables `camelCase`. Constants `SCREAMING_SNAKE`.
- Scopes are `service.capability`, for example `warehouse.readonly`, `github.repo.write`.
- Obligations are `name` or `name:argument`.
- Span names are `caisson.<component>.<operation>`.
- Metrics are `caisson_<subject>_<unit>`.
- Migration files are `NNNN_short_description.sql`, numbered, never edited once merged.

## 5. Secrets hygiene

- A secret value has exactly one lifetime: fetched from the backend, passed to the adapter, discarded. Never cached to disk, never logged, never placed on a span, never stored in an audit row, never included in an error.
- `Credentials` objects override `toString`, `toJSON`, and `util.inspect.custom` to render `[redacted]`. This has saved every project that has done it.
- A CI job greps build output, log fixtures, and test snapshots for secret-shaped strings and fails on a hit.

## 6. Commits and pull requests

Conventional commits: `feat(broker): ...`, `fix(policy): ...`, `test(invariants): ...`, `docs(threat-model): ...`.

Every pull request description lists the identifiers it implements, for example `Implements FR-22, FR-23. Tests INV-4.` A pull request touching the broker, the policy package, or the isolation package must state which invariants it could affect and why it does not break them.

Milestones end on tags `m0` through `m5`.

## 7. Documentation

Documentation in `docs/` is normative. Code that contradicts it is a bug in one of the two, resolved explicitly, never left to drift. A pull request that changes an API, a schema, or a security property updates the relevant document in the same pull request.

`13-DECISIONS.md` is append-only. A decision that closes off an alternative goes in it, with the alternative named.

## 8. Prose style

This applies to the README, code comments, commit messages, and every document here.

- Plain and direct. Short sentences over compressed ones.
- No marketing adjectives: seamless, robust, powerful, cutting-edge, enterprise-grade.
- No em dashes.
- No inflated significance: nothing "represents a shift" or "underscores the importance" of anything.
- Do not use three examples where two will do.
- Say the limitation. A README that lists what the system does not protect against is more credible than one that does not, and this project's entire argument is about credibility.

## 9. Dependencies

Adding a dependency to `apps/broker`, `packages/policy`, or `packages/isolation` requires an ADR. These three are the reviewed surface and every transitive dependency is part of the trust base. Elsewhere, normal judgement applies.
