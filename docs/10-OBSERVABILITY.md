# 10 - Observability

## 1. Principle

One trace per session. Every action is a span inside it. If an incident responder has the session id, they should be able to reconstruct the whole thing without asking anyone a question.

## 2. Span conventions

| Span | Parent | Key attributes |
|---|---|---|
| `caisson.session.create` | root | `session.id`, `session.scopes`, `driver`, `hardware_isolated` |
| `caisson.sandbox.boot` | session.create | `snapshot.ref`, `boot.kind` (cold/warm), `boot.ms` |
| `caisson.broker.call` | session.create | `service`, `method`, `decision`, `action.id`, `scope.used`, `role.used` |
| `caisson.policy.eval` | broker.call | `bundle.version`, `decision`, `obligations`, `eval.ms` |
| `caisson.approval.wait` | broker.call | `approval.id`, `wait.ms`, `outcome` |
| `caisson.service.<name>.<method>` | broker.call | `duration.ms`, `result.bytes`, `retries` |
| `caisson.redaction` | broker.call | `count`, `detectors.fired` |
| `caisson.audit.write` | broker.call | `event.type`, `write.path` (direct/buffer), `write.ms` |
| `caisson.audit.buffer` | broker.call | `event.type`, `buffer.kind`, `enqueue.ms` |
| `caisson.guest.exec` | session.create | `binary`, `exit.code`, `duration.ms` |
| `caisson.egress.denied` | session.create | `network.destination`, `network.protocol` |
| `caisson.snapshot.build` | root | `kind`, `size.bytes`, `build.ms` |

Rules:
- Span attributes never carry parameter values, only hashes, sizes, and types. NFR-8.
- `trace_id` and `span_id` are written into every ClickHouse audit row (FR-58), so a trace and the audit record join cleanly.
- Sampling is off for security-relevant spans. You do not sample the audit trail.

## 3. Metrics

| Metric | Type | Labels |
|---|---|---|
| `caisson_sandbox_boot_ms` | histogram | `kind`, `driver` |
| `caisson_broker_overhead_ms` | histogram | `service`, `method` |
| `caisson_policy_eval_ms` | histogram | `bundle_version` |
| `caisson_audit_write_ms` | histogram | `phase` |
| `caisson_approval_wait_seconds` | histogram | `service`, `outcome` |
| `caisson_actions_total` | counter | `action_type`, `service`, `decision` |
| `caisson_redactions_total` | counter | `detector` |
| `caisson_sessions_active` | gauge | `driver` |
| `caisson_session_duration_seconds` | histogram | `termination_reason` |
| `caisson_fail_closed_total` | counter | `component` |
| `caisson_audit_completion_buffer_depth` | gauge | `buffer_kind` |
| `caisson_audit_orphaned_actions_total` | counter | `action_type` |
| `caisson_network_denied_total` | counter | `protocol` |

`caisson_fail_closed_total` deserves comment. It counts every time the system refused rather than degraded. It should never be zero in a system under real use, and a sudden change in it is one of the more informative signals available.

## 4. Dashboards

Three Grafana dashboards, provisioned as code in `deploy/grafana/`.

**Sessions.** Active sessions, boot latency by kind and driver, session duration, termination reasons, concurrency.

**Security.** Decisions over time stacked by allow/deny/approval, denials by policy reason, top denied methods, approval rate and wait time, redaction volume, fail-closed counter, and a panel for sessions that ran without hardware isolation.

**Performance.** Broker overhead by service, policy eval latency, audit write latency, downstream service latency and error rate.

## 5. Alerts

| Alert | Condition |
|---|---|
| Audit store unreachable | any `AUDIT_UNAVAILABLE` in five minutes |
| Completion buffer backlog | any completion record remains buffered past the reconciliation threshold |
| Orphaned action | any `action.started` remains without a terminal row past the reconciliation threshold |
| Denial spike | denial rate above three standard deviations of the seven-day baseline |
| Approval starvation | any pending approval older than half its timeout |
| Unisolated production session | any session with `hardware_isolated = false` in production |
| Boot degradation | p99 warm boot above two seconds for ten minutes |
| Sequence gap | a session with non-contiguous `seq` values in `actions` |

The sequence-gap and orphaned-action alerts are the tripwires for INV-4. Either means the audit trail may be incomplete and requires reconciliation.

## 6. Audit reconciliation

A host-side job scans for `action.started` records without a matching terminal record past a configured threshold. It marks them orphaned, emits the orphaned-action metric and alert, and keeps them visible until an operator resolves the cause. In parallel, it drains durable completion-buffer entries to ClickHouse and removes an entry only after ClickHouse acknowledges the terminal row. Sequence gaps remain a separate check because they can expose a missing record that has no surviving start row.

## 7. What the operator sees live

Over the session websocket: status transitions, `agent.step` events with tool name and decision, approval requests and resolutions, and final output. Enough to watch a session happen without reading logs.
