package caisson.bootstrap

import rego.v1

default decision := {
  "decision": "deny",
  "reason": "no matching scope",
  "obligations": [],
}

decision := {
  "decision": "allow",
  "reason": "required scope present",
  "obligations": [],
} if {
  input.action.scopeRequired != ""
  input.action.scopeRequired in input.session.scopes
}
