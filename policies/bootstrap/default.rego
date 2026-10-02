package caisson.bootstrap

import rego.v1

default decision := {
  "decision": "deny",
  "reason": "no matching allow rule",
  "obligations": [],
  "matchedRules": ["default_deny"],
}

decision := {
  "decision": "deny",
  "reason": "session has expired",
  "obligations": [],
  "matchedRules": ["validity_window"],
} if {
  session_expired
}

decision := {
  "decision": "deny",
  "reason": "per-method rate limit exceeded for this session",
  "obligations": [],
  "matchedRules": ["per_method_rate_limit"],
} if {
  not session_expired
  method_rate_exceeded
}

decision := {
  "decision": "allow",
  "reason": "required scope present",
  "obligations": [],
  "matchedRules": ["scope_required"],
} if {
  not session_expired
  not method_rate_exceeded
  input.action.scopeRequired != ""
  input.action.scopeRequired in input.session.scopes
}

session_expired if {
  object.get(input.session, "validAtEvaluation", true) == false
}

method_rate_exceeded if {
  input.context.actionCountThisMethod >= 100
}
