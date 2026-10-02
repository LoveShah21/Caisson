package caisson.bootstrap

import rego.v1

test_default_deny if {
  result := decision with input as {
    "session": {"scopes": ["warehouse.readonly"], "expiresAt": ""},
    "action": {"scopeRequired": "warehouse.write"}, "context": {"actionCountThisMethod": 0},
  }
  result.decision == "deny"
}

test_scope_allows if {
  result := decision with input as {
    "session": {"scopes": ["warehouse.readonly"], "expiresAt": ""},
    "action": {"scopeRequired": "warehouse.readonly"}, "context": {"actionCountThisMethod": 0},
  }
  result.decision == "allow"
}

test_expired_session_denies if {
  result := decision with input as {
    "session": {"scopes": ["warehouse.readonly"], "expiresAt": "2026-01-01T00:00:00Z", "validAtEvaluation": false},
    "action": {"scopeRequired": "warehouse.readonly"},
    "context": {"now": "2026-01-02T00:00:00Z", "actionCountThisMethod": 0},
  }
  result.matchedRules == ["validity_window"]
}

test_rate_limit_denies if {
  result := decision with input as {
    "session": {"scopes": ["warehouse.readonly"], "expiresAt": ""},
    "action": {"scopeRequired": "warehouse.readonly"},
    "context": {"actionCountThisMethod": 100},
  }
  result.matchedRules == ["per_method_rate_limit"]
}
