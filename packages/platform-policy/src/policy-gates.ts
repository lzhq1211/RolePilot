import { createGovernanceReason } from "./governance-reasons.js";
import type {
  GovernanceReason,
  PolicyGateDecision,
  PolicyGateInput,
} from "./types.js";

const FORBIDDEN_ACTIONS = new Set([
  "run-shell-command",
  "send-email",
  "publish-publicly",
  "self-modify-policy",
]);

const HIGH_RISK_ACTIONS = new Set([
  "share-resume-externally",
  "submit-resume",
  "export-resume-with-pii",
]);

export function evaluatePolicyGate(input: PolicyGateInput): PolicyGateDecision {
  const action = String(input.action ?? "").trim().toLowerCase();
  const reasons: GovernanceReason[] = [];

  if (FORBIDDEN_ACTIONS.has(action)) {
    reasons.push(
      createGovernanceReason(
        "FORBIDDEN_ACTION",
        "This action is outside the bounded resume policy surface.",
        { action },
      ),
    );

    return {
      action,
      allowed: false,
      risk: "high",
      reasons,
    };
  }

  if (HIGH_RISK_ACTIONS.has(action) && input.approvalGranted !== true) {
    reasons.push(
      createGovernanceReason(
        "APPROVAL_REQUIRED",
        "This high-risk resume action requires explicit approval.",
        { action },
      ),
    );

    return {
      action,
      allowed: false,
      risk: "high",
      reasons,
    };
  }

  return {
    action,
    allowed: true,
    risk: HIGH_RISK_ACTIONS.has(action) ? "high" : "low",
    reasons,
  };
}
