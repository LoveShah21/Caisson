package caisson.bootstrap

import rego.v1

test_default_deny if {
  result := decision with input as {
    "session": {"scopes": ["warehouse.readonly"]},
    "action": {"scopeRequired": "warehouse.write"},
  }
  result.decision == "deny"
}

test_scope_allows if {
  result := decision with input as {
    "session": {"scopes": ["warehouse.readonly"]},
    "action": {"scopeRequired": "warehouse.readonly"},
  }
  result.decision == "allow"
}
