import type {
  GovernanceReason,
  GovernanceReasonCode,
  PolicyOutcome,
} from "./types.js";

export function createGovernanceReason(
  code: GovernanceReasonCode,
  message: string,
  metadata?: Record<string, unknown>,
): GovernanceReason {
  return {
    code,
    message,
    ...(metadata ? { metadata } : {}),
  };
}

export function allowPolicy<TValue>(value: TValue): PolicyOutcome<TValue> {
  return {
    ok: true,
    value,
    reasons: [],
  };
}

export function denyPolicy<TValue = never>(
  ...reasons: GovernanceReason[]
): PolicyOutcome<TValue> {
  return {
    ok: false,
    value: null,
    reasons,
  };
}
