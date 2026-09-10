export const RESUME_PLAN_STEP_IDS = [
  "mine",
  "jd-analysis",
  "preflight",
  "write",
  "review",
  "interview",
] as const;

export type ResumePlanStepId = (typeof RESUME_PLAN_STEP_IDS)[number];

export type ResumePlanStep = {
  id: ResumePlanStepId;
  rationale: string;
};

export const GOVERNANCE_REASON_CODES = [
  "OUT_OF_SCOPE_GOAL",
  "UNBOUNDED_PLAN",
  "FORBIDDEN_ACTION",
  "APPROVAL_REQUIRED",
  "FALLBACK_NOT_ALLOWED",
  "NON_RETRYABLE_BACKEND_ERROR",
  "REVIEW_BUDGET_EXHAUSTED",
] as const;

export type GovernanceReasonCode = (typeof GOVERNANCE_REASON_CODES)[number];

export type GovernanceReason = {
  code: GovernanceReasonCode;
  message: string;
  metadata?: Record<string, unknown>;
};

export type PolicyOutcome<TValue> =
  | {
      ok: true;
      value: TValue;
      reasons: GovernanceReason[];
    }
  | {
      ok: false;
      value: null;
      reasons: GovernanceReason[];
    };

export type ResumeGoalPlanInput = {
  goal: string;
  hasTimelineContext?: boolean;
  includeInterview?: boolean;
  requestedReviewRounds?: number | "unbounded" | null;
};

export type BoundedResumeGoalPlan = {
  goalFamily: "resume-workflow";
  goal: string;
  steps: ResumePlanStep[];
  maxSteps: number;
  reviewMode: "single-pass";
};

export type PolicyRiskLevel = "low" | "medium" | "high";

export const OPTIMIZATION_ACTIONS = [
  "PASS",
  "ASK_USER",
  "REWRITE_SECTION",
  "KEYWORD_OPTIMIZE",
  "DROP_UNSUPPORTED_CLAIM",
  "REORDER",
  "STOP",
] as const;

export type OptimizationAction = (typeof OPTIMIZATION_ACTIONS)[number];

export type OptimizationDecision = {
  issueKey?: string;
  targetNode?: { nodeId: string } | { profileField: string } | null;
  evidenceVersion?: number;
  action: string;
  target: string | null;
  reason: string;
  evidenceRefs: string[];
  expectedImprovement: string;
  risk: PolicyRiskLevel;
};

export type OptimizationActionHistoryItem = {
  issueKey?: string;
  targetNode?: { nodeId: string } | { profileField: string } | null;
  evidenceVersion?: number;
  action: string;
  target: string | null;
};

export type OptimizationPreflightDecision = {
  decision: "PROCEED" | "ASK_USER" | "STOP_UNSUPPORTED";
  missingEvidence: string[];
  unsupportedTargets: string[];
};

export const OPTIMIZATION_ROUTE_REASON_CODES = [
  "ACTION_NOT_ALLOWLISTED",
  "PASS_CONFLICTS_WITH_REVIEW",
  "PASS_SELECTED",
  "STOP_SELECTED",
  "ASK_USER_SELECTED",
  "BUDGET_EXHAUSTED",
  "REPEATED_ACTION",
  "EVIDENCE_REQUIRED",
  "UNRESOLVED_EVIDENCE_GAP",
  "QUESTION_BUDGET_EXHAUSTED",
  "UNSUPPORTED_TARGET_REINFORCEMENT",
  "PREFLIGHT_NOT_PROCEED",
  "HIGH_RISK_REQUIRES_USER_INPUT",
  "FORBIDDEN_QUALIFICATION_QUESTION",
  "INVALID_ISSUE_BINDING",
  "QUESTION_ALREADY_HANDLED",
] as const;

export type OptimizationRouteReasonCode =
  (typeof OPTIMIZATION_ROUTE_REASON_CODES)[number];

export type OptimizationRouteInput = {
  strengthensRestrictedClaim?: boolean;
  questionProposalAllowed?: boolean;
  reviewReport: Record<string, unknown>;
  decision: OptimizationDecision;
  actionHistory: OptimizationActionHistoryItem[];
  preflightDecision: OptimizationPreflightDecision;
  remainingBudget: number;
  canAskUser?: boolean;
  issueBindingValid?: boolean;
  currentArtifactPaths: {
    resumePath: string;
    reviewPath: string;
  };
};

export type RoutedOptimizationDecision = {
  allowed: boolean;
  action: string;
  normalizedTarget: string | null;
  reasonCodes: OptimizationRouteReasonCode[];
  /**
   * When allowed: whether executing the routed action ends the review loop.
   * When rejected (allowed=false): whether the rejection is terminal for the
   * whole run (budget/preflight facts no alternative proposal can change).
   * A non-terminal rejection (shouldStop=false) rejects only the current
   * proposal and the caller may re-select once for the same review report.
   */
  shouldStop: boolean;
};

export type PolicyGateInput = {
  action: string;
  approvalGranted?: boolean;
};

export type PolicyGateDecision = {
  action: string;
  allowed: boolean;
  risk: PolicyRiskLevel;
  reasons: GovernanceReason[];
};

export const BACKEND_PROVIDERS = [
  "claude",
  "opencode",
  "codex",
  "openai-chat",
  "anthropic-api",
] as const;

export type BackendProvider = (typeof BACKEND_PROVIDERS)[number];

export const BACKEND_EXECUTION_MODES = ["live", "stub", "replay"] as const;

export type BackendExecutionMode = (typeof BACKEND_EXECUTION_MODES)[number];

export type FallbackableError = {
  code: string;
  message: string;
  retryable: boolean;
};

export type FallbackPolicyConfig = {
  fallbackByProvider?: Partial<Record<BackendProvider, BackendProvider>>;
  providerOrder?: BackendProvider[];
};

export type FallbackPolicyInput = {
  provider: BackendProvider;
  mode: BackendExecutionMode;
  error: FallbackableError;
  config?: FallbackPolicyConfig;
};

export type FallbackPolicyDecision = {
  shouldFallback: boolean;
  fromProvider: BackendProvider;
  toProvider: BackendProvider | null;
  mode: BackendExecutionMode;
  reasons: GovernanceReason[];
};

export type SupervisorDecisionKind =
  | "continue"
  | "replan"
  | "escalate"
  | "complete";

export type SupervisorInput = {
  currentStep: ResumePlanStepId;
  status: "succeeded" | "failed";
  reviewPassed?: boolean;
  reviewReplansUsed?: number;
  reviewReplanBudget?: number;
};

export type SupervisorDecision = {
  decision: SupervisorDecisionKind;
  reasons: GovernanceReason[];
  nextPlan: ResumePlanStep[] | null;
};
