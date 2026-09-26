# 11 - Roadmap and milestones

Eight weeks. Each milestone ends with: passing tests, updated documentation, a tagged commit, and a short written report of what was measured. Do not begin a milestone before the previous one's acceptance gate is green.

## M-0. Foundations (days 1 to 3)

pnpm workspace, Turborepo, strict TypeScript, `packages/protocol` with the error enum and core schemas, `packages/telemetry`, Postgres migrations for `sessions`, `session_tokens`, `policy_bundles`, docker-compose for dependencies, CI skeleton with typecheck and lint.

**Gate:** `docker compose up` brings up Postgres, ClickHouse, Redis, MinIO, and the OTel collector. `pnpm test` runs and passes with zero tests. CI is green.

## M-1. Isolation and lifecycle (weeks 1 to 2)

FR-1 to FR-17 and FR-62. `IsolationDriver`, both implementations, session state machine, snapshot build and restore, base snapshot scheduler, session reaper, boot spans, network policy, and the host-side egress monitor.

**Gate:**
- A session boots, runs `IsolationDriver.exec(["/bin/echo","hello"])` through the temporary M-1 development probe, returns its output, and destroys cleanly on both drivers. This is a driver-mechanism check, not an INV-8 test.
- INV-7 passes. INV-8 begins in M-3 with the real guest-side agent runtime `exec` tool and its allowlist.
- Production mode refuses to start on the container driver (FR-11).
- `bench-boot.ts` exists and cold and warm numbers are recorded in `benchmarks/results/`.

## M-2. Broker and credential brokering (weeks 3 to 4)

FR-18 to FR-28, FR-30 to FR-32, and the postgres, http, and s3 portion of FR-29. vsock transport, transport binding, `SecretBackend` with Vault and env implementations, three adapters (postgres, http, s3), connection pooling, timeouts, the error taxonomy. The github and slack portion of FR-29 is scheduled in M-4.

**Gate:**
- An agent queries Postgres successfully with no credential present in the guest.
- INV-1, INV-2, INV-3, INV-5 pass.
- Forged identity fields in guest requests change nothing.
- `bench-broker.ts` records overhead against NFR-2.

## M-3. Policy and agent runtime (week 5)

FR-33 to FR-45. OPA wasm evaluator, bundle storage and activation with test gating, obligations, SQL parsing in the broker, the seven-tool runtime, skills loader, structured denials.

**Gate:**
- `opa test policies/` passes in CI.
- A denial reaches the agent structured and the reference loop adapts rather than retrying identically.
- `tests/adversarial/sql-evasion.spec.ts` contains at least five evasion attempts, all denied.
- `POST /v1/policy/simulate` returns a decision with matched rule names.

## M-4. Approvals and interception (weeks 6 to 7)

FR-46 to FR-54, FR-59 to FR-61, and the github and slack portion of FR-29. Websocket hub, approval queue with timeout, signed decisions, approval UI, redaction pipeline, mitmproxy interceptor, github adapter, and slack adapter. Github supplies the `createPullRequest` approval journey. Slack supplies approver notifications and the notify obligation.

**Gate:**
- An `always` mode session blocks on every action and resumes on approve.
- Timeout fails closed with `APPROVAL_TIMEOUT`.
- INV-6 passes, including replay and self-resolution attempts.
- `git fetch` works in the guest with no credential present.
- Playwright covers approve, deny, and timeout.
- An approver sees a sentence, not JSON.

## M-5. Audit, observability, documentation (week 8)

FR-55 to FR-58, all of `10-OBSERVABILITY.md`. ClickHouse schema and writers, the three canned queries, materialised views, Grafana dashboards provisioned as code, alerts, README, threat model published, demo recording.

**Gate:**
- INV-4 passes including the fault-injection case.
- All eight invariant tests green in CI.
- All five required adapters pass their contract and integration tests.
- Adversarial suite at forty or more attempts across eight categories.
- `docs/adversarial-log.md` documents every attempt that initially succeeded.
- Sequence-gap alert fires in a test.
- A ninety-second demo video shows a real task, a policy denial, and an approval.
- README limitations section is written and honest.

## Stretch, in priority order

1. **Session replay.** Reconstruct a session from the audit trail and re-run it against mocked services. Needs full params retained under encryption; decide retention deliberately.
2. **eBPF interceptor.** Replace mitmproxy on the hot path. The impressive one. Do not start it until M-5 is closed, and keep mitmproxy working as the fallback.
3. **Policy learning.** Cluster repeatedly-approved actions, propose Rego rules, never auto-apply them.
4. **Multi-tenancy.** Tenant column across both stores, per-tenant credential namespaces, tenant-scoped audit access, isolation test between tenants. Real schema work; do not bolt it on.

## Deliberately deferred

HA control plane, SSO, billing, a hosted service, a Kubernetes operator, agent framework integrations beyond the reference loop.

## Scope discipline

Two risks will try to eat this project.

The first is the eBPF interceptor. It is the most technically impressive component and the most likely to consume three weeks with nothing shippable. It is a stretch item and stays one.

The second is adapter sprawl. Five adapters prove the pattern. A sixth teaches you nothing and costs a week. If you want to spend that week on something, spend it on the adversarial suite.
