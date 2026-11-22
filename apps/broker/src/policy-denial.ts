import type { PolicyDecisionResult } from "@caisson/policy";
import type { ErrorCode } from "@caisson/protocol";

export function policyDenialCode(decision: PolicyDecisionResult): ErrorCode {
  if (decision.matchedRules.includes("validity_window")) return "SESSION_EXPIRED";
  if (decision.matchedRules.includes("per_method_rate_limit")) return "RATE_LIMITED";
  if (decision.decision === "require_approval") return "APPROVAL_REQUIRED";
  return "POLICY_DENIED";
}
