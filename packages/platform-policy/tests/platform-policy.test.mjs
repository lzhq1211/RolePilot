import test from "node:test";
import assert from "node:assert/strict";

import { OPTIMIZATION_ACTIONS as CONTRACT_OPTIMIZATION_ACTIONS } from "../../platform-contracts/src/index.mjs";
import {
  OPTIMIZATION_ACTIONS as POLICY_OPTIMIZATION_ACTIONS,
  createResumeGoalPlan,
  evaluatePolicyGate,
  routeOptimizationDecision,
  selectFallbackPolicy,
  superviseStep,
} from "../dist/index.js";

function createOptimizationRouteInput(overrides = {}) {
  const decision = {
    action: "REORDER",
    target: "content.work",
    reason: "Put the strongest supported experience first.",
    evidenceRefs: ["review.nextActions[0]"],
    expectedImprovement: "Improve relevance without changing facts.",
    risk: "low",
    ...overrides.decision,
  };
  return {
    reviewReport: {
      overall: { verdict: "REVISE", pass: false },
      evidenceGap: ["Unrelated evidence remains unavailable."],
    },
    decision,
    actionHistory: [],
    preflightDecision: {
      decision: "PROCEED",
      missingEvidence: [],
      unsupportedTargets: [],
    },
    remainingBudget: 2,
    currentArtifactPaths: {
      resumePath: "/tmp/current-resume.yml",
      reviewPath: "/tmp/current-review.json",
    },
    ...overrides,
    decision,
  };
}

test("optimization action vocabulary stays aligned with the contract package", () => {
  assert.deepEqual(POLICY_OPTIMIZATION_ACTIONS, CONTRACT_OPTIMIZATION_ACTIONS);
});

test("goal planning creates a bounded resume workflow without skipping write-review steps", () => {
  const result = createResumeGoalPlan({
    goal: "Create a full workflow resume package with interview prep",
    hasTimelineContext: true,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.value.steps.map((step) => step.id),
    ["jd-analysis", "preflight", "write", "review", "interview"],
  );
  assert.equal(result.value.reviewMode, "single-pass");
  assert.equal(result.value.maxSteps, 5);
});

test("goal planning prepends mine when timeline context is missing", () => {
  const result = createResumeGoalPlan({
    goal: "Create a resume workflow",
    hasTimelineContext: false,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.value.steps.map((step) => step.id),
    ["mine", "jd-analysis", "preflight", "write", "review"],
  );
});

test("goal planning rejects unbounded review rounds with machine-readable governance reasons", () => {
  const result = createResumeGoalPlan({
    goal: "Create a resume workflow",
    hasTimelineContext: true,
    requestedReviewRounds: "unbounded",
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.reasons.map((reason) => reason.code),
    ["UNBOUNDED_PLAN"],
  );
});

test("policy gates block forbidden actions with machine-readable governance reasons", () => {
  const result = evaluatePolicyGate({ action: "run-shell-command" });

  assert.equal(result.allowed, false);
  assert.equal(result.risk, "high");
  assert.deepEqual(
    result.reasons.map((reason) => reason.code),
    ["FORBIDDEN_ACTION"],
  );
});

test("policy gates require approval for high-risk resume actions", () => {
  const result = evaluatePolicyGate({ action: "share-resume-externally" });

  assert.equal(result.allowed, false);
  assert.equal(result.risk, "high");
  assert.deepEqual(
    result.reasons.map((reason) => reason.code),
    ["APPROVAL_REQUIRED"],
  );
});

test("policy gates normalize action casing before applying risk controls", () => {
  const forbidden = evaluatePolicyGate({ action: "  Run-Shell-Command  " });
  const approval = evaluatePolicyGate({ action: "SHARE-RESUME-EXTERNALLY" });

  assert.equal(forbidden.allowed, false);
  assert.deepEqual(
    forbidden.reasons.map((reason) => reason.code),
    ["FORBIDDEN_ACTION"],
  );
  assert.equal(approval.allowed, false);
  assert.deepEqual(
    approval.reasons.map((reason) => reason.code),
    ["APPROVAL_REQUIRED"],
  );
});

test("fallback policy selects the configured backup provider only for retryable live failures", () => {
  const result = selectFallbackPolicy({
    provider: "claude",
    mode: "live",
    error: {
      code: "CLI_TIMEOUT",
      message: "timed out",
      retryable: true,
    },
    config: {
      fallbackByProvider: {
        claude: "opencode",
      },
    },
  });

  assert.equal(result.shouldFallback, true);
  assert.equal(result.toProvider, "opencode");
  assert.deepEqual(result.reasons, []);
});

test("fallback policy follows providerOrder sequentially instead of rewinding to earlier providers", () => {
  const opencodeResult = selectFallbackPolicy({
    provider: "opencode",
    mode: "live",
    error: {
      code: "CLI_TIMEOUT",
      message: "timed out",
      retryable: true,
    },
    config: {
      providerOrder: ["claude", "opencode", "codex"],
    },
  });
  const codexResult = selectFallbackPolicy({
    provider: "codex",
    mode: "live",
    error: {
      code: "CLI_TIMEOUT",
      message: "timed out",
      retryable: true,
    },
    config: {
      providerOrder: ["claude", "opencode", "codex"],
    },
  });

  assert.equal(opencodeResult.shouldFallback, true);
  assert.equal(opencodeResult.toProvider, "codex");
  assert.equal(codexResult.shouldFallback, false);
  assert.deepEqual(
    codexResult.reasons.map((reason) => reason.code),
    ["FALLBACK_NOT_ALLOWED"],
  );
});

test("fallback policy rejects fallback for non-retryable errors and replay modes", () => {
  const nonRetryable = selectFallbackPolicy({
    provider: "claude",
    mode: "live",
    error: {
      code: "INVALID_REQUEST",
      message: "bad request",
      retryable: false,
    },
  });
  const replayMode = selectFallbackPolicy({
    provider: "claude",
    mode: "replay",
    error: {
      code: "CLI_TIMEOUT",
      message: "timed out",
      retryable: true,
    },
  });

  assert.equal(nonRetryable.shouldFallback, false);
  assert.deepEqual(
    nonRetryable.reasons.map((reason) => reason.code),
    ["NON_RETRYABLE_BACKEND_ERROR"],
  );
  assert.equal(replayMode.shouldFallback, false);
  assert.deepEqual(
    replayMode.reasons.map((reason) => reason.code),
    ["FALLBACK_NOT_ALLOWED"],
  );
});

test("supervisor replans a failed review within the bounded review budget", () => {
  const result = superviseStep({
    currentStep: "review",
    status: "failed",
    reviewPassed: false,
    reviewReplansUsed: 0,
    reviewReplanBudget: 1,
  });

  assert.equal(result.decision, "replan");
  assert.deepEqual(
    result.nextPlan?.map((step) => step.id),
    ["write", "review"],
  );
});

test("supervisor escalates when the bounded review budget is exhausted", () => {
  const result = superviseStep({
    currentStep: "review",
    status: "failed",
    reviewPassed: false,
    reviewReplansUsed: 1,
    reviewReplanBudget: 1,
  });

  assert.equal(result.decision, "escalate");
  assert.equal(result.nextPlan, null);
  assert.deepEqual(
    result.reasons.map((reason) => reason.code),
    ["REVIEW_BUDGET_EXHAUSTED"],
  );
});

test("optimization router rejects actions outside the allowlist", () => {
  const result = routeOptimizationDecision(
    createOptimizationRouteInput({
      decision: { action: "RUN_TOOL" },
    }),
  );

  assert.equal(result.allowed, false);
  assert.equal(result.action, "STOP");
  assert.equal(result.shouldStop, false);
  assert.deepEqual(result.reasonCodes, ["ACTION_NOT_ALLOWLISTED"]);
});

test("optimization router rejects PASS when the current review did not pass", () => {
  const result = routeOptimizationDecision(
    createOptimizationRouteInput({
      decision: { action: "PASS", target: null, evidenceRefs: [] },
    }),
  );

  assert.equal(result.allowed, false);
  assert.deepEqual(result.reasonCodes, ["PASS_CONFLICTS_WITH_REVIEW"]);
});

test("optimization router accepts PASS from a v2 review verdict", () => {
  const result = routeOptimizationDecision(
    createOptimizationRouteInput({
      reviewReport: { schemaVersion: 2, verdict: "PASS" },
      decision: { action: "PASS", target: null, evidenceRefs: [] },
    }),
  );

  assert.equal(result.allowed, true);
  assert.equal(result.action, "PASS");
  assert.deepEqual(result.reasonCodes, ["PASS_SELECTED"]);
});

test("optimization router stops mutating actions when budget is exhausted", () => {
  const result = routeOptimizationDecision(
    createOptimizationRouteInput({ remainingBudget: 0 }),
  );

  assert.equal(result.allowed, false);
  assert.deepEqual(result.reasonCodes, ["BUDGET_EXHAUSTED"]);
  assert.equal(result.shouldStop, true);
});

test("optimization router rejects a consecutive duplicate action and target", () => {
  const result = routeOptimizationDecision(
    createOptimizationRouteInput({
      actionHistory: [{ action: "REORDER", target: "content.work" }],
    }),
  );

  assert.equal(result.allowed, false);
  assert.deepEqual(result.reasonCodes, ["REPEATED_ACTION"]);
  assert.equal(result.shouldStop, false);
  const binding = { issueRef: "I1", issueKey: "clarity", targetNode: { nodeId: "entry-a" }, evidenceVersion: 1 };
  const history = [{ action: "REWRITE_SECTION", target: "经历", ...binding }];
  const duplicate = routeOptimizationDecision(createOptimizationRouteInput({
    decision: binding, actionHistory: history,
  }));
  assert.deepEqual(duplicate.reasonCodes, ["REPEATED_ACTION"]);
  const withNewEvidence = routeOptimizationDecision(createOptimizationRouteInput({
    decision: { ...binding, evidenceVersion: 2 }, actionHistory: history,
  }));
  assert.equal(withNewEvidence.allowed, true);
  const wrongBinding = routeOptimizationDecision(createOptimizationRouteInput({ issueBindingValid: false }));
  assert.deepEqual(wrongBinding.reasonCodes, ["INVALID_ISSUE_BINDING"]);
});

test("optimization router requires evidence for keyword optimization", () => {
  const result = routeOptimizationDecision(
    createOptimizationRouteInput({
      decision: {
        action: "KEYWORD_OPTIMIZE",
        target: "content.skills",
        evidenceRefs: [],
      },
    }),
  );

  assert.equal(result.allowed, false);
  assert.deepEqual(result.reasonCodes, ["EVIDENCE_REQUIRED"]);
  assert.equal(result.shouldStop, false);
});

test("optimization router allows ordinary strengthening with unrelated unresolved evidence", () => {
  const result = routeOptimizationDecision(
    createOptimizationRouteInput({
      decision: {
        action: "REWRITE_SECTION",
        target: "content.basics.summary",
        evidenceRefs: ["timeline.content.work[0]"],
      },
      preflightDecision: {
        decision: "PROCEED",
        missingEvidence: ["Verified model evaluation outcome"],
        unsupportedTargets: [],
      },
    }),
  );

  assert.equal(result.allowed, true);
  assert.deepEqual(result.reasonCodes, []);
});

test("optimization router blocks evidence-gap references and exhausted questions", () => {
  const evidenceGap = routeOptimizationDecision(
    createOptimizationRouteInput({
      decision: {
        action: "REWRITE_SECTION",
        target: "content.basics.summary",
        evidenceRefs: ["review.evidenceGap[0]"],
      },
    }),
  );
  const exhausted = routeOptimizationDecision(
    createOptimizationRouteInput({
      canAskUser: false,
      decision: {
        action: "ASK_USER",
        target: "请确认实际职责",
        evidenceRefs: ["review.evidenceGap[0]"],
      },
    }),
  );
  assert.equal(evidenceGap.allowed, false);
  assert.deepEqual(evidenceGap.reasonCodes, ["UNRESOLVED_EVIDENCE_GAP"]);
  assert.equal(evidenceGap.shouldStop, false);
  assert.equal(exhausted.allowed, false);
  assert.equal(exhausted.action, "STOP");
  assert.deepEqual(exhausted.reasonCodes, ["QUESTION_BUDGET_EXHAUSTED"]);
  assert.equal(exhausted.shouldStop, false);
});

test("optimization router rejects qualification questions and non-source strengthening references", () => {
  const qualification = routeOptimizationDecision(
    createOptimizationRouteInput({
      decision: {
        action: "ASK_USER",
        target: "请确认你的学历和毕业时间？",
        evidenceRefs: ["timeline.content.work[0]"],
        risk: "high",
      },
    }),
  );
  const nonSource = routeOptimizationDecision(
    createOptimizationRouteInput({
      decision: {
        action: "REWRITE_SECTION",
        target: "content.basics.summary",
        evidenceRefs: ["I1"],
      },
    }),
  );

  assert.equal(qualification.allowed, false);
  assert.equal(qualification.action, "STOP");
  assert.deepEqual(qualification.reasonCodes, ["FORBIDDEN_QUALIFICATION_QUESTION"]);
  assert.equal(nonSource.allowed, false);
  assert.deepEqual(nonSource.reasonCodes, ["UNRESOLVED_EVIDENCE_GAP"]);
});

test("optimization router allows drop and reorder despite unrelated evidence gaps", () => {
  const drop = routeOptimizationDecision(
    createOptimizationRouteInput({
      decision: {
        action: "DROP_UNSUPPORTED_CLAIM",
        target: "industry-leading model evaluation",
        evidenceRefs: ["review.evidenceGap[0]"],
      },
    }),
  );
  const reorder = routeOptimizationDecision(createOptimizationRouteInput());

  assert.equal(drop.allowed, true);
  assert.equal(drop.shouldStop, false);
  assert.equal(reorder.allowed, true);
  assert.equal(reorder.shouldStop, false);
});

test("optimization router keeps dropping unsupported claims behind the gate and budget", () => {
  const result = routeOptimizationDecision(
    createOptimizationRouteInput({
      remainingBudget: 0,
      preflightDecision: {
        decision: "ASK_USER",
        missingEvidence: ["unverified claim"],
        unsupportedTargets: ["industry-leading model evaluation"],
      },
      decision: {
        action: "DROP_UNSUPPORTED_CLAIM",
        target: "industry-leading model evaluation",
        evidenceRefs: [],
      },
    }),
  );
  assert.equal(result.allowed, false);
  assert.equal(result.shouldStop, true);
});

test("optimization router always permits ASK_USER as a stopping action", () => {
  const result = routeOptimizationDecision(
    createOptimizationRouteInput({
      remainingBudget: 0,
      decision: {
        action: "ASK_USER",
        target: "Which verified metric supports this claim?",
        evidenceRefs: ["review.evidenceGap[0]"],
        risk: "high",
      },
    }),
  );

  assert.equal(result.allowed, true);
  assert.equal(result.action, "ASK_USER");
  assert.equal(result.shouldStop, true);
  assert.deepEqual(result.reasonCodes, ["ASK_USER_SELECTED"]);
});

test("optimization router does not convert high-risk mutations into ASK_USER", () => {
  const result = routeOptimizationDecision(
    createOptimizationRouteInput({
      decision: {
        action: "REORDER",
        target: "content.work",
        risk: "high",
      },
    }),
  );

  assert.equal(result.allowed, true);
  assert.equal(result.action, "REORDER");
  assert.equal(result.shouldStop, false);
  assert.deepEqual(result.reasonCodes, []);
});

test("optimization router permits fact-dependent ASK_USER proposals regardless of risk label", () => {
  const result = routeOptimizationDecision(
    createOptimizationRouteInput({
      decision: {
        action: "ASK_USER",
        target: "请确认措辞偏好",
        evidenceRefs: [],
        risk: "low",
      },
    }),
  );
  assert.equal(result.allowed, true);
  assert.equal(result.action, "ASK_USER");
  assert.deepEqual(result.reasonCodes, ["ASK_USER_SELECTED"]);
  assert.equal(result.shouldStop, true);
});
