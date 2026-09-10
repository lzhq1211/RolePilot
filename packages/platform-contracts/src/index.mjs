export const REVIEW_SCHEMA_VERSION = 2;
export const LEGACY_REVIEW_SCHEMA_VERSION = "v1";
export const PREFLIGHT_SCHEMA_VERSION = "v1";
export const OPTIMIZATION_DECISION_SCHEMA_VERSION = "v1";

export const FAILURE_POLICY_MODES = Object.freeze({
  MANUAL: "manual",
  LOCAL_CI: "local-ci",
  GITHUB_ACTIONS: "github-actions",
});

export const FAILURE_POLICY_MODE_ALIASES = Object.freeze({
  manual: FAILURE_POLICY_MODES.MANUAL,
  local: FAILURE_POLICY_MODES.MANUAL,
  "manual-local": FAILURE_POLICY_MODES.MANUAL,
  "local-manual": FAILURE_POLICY_MODES.MANUAL,
  ci: FAILURE_POLICY_MODES.LOCAL_CI,
  strict: FAILURE_POLICY_MODES.LOCAL_CI,
  "local-ci": FAILURE_POLICY_MODES.LOCAL_CI,
  "ci-like": FAILURE_POLICY_MODES.LOCAL_CI,
  gha: FAILURE_POLICY_MODES.GITHUB_ACTIONS,
  github: FAILURE_POLICY_MODES.GITHUB_ACTIONS,
  "github-actions": FAILURE_POLICY_MODES.GITHUB_ACTIONS,
});

export const REVIEW_STOP_REASONS = Object.freeze({
  PASS: "pass",
  EARLY_STOP: "early-stop",
  MAX_ROUNDS: "max-rounds",
});

export const PREFLIGHT_DECISIONS = Object.freeze([
  "PROCEED",
  "ASK_USER",
  "STOP_UNSUPPORTED",
]);

export const OPTIMIZATION_ACTIONS = Object.freeze([
  "PASS",
  "ASK_USER",
  "REWRITE_SECTION",
  "KEYWORD_OPTIMIZE",
  "DROP_UNSUPPORTED_CLAIM",
  "REORDER",
  "STOP",
]);

export const OPTIMIZATION_RISK_LEVELS = Object.freeze([
  "low",
  "medium",
  "high",
]);

export const REVIEW_V2_PRIORITIES = Object.freeze(["P0", "P1", "P2", "P3"]);
export const REVIEW_V2_CATEGORIES = Object.freeze([
  "UNSUPPORTED_CLAIM",
  "POSITIONING",
  "JD_COVERAGE",
  "EVIDENCE_PRESENTATION",
  "CONTENT_PRIORITY",
  "WORDING",
]);
export const REVIEW_V2_RESOLUTIONS = Object.freeze([
  "REWRITE_NOW",
  "NEEDS_CONFIRMATION",
  "CAPABILITY_GAP",
]);

// Keep compatibility at the boundary for semantically equivalent provider labels.
// The validator itself remains strict so unknown categories cannot be persisted.
export const REVIEW_V2_CATEGORY_ALIASES = Object.freeze({
  MATCH: "JD_COVERAGE",
  EVIDENCE: "EVIDENCE_PRESENTATION",
  PRIORITY: "CONTENT_PRIORITY",
  CREDIBILITY: "EVIDENCE_PRESENTATION",
  CLARITY: "WORDING",
});

export const BACKEND_PROVIDERS = Object.freeze([
  "claude",
  "opencode",
  "codex",
  "openai-chat",
  "anthropic-api",
]);
export const BACKEND_EXECUTION_MODES = Object.freeze([
  "live",
  "stub",
  "replay",
]);
export const AGENT_STUB_ENV_VAR = "ORCHESTRATE_AGENT_STUB_FILE";
export const BACKEND_CAPABILITY_VOCABULARY = Object.freeze({
  providers: BACKEND_PROVIDERS,
  executionModes: BACKEND_EXECUTION_MODES,
  configFields: Object.freeze([
    "tool",
    "model",
    "temperature",
    "maxTokens",
    "extraArgs",
  ]),
  stubEnvVar: AGENT_STUB_ENV_VAR,
});

export const EXECUTION_STATUSES = Object.freeze([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const ARTIFACT_KINDS = Object.freeze([
  "resume",
  "review-report",
  "optimization-decision",
  "preflight",
  "supplemental-evidence",
  "questions",
  "unsupported",
  "jd-analysis",
  "timeline",
  "interview",
  "cheatsheet",
  "log",
]);

export const LOG_EVENT_LEVELS = Object.freeze([
  "debug",
  "info",
  "warn",
  "error",
]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isNumberInRange(value, min, max) {
  return isFiniteNumber(value) && value >= min && value <= max;
}

function pushStringError(errors, path, value) {
  if (!isNonEmptyString(value)) {
    errors.push(`${path} must be a non-empty string`);
  }
}

function pushNumberRangeError(errors, path, value, min, max) {
  if (!isNumberInRange(value, min, max)) {
    errors.push(`${path} must be a number between ${min} and ${max}`);
  }
}

function pushArrayOfStringsError(errors, path, value, minItems = 0) {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }

  if (value.length < minItems) {
    errors.push(
      `${path} must contain at least ${minItems} item${minItems === 1 ? "" : "s"}`,
    );
  }

  value.forEach((item, index) => {
    if (!isNonEmptyString(item)) {
      errors.push(`${path}[${index}] must be a non-empty string`);
    }
  });
}

export function resolveFailurePolicyMode(env = process.env) {
  const explicit = String(env.ORCHESTRATE_FAILURE_MODE || "")
    .trim()
    .toLowerCase();

  if (explicit) {
    const resolved = FAILURE_POLICY_MODE_ALIASES[explicit];
    if (!resolved) {
      throw new Error(
        `无效 ORCHESTRATE_FAILURE_MODE: ${explicit}。可选值: manual, local-ci, github-actions`,
      );
    }
    return resolved;
  }

  if (String(env.GITHUB_ACTIONS || "").toLowerCase() === "true") {
    return FAILURE_POLICY_MODES.GITHUB_ACTIONS;
  }

  if (String(env.CI || "").toLowerCase() === "true") {
    return FAILURE_POLICY_MODES.LOCAL_CI;
  }

  return FAILURE_POLICY_MODES.MANUAL;
}

export function isStrictFailurePolicyMode(mode) {
  return mode !== FAILURE_POLICY_MODES.MANUAL;
}

function describeFailurePolicyMode(mode) {
  if (mode === FAILURE_POLICY_MODES.GITHUB_ACTIONS) {
    return "GitHub Actions";
  }
  if (mode === FAILURE_POLICY_MODES.LOCAL_CI) {
    return "local CI";
  }
  return "manual";
}

export function createReviewValidationOutcome(validation, mode) {
  if (validation?.valid) {
    return { shouldFail: false, message: null };
  }

  const errorText =
    (validation?.errors || []).join(", ") || "unknown validation error";
  if (isStrictFailurePolicyMode(mode)) {
    return {
      shouldFail: true,
      message: `审核输出不符合 Review schemaVersion ${REVIEW_SCHEMA_VERSION} 合同，${describeFailurePolicyMode(mode)} 模式已拒绝继续: ${errorText}`,
    };
  }

  return {
    shouldFail: false,
    message: `审核输出不符合 Review schemaVersion ${REVIEW_SCHEMA_VERSION} 合同，手动模式继续执行并保留错误详情: ${errorText}`,
  };
}

export function createPreflightValidationOutcome(validation, mode) {
  if (validation?.valid) {
    return { shouldFail: false, message: null };
  }

  const errorText =
    (validation?.errors || []).join(", ") || "unknown validation error";
  if (isStrictFailurePolicyMode(mode)) {
    return {
      shouldFail: true,
      message: `前置门控输出不符合 ${PREFLIGHT_SCHEMA_VERSION} 合同，${describeFailurePolicyMode(mode)} 模式已拒绝继续: ${errorText}`,
    };
  }

  return {
    shouldFail: false,
    message: `前置门控输出不符合 ${PREFLIGHT_SCHEMA_VERSION} 合同，手动模式继续执行并保留错误详情: ${errorText}`,
  };
}

export function validatePreflightDecision(data) {
  const errors = [];

  if (!isObject(data)) {
    return { valid: false, errors: ["preflight payload must be an object"] };
  }

  if ("preflightSchemaVersion" in data) {
    errors.push(
      `preflightSchemaVersion must not appear in payload; runtime contract is frozen as ${PREFLIGHT_SCHEMA_VERSION}`,
    );
  }

  if (!PREFLIGHT_DECISIONS.includes(data.decision)) {
    errors.push(
      `decision must be one of: ${PREFLIGHT_DECISIONS.join(", ")}`,
    );
  }

  pushNumberRangeError(errors, "confidence", data.confidence, 0, 1);
  pushArrayOfStringsError(errors, "missingEvidence", data.missingEvidence);
  if (data.eligibilityNotes !== undefined) {
    pushArrayOfStringsError(errors, "eligibilityNotes", data.eligibilityNotes);
  }
  pushArrayOfStringsError(
    errors,
    "blockingQuestions",
    data.blockingQuestions,
    data.decision === "ASK_USER" ? 1 : 0,
  );
  pushArrayOfStringsError(
    errors,
    "unsupportedTargets",
    data.unsupportedTargets,
    data.decision === "STOP_UNSUPPORTED" ? 1 : 0,
  );
  pushArrayOfStringsError(
    errors,
    "safeWritingScope",
    data.safeWritingScope,
    data.decision === "PROCEED" ? 1 : 0,
  );
  if (data.questionCandidates !== undefined) {
    if (!Array.isArray(data.questionCandidates)) errors.push("questionCandidates must be an array");
    else data.questionCandidates.forEach((item, index) => {
      if (!isObject(item)) { errors.push(`questionCandidates[${index}] must be an object`); return; }
      pushStringError(errors, `questionCandidates[${index}].question`, item.question);
      pushStringError(errors, `questionCandidates[${index}].expectedImprovement`, item.expectedImprovement);
      if (item.intent !== undefined && !["content_fact", "target_role", "qualification"].includes(item.intent)) errors.push(`questionCandidates[${index}].intent is invalid`);
      if (item.target !== undefined && item.target !== null && !isNonEmptyString(item.target)) errors.push(`questionCandidates[${index}].target must be null or a non-empty string`);
      if (item.sourceAssessment !== undefined && !["unanswered", "partial", "answered"].includes(item.sourceAssessment)) errors.push(`questionCandidates[${index}].sourceAssessment is invalid`);
    });
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true, data };
}

export function validateOptimizationDecision(data) {
  const errors = [];

  if (!isObject(data)) {
    return {
      valid: false,
      errors: ["optimization decision payload must be an object"],
    };
  }

  if ("optimizationDecisionSchemaVersion" in data) {
    errors.push(
      `optimizationDecisionSchemaVersion must not appear in payload; runtime contract is frozen as ${OPTIMIZATION_DECISION_SCHEMA_VERSION}`,
    );
  }

  if (!OPTIMIZATION_ACTIONS.includes(data.action)) {
    errors.push(`action must be one of: ${OPTIMIZATION_ACTIONS.join(", ")}`);
  }
  const hasMutationBinding = ["issueRef", "issueKey", "targetNode", "evidenceVersion"].some((key) => key in data);
  if (hasMutationBinding) {
    for (const key of ["issueRef", "issueKey", "targetNode", "evidenceVersion"]) {
      if (!(key in data)) errors.push(`${key} is required when optimization binding is present`);
    }
    pushStringError(errors, "issueRef", data.issueRef);
    pushStringError(errors, "issueKey", data.issueKey);
    if (!Number.isInteger(data.evidenceVersion) || data.evidenceVersion < 0) errors.push("evidenceVersion must be a non-negative integer");
    if (data.targetNode !== null && (!isObject(data.targetNode) || Object.keys(data.targetNode).length !== 1
      || !(isNonEmptyString(data.targetNode.nodeId) || isNonEmptyString(data.targetNode.profileField)))) errors.push("targetNode must be null, nodeId or profileField");
  }

  if (data.target !== null && !isNonEmptyString(data.target)) {
    errors.push("target must be null or a non-empty string");
  }
  pushStringError(errors, "reason", data.reason);
  pushArrayOfStringsError(errors, "evidenceRefs", data.evidenceRefs);
  pushStringError(errors, "expectedImprovement", data.expectedImprovement);
  if (!OPTIMIZATION_RISK_LEVELS.includes(data.risk)) {
    errors.push(
      `risk must be one of: ${OPTIMIZATION_RISK_LEVELS.join(", ")}`,
    );
  }

  if (data.action === "REWRITE_SECTION" && !isNonEmptyString(data.target)) {
    errors.push("target must identify a section for REWRITE_SECTION");
  }
  if (
    data.action === "KEYWORD_OPTIMIZE" &&
    (!Array.isArray(data.evidenceRefs) || data.evidenceRefs.length === 0)
  ) {
    errors.push("evidenceRefs must contain at least 1 item for KEYWORD_OPTIMIZE");
  }
  if (
    data.action === "DROP_UNSUPPORTED_CLAIM" &&
    !isNonEmptyString(data.target)
  ) {
    errors.push(
      "target must identify the unsupported claim for DROP_UNSUPPORTED_CLAIM",
    );
  }
  if (
    data.action === "ASK_USER" &&
    !isNonEmptyString(data.target) &&
    (!Array.isArray(data.evidenceRefs) || data.evidenceRefs.length === 0)
  ) {
    errors.push(
      "ASK_USER must identify a question in target or an evidence gap in evidenceRefs",
    );
  }
  if (data.action === "PASS" && data.target !== null) {
    errors.push("target must be null for PASS");
  }
  if (data.action === "STOP" && data.target !== null) {
    errors.push("target must be null for STOP");
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true, data };
}

function resolveMaxRounds(value) {
  return Number.isFinite(value) && value > 0 ? value : 3;
}

export function getReviewAverage(report) {
  if (isReviewReportV2(report)) {
    return Number.isInteger(report.overallScore) ? report.overallScore / 10 : 0;
  }
  const average = report?.overall?.average;
  return Number.isFinite(average) ? average : 0;
}

function countReviewPriority(report, priority) {
  const issues = Array.isArray(report?.topIssues) ? report.topIssues : [];
  return issues.reduce(
    (count, issue) => count + (issue?.priority === priority ? 1 : 0),
    0,
  );
}

function getGlobalFiveDimensionTotal(report) {
  const total = report?.globalFiveDimension?.total;
  return Number.isFinite(total) ? total : 0;
}

function countModuleReviewSeverity(report, severity) {
  const reviews = Array.isArray(report?.moduleReviews) ? report.moduleReviews : [];
  return reviews.reduce(
    (count, review) =>
      count + (review?.issueAnalysis?.severity === severity ? 1 : 0),
    0,
  );
}

function countSectionFeedbackSeverity(report, severity) {
  const feedback = Array.isArray(report?.sectionFeedback)
    ? report.sectionFeedback
    : [];
  return feedback.reduce(
    (count, item) => count + (item?.severity === severity ? 1 : 0),
    0,
  );
}

function countBlockingIssues(report) {
  return (
    (isNonEmptyString(report?.industryRoleCheck?.blockingIssue) ? 1 : 0) +
    countModuleReviewSeverity(report, "blocking")
  );
}

function countHighSeverityIssues(report) {
  return (
    countModuleReviewSeverity(report, "important") +
    countSectionFeedbackSeverity(report, "high")
  );
}

function countAtsEvidenceGaps(report) {
  const missingAtsKeywords = Array.isArray(report?.missingAtsKeywords)
    ? report.missingAtsKeywords.length
    : 0;
  const evidenceGap = Array.isArray(report?.evidenceGap)
    ? report.evidenceGap.length
    : 0;
  return missingAtsKeywords + evidenceGap;
}

function getNormalizedReviewSignals(report) {
  if (isReviewReportV2(report)) {
    return {
      schemaVersion: REVIEW_SCHEMA_VERSION,
      p0: countReviewPriority(report, "P0"),
      p1: countReviewPriority(report, "P1"),
      p2: countReviewPriority(report, "P2"),
      overallScore: Number.isInteger(report.overallScore)
        ? report.overallScore
        : 0,
      average: getReviewAverage(report),
    };
  }
  return {
    schemaVersion: LEGACY_REVIEW_SCHEMA_VERSION,
    pass: report?.overall?.pass === true ? 1 : 0,
    industryRolePassed: report?.industryRoleCheck?.passed === true ? 1 : 0,
    blockingIssues: countBlockingIssues(report),
    highSeverityIssues: countHighSeverityIssues(report),
    atsEvidenceGaps: countAtsEvidenceGaps(report),
    totalScore: getGlobalFiveDimensionTotal(report),
    average: getReviewAverage(report),
  };
}

function compareReviewSignals(left, right) {
  if (left && !right) {
    return 1;
  }
  if (!left && right) {
    return -1;
  }
  if (!left && !right) {
    return 0;
  }

  if (left.schemaVersion !== right.schemaVersion) {
    return 0;
  }

  if (left.schemaVersion === REVIEW_SCHEMA_VERSION) {
    for (const delta of [
      right.p0 - left.p0,
      right.p1 - left.p1,
      right.p2 - left.p2,
      left.overallScore - right.overallScore,
    ]) {
      if (delta !== 0) return delta > 0 ? 1 : -1;
    }
    return 0;
  }

  for (const delta of [
    left.pass - right.pass,
    left.industryRolePassed - right.industryRolePassed,
    right.blockingIssues - left.blockingIssues,
    right.highSeverityIssues - left.highSeverityIssues,
    right.atsEvidenceGaps - left.atsEvidenceGaps,
    left.totalScore - right.totalScore,
    left.average - right.average,
  ]) {
    if (delta !== 0) {
      return delta > 0 ? 1 : -1;
    }
  }

  return 0;
}

export function createReviewPolicyState({
  initialResumePath = null,
  maxRounds = 3,
} = {}) {
  return {
    maxRounds: resolveMaxRounds(maxRounds),
    bestScore: -1,
    bestSignal: null,
    bestResumePath: initialResumePath,
    bestReviewReport: null,
    bestReviewPath: null,
    lastScore: -1,
    lastSignal: null,
    lastReviewReport: null,
    lastReviewPath: null,
    noProgressStreak: 0,
    stopReason: null,
  };
}

export function applyReviewPolicyRound(
  state,
  { round, resumePath, reviewPath, report, candidateFollowsExecutedAction = round > 1, targetedImprovement },
) {
  const previousState = state || createReviewPolicyState();
  const currentSignals = getNormalizedReviewSignals(report);
  const previousBestSignals =
    previousState.bestSignal ??
    (previousState.bestReviewReport
      ? getNormalizedReviewSignals(previousState.bestReviewReport)
      : null);
  const average = getReviewAverage(report);
  const improved = targetedImprovement === undefined
    ? compareReviewSignals(currentSignals, previousBestSignals) > 0
    : previousBestSignals === null || targetedImprovement;
  // Consecutive executed actions that failed to qualify as the new Best.
  // One non-improving candidate alone must not end the loop; two in a row do.
  const previousStreak =
    Number.isInteger(previousState.noProgressStreak) &&
    previousState.noProgressStreak >= 0
      ? previousState.noProgressStreak
      : 0;
  const noProgressStreak = improved
    ? 0
    : candidateFollowsExecutedAction
      ? previousStreak + 1
      : previousStreak;

  const nextState = {
    ...previousState,
    lastScore: average,
    lastSignal: currentSignals,
    lastReviewReport: report,
    lastReviewPath: reviewPath || null,
    noProgressStreak,
    stopReason: null,
  };

  if (improved) {
    nextState.bestScore = average;
    nextState.bestSignal = currentSignals;
    nextState.bestResumePath = resumePath || previousState.bestResumePath;
    nextState.bestReviewReport = report;
    nextState.bestReviewPath = reviewPath || null;
  }

  const shouldEarlyStop = noProgressStreak >= 2;
  const shouldPass = isReviewReportV2(report)
    ? report.verdict === "PASS"
    : report?.overall?.pass === true;
  const shouldStopForMaxRounds = round >= previousState.maxRounds;

  let stopReason = null;
  if (shouldEarlyStop) {
    stopReason = REVIEW_STOP_REASONS.EARLY_STOP;
  } else if (shouldPass) {
    stopReason = REVIEW_STOP_REASONS.PASS;
  } else if (shouldStopForMaxRounds) {
    stopReason = REVIEW_STOP_REASONS.MAX_ROUNDS;
  }

  nextState.stopReason = stopReason;

  return {
    state: nextState,
    decision: {
      round,
      average,
      improved,
      shouldStop: stopReason !== null,
      shouldRevise: stopReason === null,
      stopReason,
      bestScore: nextState.bestScore,
      bestResumePath: nextState.bestResumePath,
      bestReviewReport: nextState.bestReviewReport,
      bestReviewPath: nextState.bestReviewPath,
      lastReviewReport: nextState.lastReviewReport,
      lastReviewPath: nextState.lastReviewPath,
    },
  };
}

export function validateExecutionRequest(data) {
  const errors = [];
  if (!isObject(data)) {
    return { valid: false, errors: ["execution request must be an object"] };
  }

  pushStringError(errors, "requestId", data.requestId);
  pushStringError(errors, "agent", data.agent);

  if (!isObject(data.backend)) {
    errors.push("backend must be an object");
  } else {
    if (!BACKEND_PROVIDERS.includes(data.backend.provider)) {
      errors.push(
        `backend.provider must be one of: ${BACKEND_PROVIDERS.join(", ")}`,
      );
    }
    if (!BACKEND_EXECUTION_MODES.includes(data.backend.mode)) {
      errors.push(
        `backend.mode must be one of: ${BACKEND_EXECUTION_MODES.join(", ")}`,
      );
    }
  }

  if (!Array.isArray(data.steps) || data.steps.length === 0) {
    errors.push("steps must be a non-empty array");
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true, data };
}

export function validateExecutionResult(data) {
  const errors = [];
  if (!isObject(data)) {
    return { valid: false, errors: ["execution result must be an object"] };
  }

  pushStringError(errors, "requestId", data.requestId);
  if (!EXECUTION_STATUSES.includes(data.status)) {
    errors.push(`status must be one of: ${EXECUTION_STATUSES.join(", ")}`);
  }
  if (!Array.isArray(data.artifacts)) {
    errors.push("artifacts must be an array");
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true, data };
}

export function validateArtifactManifest(data) {
  const errors = [];
  if (!isObject(data)) {
    return { valid: false, errors: ["artifact manifest must be an object"] };
  }

  pushStringError(errors, "artifactId", data.artifactId);
  pushStringError(errors, "path", data.path);
  if (!ARTIFACT_KINDS.includes(data.kind)) {
    errors.push(`kind must be one of: ${ARTIFACT_KINDS.join(", ")}`);
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true, data };
}

export function validateLogEvent(data) {
  const errors = [];
  if (!isObject(data)) {
    return { valid: false, errors: ["log event must be an object"] };
  }

  pushStringError(errors, "eventId", data.eventId);
  pushStringError(errors, "agent", data.agent);
  pushStringError(errors, "action", data.action);
  if (!LOG_EVENT_LEVELS.includes(data.level)) {
    errors.push(`level must be one of: ${LOG_EVENT_LEVELS.join(", ")}`);
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true, data };
}

export function validatePolicyDecision(data) {
  const errors = [];
  if (!isObject(data)) {
    return { valid: false, errors: ["policy decision must be an object"] };
  }

  if (!isFiniteNumber(data.round) || data.round < 1) {
    errors.push("round must be a positive number");
  }
  pushNumberRangeError(errors, "average", data.average, 0, 10);
  if (typeof data.shouldStop !== "boolean") {
    errors.push("shouldStop must be a boolean");
  }
  if (typeof data.shouldRevise !== "boolean") {
    errors.push("shouldRevise must be a boolean");
  }
  if (
    data.stopReason !== null &&
    !Object.values(REVIEW_STOP_REASONS).includes(data.stopReason)
  ) {
    errors.push(
      `stopReason must be null or one of: ${Object.values(REVIEW_STOP_REASONS).join(", ")}`,
    );
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true, data };
}

export function validateLegacyReviewShape(data) {
  const errors = [];
  const requiredKeys = [
    "industryRoleCheck",
    "scores",
    "globalFiveDimension",
    "overall",
    "moduleReviews",
    "missingAtsKeywords",
    "sectionFeedback",
    "rewriteSuggestions",
    "keepAsIs",
    "evidenceGap",
    "nextActions",
  ];
  const requiredKnowledgeBasePhrase = "根据知识库中的行业标准";

  if (!isObject(data)) {
    return { valid: false, errors: ["review payload must be an object"] };
  }

  for (const key of requiredKeys) {
    if (!(key in data)) {
      errors.push(`missing top-level key: ${key}`);
    }
  }

  if ("reviewSchemaVersion" in data) {
    errors.push(
      `reviewSchemaVersion must not appear in payload; runtime contract is frozen as ${REVIEW_SCHEMA_VERSION}`,
    );
  }

  if (
    isObject(data.globalFiveDimension) &&
    "eliminationWarning" in data.globalFiveDimension
  ) {
    errors.push(
      "globalFiveDimension.eliminationWarning is a legacy field and is not allowed in the canonical runtime contract",
    );
  }

  if (!isObject(data.industryRoleCheck)) {
    errors.push("industryRoleCheck must be an object");
  } else {
    if (typeof data.industryRoleCheck.passed !== "boolean") {
      errors.push("industryRoleCheck.passed must be a boolean");
    }
    if (typeof data.industryRoleCheck.industry !== "string") {
      errors.push("industryRoleCheck.industry must be a string");
    }
    if (typeof data.industryRoleCheck.role !== "string") {
      errors.push("industryRoleCheck.role must be a string");
    }
    if (typeof data.industryRoleCheck.blockingIssue !== "string") {
      errors.push("industryRoleCheck.blockingIssue must be a string");
    }
    if (data.industryRoleCheck.passed === true) {
      pushStringError(
        errors,
        "industryRoleCheck.industry",
        data.industryRoleCheck.industry,
      );
      pushStringError(
        errors,
        "industryRoleCheck.role",
        data.industryRoleCheck.role,
      );
    }
  }

  if (!isObject(data.overall)) {
    errors.push("overall must be an object");
  } else {
    pushNumberRangeError(
      errors,
      "overall.average",
      data.overall.average,
      0,
      10,
    );
    if (typeof data.overall.pass !== "boolean") {
      errors.push("overall.pass must be a boolean");
    }
    if (!["PASS", "REVISE", "NEED_ROLE_INFO"].includes(data.overall.verdict)) {
      errors.push("overall.verdict must be PASS, REVISE, or NEED_ROLE_INFO");
    }
  }

  if (!isObject(data.scores)) {
    errors.push("scores must be an object");
  } else {
    for (const key of [
      "atsCompatibility",
      "quantification",
      "jdMatch",
      "conciseness",
      "professionalism",
    ]) {
      if (!(key in data.scores)) {
        errors.push(`missing scores.${key}`);
      } else {
        pushNumberRangeError(errors, `scores.${key}`, data.scores[key], 0, 10);
      }
    }
  }

  if (!isObject(data.globalFiveDimension)) {
    errors.push("globalFiveDimension must be an object");
  } else {
    for (const key of [
      "performanceQuantification",
      "skillMatch",
      "descriptionAccuracy",
      "logicCorrectness",
      "standardCompliance",
    ]) {
      pushNumberRangeError(
        errors,
        `globalFiveDimension.${key}`,
        data.globalFiveDimension[key],
        0,
        20,
      );
    }

    pushNumberRangeError(
      errors,
      "globalFiveDimension.total",
      data.globalFiveDimension.total,
      0,
      100,
    );
    pushStringError(
      errors,
      "globalFiveDimension.skillMatchComment",
      data.globalFiveDimension.skillMatchComment,
    );
    pushStringError(
      errors,
      "globalFiveDimension.standardComplianceComment",
      data.globalFiveDimension.standardComplianceComment,
    );

    if (
      isNonEmptyString(data.globalFiveDimension.skillMatchComment) &&
      !data.globalFiveDimension.skillMatchComment.includes(
        requiredKnowledgeBasePhrase,
      )
    ) {
      errors.push(
        `globalFiveDimension.skillMatchComment must include "${requiredKnowledgeBasePhrase}"`,
      );
    }

    if (
      isNonEmptyString(data.globalFiveDimension.standardComplianceComment) &&
      !data.globalFiveDimension.standardComplianceComment.includes(
        requiredKnowledgeBasePhrase,
      )
    ) {
      errors.push(
        `globalFiveDimension.standardComplianceComment must include "${requiredKnowledgeBasePhrase}"`,
      );
    }
  }

  if (!Array.isArray(data.moduleReviews)) {
    errors.push("moduleReviews must be an array");
  } else {

    data.moduleReviews.forEach((review, index) => {
      if (!isObject(review)) {
        errors.push(`moduleReviews[${index}] must be an object`);
        return;
      }

      pushStringError(errors, `moduleReviews[${index}].module`, review.module);
      pushStringError(
        errors,
        `moduleReviews[${index}].originalText`,
        review.originalText,
      );

      if ("ruthlessDissection" in review) {
        errors.push(
          `moduleReviews[${index}].ruthlessDissection is a legacy field and is not allowed in the canonical runtime contract`,
        );
      }

      if (!isObject(review.issueAnalysis)) {
        errors.push(`moduleReviews[${index}].issueAnalysis must be an object`);
      } else {
        if (
          !["blocking", "important", "polish"].includes(
            review.issueAnalysis.severity,
          )
        ) {
          errors.push(
            `moduleReviews[${index}].issueAnalysis.severity must be blocking, important, or polish`,
          );
        }
        pushStringError(
          errors,
          `moduleReviews[${index}].issueAnalysis.issue`,
          review.issueAnalysis.issue,
        );
        pushStringError(
          errors,
          `moduleReviews[${index}].issueAnalysis.whyItMatters`,
          review.issueAnalysis.whyItMatters,
        );
        pushStringError(
          errors,
          `moduleReviews[${index}].issueAnalysis.safeRevisionPrinciple`,
          review.issueAnalysis.safeRevisionPrinciple,
        );
        pushStringError(
          errors,
          `moduleReviews[${index}].issueAnalysis.knowledgeBaseAlignment`,
          review.issueAnalysis.knowledgeBaseAlignment,
        );

        if (
          isNonEmptyString(review.issueAnalysis.knowledgeBaseAlignment) &&
          !review.issueAnalysis.knowledgeBaseAlignment.includes(
            requiredKnowledgeBasePhrase,
          )
        ) {
          errors.push(
            `moduleReviews[${index}].issueAnalysis.knowledgeBaseAlignment must include "${requiredKnowledgeBasePhrase}"`,
          );
        }
      }

      pushNumberRangeError(
        errors,
        `moduleReviews[${index}].diagnosticScore`,
        review.diagnosticScore,
        1,
        10,
      );
      pushStringError(
        errors,
        `moduleReviews[${index}].reconstructionDemo`,
        review.reconstructionDemo,
      );
    });
  }

  if (!Array.isArray(data.sectionFeedback)) {
    errors.push("sectionFeedback must be an array");
  } else {

    data.sectionFeedback.forEach((item, index) => {
      if (!isObject(item)) {
        errors.push(`sectionFeedback[${index}] must be an object`);
        return;
      }

      pushStringError(
        errors,
        `sectionFeedback[${index}].section`,
        item.section,
      );
      if (!["high", "medium", "low"].includes(item.severity)) {
        errors.push(
          `sectionFeedback[${index}].severity must be high, medium, or low`,
        );
      }
      pushStringError(errors, `sectionFeedback[${index}].issue`, item.issue);
      pushStringError(
        errors,
        `sectionFeedback[${index}].whyItMatters`,
        item.whyItMatters,
      );
      pushStringError(
        errors,
        `sectionFeedback[${index}].suggestion`,
        item.suggestion,
      );
    });
  }

  if (!Array.isArray(data.missingAtsKeywords)) {
    errors.push("missingAtsKeywords must be an array");
  } else {
    data.missingAtsKeywords.forEach((keyword, index) => {
      if (!isNonEmptyString(keyword)) {
        errors.push(`missingAtsKeywords[${index}] must be a non-empty string`);
      }
    });
  }

  if (!Array.isArray(data.rewriteSuggestions)) {
    errors.push("rewriteSuggestions must be an array");
  } else {
    data.rewriteSuggestions.forEach((suggestion, index) => {
      if (!isObject(suggestion)) {
        errors.push(`rewriteSuggestions[${index}] must be an object`);
        return;
      }

      pushStringError(
        errors,
        `rewriteSuggestions[${index}].section`,
        suggestion.section,
      );
      pushStringError(
        errors,
        `rewriteSuggestions[${index}].before`,
        suggestion.before,
      );
      pushStringError(
        errors,
        `rewriteSuggestions[${index}].after`,
        suggestion.after,
      );
    });
  }

  pushArrayOfStringsError(errors, "keepAsIs", data.keepAsIs, 1);
  pushArrayOfStringsError(errors, "evidenceGap", data.evidenceGap);
  pushArrayOfStringsError(errors, "nextActions", data.nextActions);

  if (isObject(data.overall) && isObject(data.industryRoleCheck)) {
    if (data.overall.verdict === "PASS" && data.overall.pass !== true) {
      errors.push("overall.pass must be true when overall.verdict is PASS");
    }

    if (data.overall.verdict === "REVISE" && data.overall.pass !== false) {
      errors.push("overall.pass must be false when overall.verdict is REVISE");
    }

    if (data.overall.verdict === "NEED_ROLE_INFO") {
      if (data.overall.pass !== false) {
        errors.push(
          "overall.pass must be false when overall.verdict is NEED_ROLE_INFO",
        );
      }
      if (data.industryRoleCheck.passed !== false) {
        errors.push(
          "industryRoleCheck.passed must be false when overall.verdict is NEED_ROLE_INFO",
        );
      }
      if (!isNonEmptyString(data.industryRoleCheck.blockingIssue)) {
        errors.push(
          "industryRoleCheck.blockingIssue must be a non-empty string when overall.verdict is NEED_ROLE_INFO",
        );
      }
    }

    if (data.overall.pass === true && data.industryRoleCheck.passed !== true) {
      errors.push(
        "industryRoleCheck.passed must be true when overall.pass is true",
      );
    }
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true, data };
}

const REVIEW_V2_REQUIRED_KEYS = [
  "schemaVersion",
  "verdict",
  "roleInfoQuestion",
  "overallScore",
  "positioningDiagnosis",
  "topIssues",
  "jdCoverage",
  "strengths",
];

const REVIEW_V2_LEGACY_KEYS = [
  "industryRoleCheck",
  "scores",
  "globalFiveDimension",
  "overall",
  "candidateNarrative",
  "moduleReviews",
  "sectionFeedback",
  "missingAtsKeywords",
  "rewriteSuggestions",
  "keepAsIs",
  "evidenceGap",
  "nextActions",
];

export function isReviewReportV2(data) {
  return isObject(data) && data.schemaVersion === REVIEW_SCHEMA_VERSION;
}

function normalizeReviewToken(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : value;
}

export function normalizeReviewReportV2(data) {
  if (!isReviewReportV2(data)) return data;

  const normalized = { ...data };
  normalized.verdict = normalizeReviewToken(normalized.verdict);
  if (Array.isArray(normalized.topIssues)) {
    normalized.topIssues = normalized.topIssues.map((issue) => {
      if (!isObject(issue)) return issue;
      const next = { ...issue };
      next.priority = normalizeReviewToken(next.priority);
      next.category = normalizeReviewToken(next.category);
      next.resolution = normalizeReviewToken(next.resolution);
      if (typeof next.category === "string") {
        next.category = REVIEW_V2_CATEGORY_ALIASES[next.category] ?? next.category;
      }
      return next;
    });
  }
  return normalized;
}

function validateReviewCoverageGroup(errors, groupName, value, seenRequirements) {
  if (!Array.isArray(value)) {
    errors.push(`jdCoverage.${groupName} must be an array`);
    return;
  }

  value.forEach((item, index) => {
    const path = `jdCoverage.${groupName}[${index}]`;
    if (!isObject(item)) {
      errors.push(`${path} must be an object`);
      return;
    }
    for (const key of Object.keys(item)) {
      if (key !== "requirement" && key !== "evidence") {
        errors.push(`${path} contains unknown field: ${key}`);
      }
    }
    pushStringError(errors, `${path}.requirement`, item.requirement);
    if (typeof item.evidence !== "string") {
      errors.push(`${path}.evidence must be a string`);
    }
    if (isNonEmptyString(item.requirement)) {
      const requirement = item.requirement.trim();
      if (seenRequirements.has(requirement)) {
        errors.push(`jdCoverage requirement must appear in only one group: ${requirement}`);
      }
      seenRequirements.add(requirement);
    }
  });
}

function validateReviewV2Shape(data) {
  const errors = [];

  for (const key of REVIEW_V2_REQUIRED_KEYS) {
    if (!(key in data)) errors.push(`missing top-level key: ${key}`);
  }
  for (const key of Object.keys(data)) {
    if (!REVIEW_V2_REQUIRED_KEYS.includes(key)) {
      errors.push(
        `${REVIEW_V2_LEGACY_KEYS.includes(key) ? "legacy" : "unknown"} top-level key is not allowed: ${key}`,
      );
    }
  }

  if (data.schemaVersion !== REVIEW_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${REVIEW_SCHEMA_VERSION}`);
  }
  if (!["PASS", "REVISE", "NEED_ROLE_INFO"].includes(data.verdict)) {
    errors.push("verdict must be PASS, REVISE, or NEED_ROLE_INFO");
  }
  if (
    data.roleInfoQuestion !== null &&
    !isNonEmptyString(data.roleInfoQuestion)
  ) {
    errors.push("roleInfoQuestion must be null or a non-empty string");
  }
  if (!Number.isInteger(data.overallScore) || data.overallScore < 0 || data.overallScore > 100) {
    errors.push("overallScore must be an integer between 0 and 100");
  }

  if (!isObject(data.positioningDiagnosis)) {
    errors.push("positioningDiagnosis must be an object");
  } else {
    for (const key of Object.keys(data.positioningDiagnosis)) {
      if (!["currentPositioning", "targetPositioning", "biggestGap"].includes(key)) {
        errors.push(`positioningDiagnosis contains unknown field: ${key}`);
      }
    }
    pushStringError(
      errors,
      "positioningDiagnosis.currentPositioning",
      data.positioningDiagnosis.currentPositioning,
    );
    pushStringError(
      errors,
      "positioningDiagnosis.targetPositioning",
      data.positioningDiagnosis.targetPositioning,
    );
    if (typeof data.positioningDiagnosis.biggestGap !== "string") {
      errors.push("positioningDiagnosis.biggestGap must be a string");
    }
  }

  if (!Array.isArray(data.topIssues)) {
    errors.push("topIssues must be an array");
  } else {
    if (data.topIssues.length > 8) errors.push("topIssues must contain at most 8 items");
    const issueRefs = new Set();
    data.topIssues.forEach((issue, index) => {
      const path = `topIssues[${index}]`;
      if (!isObject(issue)) {
        errors.push(`${path} must be an object`);
        return;
      }
      for (const key of Object.keys(issue)) {
        if (!["issueRef", "priority", "category", "resolution", "section", "resumeEvidence", "jdEvidence", "sourceEvidence", "problem", "whyItHurts", "recommendedAction"].includes(key)) {
          errors.push(`${path} contains unknown field: ${key}`);
        }
      }
      for (const field of [
        "issueRef",
        "priority",
        "category",
        "resolution",
        "section",
        "resumeEvidence",
        "jdEvidence",
        "sourceEvidence",
        "problem",
        "whyItHurts",
        "recommendedAction",
      ]) {
        if (!(field in issue)) errors.push(`missing ${path}.${field}`);
      }
      pushStringError(errors, `${path}.issueRef`, issue.issueRef);
      if (isNonEmptyString(issue.issueRef)) {
        const issueRef = issue.issueRef.trim();
        if (issueRefs.has(issueRef)) errors.push(`duplicate topIssues issueRef: ${issueRef}`);
        issueRefs.add(issueRef);
      }
      if (!REVIEW_V2_PRIORITIES.includes(issue.priority)) {
        errors.push(`${path}.priority must be P0, P1, P2, or P3`);
      }
      if (!REVIEW_V2_CATEGORIES.includes(issue.category)) {
        errors.push(`${path}.category is invalid`);
      }
      if (!REVIEW_V2_RESOLUTIONS.includes(issue.resolution)) {
        errors.push(`${path}.resolution is invalid`);
      }
      for (const field of ["section", "problem", "whyItHurts", "recommendedAction"]) {
        pushStringError(errors, `${path}.${field}`, issue[field]);
      }
      for (const field of ["resumeEvidence", "jdEvidence", "sourceEvidence"]) {
        if (typeof issue[field] !== "string") errors.push(`${path}.${field} must be a string`);
      }
      if (
        ["P0", "P1"].includes(issue.priority) &&
        [issue.resumeEvidence, issue.jdEvidence, issue.sourceEvidence].every(
          (value) => typeof value === "string" && value.trim().length === 0,
        )
      ) {
        errors.push(`${path} P0/P1 issue must cite resumeEvidence, jdEvidence, or sourceEvidence`);
      }
    });
  }

  if (!isObject(data.jdCoverage)) {
    errors.push("jdCoverage must be an object");
  } else {
    const seenRequirements = new Set();
    for (const group of ["strong", "weak", "unsupported"]) {
      validateReviewCoverageGroup(errors, group, data.jdCoverage[group], seenRequirements);
    }
  }
  pushArrayOfStringsError(errors, "strengths", data.strengths);

  if (data.verdict === "NEED_ROLE_INFO" && !isNonEmptyString(data.roleInfoQuestion)) {
    errors.push("roleInfoQuestion must be non-empty when verdict is NEED_ROLE_INFO");
  }
  if (data.verdict !== "NEED_ROLE_INFO" && data.roleInfoQuestion !== null) {
    errors.push("roleInfoQuestion must be null unless verdict is NEED_ROLE_INFO");
  }
  if (data.verdict === "PASS" && Array.isArray(data.topIssues)) {
    const substantive = data.topIssues.filter((issue) =>
      issue && ["P0", "P1", "P2"].includes(issue.priority),
    );
    if (substantive.length > 0) {
      errors.push("PASS cannot contain P0, P1, or P2 topIssues");
    }
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true, data };
}

export function validateReviewShape(data) {
  if (!isObject(data)) {
    return { valid: false, errors: ["review payload must be an object"] };
  }
  if (isReviewReportV2(data)) {
    return validateReviewV2Shape(data);
  }
  if (!Object.hasOwn(data, "schemaVersion")) {
    const legacy = validateLegacyReviewShape(data);
    return legacy.valid ? { ...legacy, legacy: true } : legacy;
  }
  return {
    valid: false,
    errors: [`schemaVersion must be ${REVIEW_SCHEMA_VERSION} for new Review reports`],
  };
}

export function validateNewReviewShape(data) {
  if (!isReviewReportV2(data)) {
    return {
      valid: false,
      errors: [`new Review reports must use schemaVersion ${REVIEW_SCHEMA_VERSION}`],
    };
  }
  return validateReviewV2Shape(data);
}
