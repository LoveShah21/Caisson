# 07 - Policy model

## 1. Why policy is separate

Authorisation logic scattered across tool implementations cannot be audited, cannot be tested as a unit, and cannot answer "what is this agent allowed to do" without reading every tool. Caisson puts all of it in one Rego bundle, versioned and signed, evaluated in one place.

## 2. Evaluation

Rego compiled to wasm, evaluated in-process in the broker via `@open-policy-agent/opa-wasm`. Target p99 under five milliseconds (NFR-3). Bundles are stored in Postgres and hot-reloaded on activation (FR-36). A session is always evaluated against the bundle recorded on its row, so activating a new bundle never changes the rules under a running session.

## 3. Input document

```jsonc
{
  "session": {
    "id": "018f...",
    "roles": ["analyst"],
    "scopes": ["warehouse.readonly", "github.repo.read"],
    "approvalMode": "rule",
    "validFrom": "2026-09-21T09:00:00Z",
    "expiresAt": "2026-09-21T09:30:00Z",
    "requestedBy": "love@example.com",
    "purpose": "Investigate failed checkouts",
    "metadata": { "ticket": "INC-2291" }
  },
  "action": {
    "service": "postgres",
    "method": "query",
    "sideEffecting": false,
    "scopeRequired": "warehouse.readonly",
    "params": { "sql": "SELECT count(*) FROM orders WHERE status='failed'" },
    "parsed": { "statementType": "SELECT", "tables": ["orders"], "hasWildcard": false, "limit": null }
  },
  "context": {
    "now": "2026-09-21T09:07:11Z",
    "actionCountThisSession": 14,
    "actionCountThisMethod": 6,
    "priorDenials": 1,
    "hardwareIsolated": true
  }
}
```

The broker computes `action.parsed` before evaluation. Rego must never parse SQL, URLs, or diffs itself; structured facts are the broker's job, decisions are Rego's job.

## 4. Output document

```jsonc
{
  "decision": "allow" | "deny" | "require_approval",
  "reason": "side-effecting method under rule mode",
  "obligations": ["redact_pii", "role:readonly", "limit_rows:1000"]
}
```

Obligations are the important part. A policy that can only say yes or no forces you to write two rules where one would do. `role:readonly` means allow but downgrade the credential. `limit_rows:1000` means allow but cap. `redact_pii` means allow but scrub the response.

Supported obligations in v1: `redact_pii`, `role:<name>`, `limit_rows:<n>`, `timeout_ms:<n>`, `notify:<channel>`.

Unknown obligation: fail closed with `POLICY_UNAVAILABLE`. An obligation the broker cannot honour must never be quietly ignored.

## 5. Decision precedence

1. Any `deny` rule matching wins outright.
2. Otherwise, if any `require_approval` rule matches, the decision is `require_approval`.
3. Otherwise, if an `allow` rule matches, `allow`.
4. Otherwise, default deny with reason `no matching allow rule`.

Default deny is not configurable.

## 6. Bundle layout

```
policies/
  main.rego            # entrypoint, precedence, default deny
  scopes.rego          # scope-to-method mapping
  sql.rego             # statement-type rules
  time.rego            # validity windows and business hours
  rate.rego            # per-session and per-method limits
  escalation.rego      # what requires approval
  redaction.rego       # when to attach redact_pii
  *_test.rego          # one test file per policy file
```

## 7. Examples

```rego
package caisson.scopes

import data.caisson.helpers

deny contains msg if {
  not helpers.has_scope(input.session.scopes, input.action.scopeRequired)
  msg := sprintf("scope %v required for %v.%v", [input.action.scopeRequired, input.action.service, input.action.method])
}
```

```rego
package caisson.sql

# FR-37: decide on the parsed statement type, never on the raw string
allow_statement contains "SELECT" if { true }

deny contains msg if {
  input.action.service == "postgres"
  input.action.parsed.statementType != "SELECT"
  not helpers.has_scope(input.session.scopes, "warehouse.write")
  msg := sprintf("statement type %v is not permitted", [input.action.parsed.statementType])
}

obligation contains "limit_rows:1000" if {
  input.action.parsed.statementType == "SELECT"
  input.action.parsed.limit == null
}
```

```rego
package caisson.escalation

require_approval contains reason if {
  input.action.sideEffecting
  input.session.approvalMode == "rule"
  reason := "side-effecting method under rule mode"
}

require_approval contains reason if {
  input.session.approvalMode == "always"
  reason := "session is in always-ask mode"
}
```

```rego
package caisson.rate

deny contains msg if {
  input.context.actionCountThisMethod > 100
  msg := "per-method rate limit exceeded for this session"
}
```

## 8. The SQL rule, explained

The naive version, which appears in a lot of agent-security writing, is a substring check for `DELETE` or `DROP`. It is defeated by `SELECT 'DELETE'`, by comments (`DEL/**/ETE`), by case, by encoding, and by `EXECUTE` of a constructed string.

Caisson parses the statement with a real SQL parser in the broker, extracts statement type, target tables, and whether a row limit is present, and hands those facts to Rego. Multi-statement input is rejected before parsing succeeds. Anything the parser cannot parse is denied, not allowed.

This is an acceptance criterion for M-3 and it has at least five evasion tests in `tests/adversarial/sql-evasion.spec.ts`.

## 9. Testing policy

Every `.rego` file has a `_test.rego` beside it. `opa test policies/` runs in CI and must pass before a bundle can be activated (the activation endpoint runs the tests itself, FR-39).

`POST /v1/policy/simulate` accepts a full input document and returns the decision with the matched rule names, so policy can be debugged without starting a session.

## 10. Authoring guidance

- Write the deny first. It is easier to reason about what must never happen.
- Prefer an obligation over a second rule. `allow` plus `role:readonly` beats two near-identical rules.
- Never write a rule that depends on a value the guest can influence. If you find yourself reading `input.action.params` to decide identity, stop.
- Put the reason in the message. The agent sees it, and a good reason is the difference between the agent adapting and the agent looping.
