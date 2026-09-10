import {
  OPTIMIZATION_ACTIONS,
  type OptimizationAction,
  type OptimizationRouteInput,
  type OptimizationRouteReasonCode,
  type RoutedOptimizationDecision,
} from "./types.js";

const MUTATING_ACTIONS = new Set<OptimizationAction>([
  "REWRITE_SECTION",
  "KEYWORD_OPTIMIZE",
  "DROP_UNSUPPORTED_CLAIM",
  "REORDER",
]);

const STRENGTHENING_ACTIONS = new Set<OptimizationAction>([
  "REWRITE_SECTION",
  "KEYWORD_OPTIMIZE",
]);

function isOptimizationAction(value: string): value is OptimizationAction {
  return OPTIMIZATION_ACTIONS.includes(value as OptimizationAction);
}

function normalizeTarget(value: string | null) {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

function route(
  input: Pick<RoutedOptimizationDecision, "allowed" | "action" | "shouldStop"> & {
    normalizedTarget: string | null;
    reasonCodes?: OptimizationRouteReasonCode[];
  },
): RoutedOptimizationDecision {
  return {
    allowed: input.allowed,
    action: input.action,
    normalizedTarget: input.normalizedTarget,
    reasonCodes: input.reasonCodes ?? [],
    shouldStop: input.shouldStop,
  };
}

function getReviewVerdict(reviewReport: Record<string, unknown>) {
  if (reviewReport.schemaVersion === 2) {
    return typeof reviewReport.verdict === "string"
      ? reviewReport.verdict
      : null;
  }
  const overall = reviewReport.overall;
  if (!overall || typeof overall !== "object" || Array.isArray(overall)) {
    return null;
  }
  const verdict = Reflect.get(overall, "verdict");
  return typeof verdict === "string" ? verdict : null;
}

function reviewPassed(reviewReport: Record<string, unknown>) {
  if (reviewReport.schemaVersion === 2) {
    return reviewReport.verdict === "PASS";
  }
  const overall = reviewReport.overall;
  return Boolean(
    overall &&
      typeof overall === "object" &&
      !Array.isArray(overall) &&
      Reflect.get(overall, "pass") === true,
  );
}

function referencesReviewOnlyData(evidenceRefs: string[]) {
  return evidenceRefs.some((reference) =>
    /^(?:review(?:\.|$)|topissues?\b|issue(?:ref)?\s*[:.=]|i\d+\b)/iu.test(
      reference.trim(),
    ),
  );
}

function referencesNonSourceData(evidenceRefs: string[]) {
  return evidenceRefs.some((reference) => {
    const normalized = reference.trim().toLowerCase();
    return (
      normalized.startsWith("jd.") ||
      normalized.startsWith("jdanalysis.") ||
      normalized.startsWith("optimizationdecision.") ||
      normalized.startsWith("preflight.") ||
      normalized.startsWith("currentresume.") ||
      normalized.startsWith("resumepath") ||
      normalized.startsWith("sourcereviewpath")
    );
  });
}

export function isForbiddenQualificationQuestion(value: string | null | undefined) {
  if (!value) return false;
  const question = value.trim();
  return /(?:请(?:提供|确认|说明|告知)|是否|能否|可否|满足|符合).{0,24}(?:学历|学位|学校(?:背景|要求)?|在读|毕业(?:状态|时间|日期)?|专业(?:或|和)?学历门槛|正式实习资格|到岗|实习资格|连续实习|实习持续|实习.*(?:几个月|多久|时长)|每周.*(?:出勤|到岗)|出勤.*(?:天|小时)|时间要求|internship eligibility|internship duration|internship continuity|weekly attendance|onboarding date|start date)/iu.test(question);
}

export function isRoleInfoQuestion(value: string | null | undefined) {
  if (!value || isForbiddenQualificationQuestion(value)) return false;
  return /(目标岗位|目标职位|岗位|职位|JD|职位描述|招聘要求|工作职责|岗位职责|目标方向|role|job description|responsibilit(?:y|ies)|requirement)/iu.test(value);
}

function targetsUnsupportedClaim(target: string | null, unsupported: string[]) {
  if (!target) {
    return false;
  }
  const normalizedTarget = target.toLowerCase();
  return unsupported.some((item) => {
    const normalizedItem = item.trim().toLowerCase();
    return (
      normalizedItem.length > 0 &&
      (normalizedTarget.includes(normalizedItem) ||
        normalizedItem.includes(normalizedTarget))
    );
  });
}

function isRepeatedAction(
  action: OptimizationAction,
  target: string | null,
  history: OptimizationRouteInput["actionHistory"],
  decision: OptimizationRouteInput["decision"],
) {
  if (decision.issueKey !== undefined) {
    return history.some((entry) => entry.issueKey === decision.issueKey
      && JSON.stringify(entry.targetNode ?? null) === JSON.stringify(decision.targetNode ?? null)
      && entry.evidenceVersion === decision.evidenceVersion);
  }
  const previous = history.at(-1);
  return (
    previous?.action === action && normalizeTarget(previous.target) === target
  );
}

/**
 * Rejection semantics: an `allowed: false` route with `shouldStop: true` is a
 * terminal rejection (the whole run must stop because no alternative proposal
 * can change the underlying fact, e.g. exhausted action budget or a preflight
 * gate that never opened). An `allowed: false` route with `shouldStop: false`
 * rejects only the current proposal; the caller may ask the reviewer to pick a
 * different action once for the same review report.
 */
export function routeOptimizationDecision(
  input: OptimizationRouteInput,
): RoutedOptimizationDecision {
  const selectedAction = input.decision.action.trim().toUpperCase();
  const normalizedTarget = normalizeTarget(input.decision.target);
  if (input.issueBindingValid === false) {
    return route({ allowed: false, action: "STOP", normalizedTarget, reasonCodes: ["INVALID_ISSUE_BINDING"], shouldStop: false });
  }

  if (!isOptimizationAction(selectedAction)) {
    return route({
      allowed: false,
      action: "STOP",
      normalizedTarget,
      reasonCodes: ["ACTION_NOT_ALLOWLISTED"],
      shouldStop: false,
    });
  }

  if (selectedAction === "PASS") {
    if (!reviewPassed(input.reviewReport)) {
      return route({
        allowed: false,
        action: "STOP",
        normalizedTarget: null,
        reasonCodes: ["PASS_CONFLICTS_WITH_REVIEW"],
        shouldStop: false,
      });
    }
    return route({
      allowed: true,
      action: selectedAction,
      normalizedTarget: null,
      reasonCodes: ["PASS_SELECTED"],
      shouldStop: true,
    });
  }

  if (selectedAction === "STOP") {
    return route({
      allowed: true,
      action: selectedAction,
      normalizedTarget: null,
      reasonCodes: ["STOP_SELECTED"],
      shouldStop: true,
    });
  }

  if (selectedAction === "ASK_USER") {
    if (input.questionProposalAllowed === false) {
      return route({ allowed: false, action: "STOP", normalizedTarget, reasonCodes: ["QUESTION_ALREADY_HANDLED"], shouldStop: false });
    }
    if (input.questionProposalAllowed === undefined && isForbiddenQualificationQuestion(normalizedTarget)) {
      return route({
        allowed: false,
        action: "STOP",
        normalizedTarget,
        reasonCodes: ["FORBIDDEN_QUALIFICATION_QUESTION"],
        shouldStop: false,
      });
    }
    if (input.canAskUser === false) {
      return route({
        allowed: false,
        action: "STOP",
        normalizedTarget,
        reasonCodes: ["QUESTION_BUDGET_EXHAUSTED"],
        shouldStop: false,
      });
    }
    return route({
      allowed: true,
      action: selectedAction,
      normalizedTarget,
      reasonCodes: ["ASK_USER_SELECTED"],
      shouldStop: true,
    });
  }

  if (selectedAction === "DROP_UNSUPPORTED_CLAIM") {
    if (input.preflightDecision.decision !== "PROCEED" || input.remainingBudget <= 0) {
      return route({ allowed: false, action: "STOP", normalizedTarget, reasonCodes: [input.remainingBudget <= 0 ? "BUDGET_EXHAUSTED" : "PREFLIGHT_NOT_PROCEED"], shouldStop: true });
    }
    if (isRepeatedAction(selectedAction, normalizedTarget, input.actionHistory, input.decision)) {
      return route({
        allowed: false,
        action: "STOP",
        normalizedTarget,
        reasonCodes: ["REPEATED_ACTION"],
        shouldStop: false,
      });
    }
    return route({
      allowed: true,
      action: selectedAction,
      normalizedTarget,
      reasonCodes: [],
      shouldStop: false,
    });
  }

  if (input.preflightDecision.decision !== "PROCEED") {
    return route({
      allowed: false,
      action: "STOP",
      normalizedTarget,
      reasonCodes: ["PREFLIGHT_NOT_PROCEED"],
      shouldStop: true,
    });
  }

  if (input.remainingBudget <= 0) {
    return route({
      allowed: false,
      action: "STOP",
      normalizedTarget,
      reasonCodes: ["BUDGET_EXHAUSTED"],
      shouldStop: true,
    });
  }

  if (isRepeatedAction(selectedAction, normalizedTarget, input.actionHistory, input.decision)) {
    return route({
      allowed: false,
      action: "STOP",
      normalizedTarget,
      reasonCodes: ["REPEATED_ACTION"],
      shouldStop: false,
    });
  }

  if (
    (selectedAction === "REWRITE_SECTION" ||
      selectedAction === "KEYWORD_OPTIMIZE") &&
    input.decision.evidenceRefs.length === 0
  ) {
    return route({
      allowed: false,
      action: "STOP",
      normalizedTarget,
      reasonCodes: ["EVIDENCE_REQUIRED"],
      shouldStop: false,
    });
  }

  if (
    STRENGTHENING_ACTIONS.has(selectedAction) &&
    (referencesReviewOnlyData(input.decision.evidenceRefs) ||
      referencesNonSourceData(input.decision.evidenceRefs))
  ) {
    return route({
      allowed: false,
      action: "STOP",
      normalizedTarget,
      reasonCodes: ["UNRESOLVED_EVIDENCE_GAP"],
      shouldStop: false,
    });
  }

  if (
    STRENGTHENING_ACTIONS.has(selectedAction) &&
    (input.strengthensRestrictedClaim ?? targetsUnsupportedClaim(
      normalizedTarget,
      input.preflightDecision.unsupportedTargets,
    ))
  ) {
    return route({
      allowed: false,
      action: "STOP",
      normalizedTarget,
      reasonCodes: ["UNSUPPORTED_TARGET_REINFORCEMENT"],
      shouldStop: false,
    });
  }

  if (!MUTATING_ACTIONS.has(selectedAction)) {
    return route({
      allowed: false,
      action: "STOP",
      normalizedTarget,
      reasonCodes: ["ACTION_NOT_ALLOWLISTED"],
      shouldStop: false,
    });
  }

  return route({
    allowed: true,
    action: selectedAction,
    normalizedTarget,
    shouldStop: false,
  });
}
