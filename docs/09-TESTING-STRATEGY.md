# 09 - Testing strategy

## 1. Layers

| Layer | Tool | Rule |
|---|---|---|
| Unit | Vitest | Pure logic only: parsers, redactors, schema helpers |
| Integration | Vitest + testcontainers | Real Postgres, ClickHouse, Redis, MinIO. No mocking anywhere on the security path. |
| Invariant | Vitest, `tests/invariants/` | One file per INV. Non-skippable. |
| Adversarial | Vitest, `tests/adversarial/` | Attacks written from the attacker's point of view |
| Policy | `opa test` | One `_test.rego` per policy file |
| End to end | Vitest + both drivers | Full session lifecycle |
| UI | Playwright | Approval flow including timeout |
| Load | k6 or autocannon | Concurrency and p99 |

## 2. The mocking rule

You may mock an external service. You may never mock the policy engine, the secret backend, the audit writer, the transport binding, or the isolation driver in a test that asserts an invariant. Mocking a control in the test that proves the control works is how security test suites become decorative.

## 3. Invariant tests

Files are named for their invariant: `INV-1.spec.ts` through `INV-8.spec.ts`. Each begins with a comment quoting the invariant text from `06-THREAT-MODEL.md`.

They run against both drivers. Where the container driver cannot satisfy an invariant, the test asserts the driver correctly reports `hardwareIsolation: false` and is refused in production mode, rather than being skipped. A skipped security test reads as a passing one to everybody scanning CI.

CI configuration must make these unskippable: no `.skip`, no `.only`, no conditional exclusion. Add a lint rule that fails the build if `skip` appears in `tests/invariants/`.

## 4. Adversarial suite

Target: at least forty distinct attempts across eight categories by the end of M-5.

| Category | Examples |
|---|---|
| Network escape | Raw TCP, UDP DNS, IP literal, IPv6, ICMP, cloud metadata endpoint, host interface, DNS rebinding |
| Credential extraction | Filesystem grep, environment dump, process table, memory scrape, error-message probing, timing probe on the broker |
| Policy evasion | SQL comment obfuscation, encoding, multi-statement, `EXECUTE` of constructed SQL, case mixing, URL allowlist bypass via redirect, path traversal in an allowlisted URL |
| Approval forgery | Fabricated approval message, replay of an observed approval, self-resolution, nonce guessing, race between timeout and decision |
| Audit suppression | Oversized params to break the writer, unicode that breaks the preview, flooding to cause backpressure, crash between started and completed |
| Resource exhaustion | Fork bomb, disk fill, memory balloon, infinite broker calls, giant response from a service |
| Path traversal | `..`, symlink, absolute path, race between check and use, unicode normalisation |
| Subprocess escape | `sh -c`, symlink to disallowed binary, PATH manipulation, `LD_PRELOAD`, uploaded binary, git subcommand outside the allowlist |

Each test asserts two things: the attempt failed, and the attempt was logged. An undetected failure is only half a defence.

**Keep a written record of attempts that succeeded before you fixed them.** `docs/adversarial-log.md`, one entry per success: what you tried, why it worked, what you changed. That list is more informative than the list of things that failed, and in an interview it is the single most convincing artefact in the repository.

## 5. The prompt injection test

`tests/adversarial/prompt-injection.spec.ts`. See `06-THREAT-MODEL.md` section 6. The model in this test is configured to comply with the injected instruction fully. The point is that compliance changes nothing.

Never weaken this test to make it pass. If it fails, the architecture is wrong.

## 6. Fault injection

A `FaultInjector` in `packages/testkit` can make any dependency fail on command. Required scenarios:

- ClickHouse unavailable during a brokered call: action fails, service never contacted.
- Vault unavailable: `SECRET_UNAVAILABLE`, nothing partial.
- Policy wasm fails to load: all actions denied, not allowed.
- Sandbox killed mid-action: session recovers from snapshot, agent told the truth.
- Broker killed mid-action: session terminates, audit shows `started` without `completed`, and the gap is detectable by sequence number.
- Redis lost: approvals in flight fail closed.

Every one asserts fail-closed. NFR-10.

## 7. Performance tests

In `benchmarks/`, each a runnable script that prints machine specifications with its results.

- `bench-boot.ts`: cold and warm session start, p50 and p99, both drivers.
- `bench-broker.ts`: broker overhead excluding downstream, by service, p50 and p99.
- `bench-policy.ts`: wasm evaluation latency across bundle sizes.
- `bench-concurrency.ts`: fifty concurrent sessions, boot contention, error rate.

Publish measured numbers only. If a target is missed, publish the miss and explain it. A missed target with an honest explanation is a better engineering signal than a target that was quietly adjusted.

## 8. CI gates

A pull request cannot merge unless: typecheck passes, lint passes, `opa test` passes, unit and integration pass, all eight invariant tests pass, the adversarial suite passes, no secret-shaped string appears in any log fixture, and coverage on `apps/broker` and `packages/policy` is above ninety percent.

## 9. What not to test

Do not write tests that assert the model behaves well. Model behaviour is not a control. Test the mechanism that holds regardless of what the model does.
