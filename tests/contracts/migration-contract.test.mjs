import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  applyReviewPolicyRound,
  OPTIMIZATION_ACTIONS,
  OPTIMIZATION_DECISION_SCHEMA_VERSION,
  PREFLIGHT_SCHEMA_VERSION,
  REVIEW_SCHEMA_VERSION,
  FAILURE_POLICY_MODES,
  createPreflightValidationOutcome,
  createReviewPolicyState,
  createReviewValidationOutcome,
  resolveFailurePolicyMode,
  validatePreflightDecision,
  validateOptimizationDecision,
  validateLegacyReviewShape,
  validateNewReviewShape,
  validateReviewShape,
  normalizeReviewReportV2,
} from "../../packages/platform-contracts/src/index.mjs";

const FIXTURES_DIR = path.join(process.cwd(), "tests", "contracts", "fixtures");
const TESTKIT_PREFLIGHT_FIXTURES_DIR = path.join(
  process.cwd(),
  "packages",
  "platform-testkit",
  "fixtures",
  "preflight",
);
const TESTKIT_OPTIMIZATION_FIXTURES_DIR = path.join(
  process.cwd(),
  "packages",
  "platform-testkit",
  "fixtures",
  "optimization",
);

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
}

function cloneFixture(name) {
  return JSON.parse(JSON.stringify(loadFixture(name)));
}

function loadPreflightFixture(name) {
  return JSON.parse(
    fs.readFileSync(path.join(TESTKIT_PREFLIGHT_FIXTURES_DIR, name), "utf8"),
  );
}

function loadOptimizationFixture(name) {
  return JSON.parse(
    fs.readFileSync(path.join(TESTKIT_OPTIMIZATION_FIXTURES_DIR, name), "utf8"),
  );
}

function createNamedItems(prefix, count) {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
}

function createModuleReviews(blockingCount, importantCount) {
  const total = Math.max(2, blockingCount + importantCount);
  return Array.from({ length: total }, (_, index) => {
    const severity =
      index < blockingCount
        ? "blocking"
        : index < blockingCount + importantCount
          ? "important"
          : "polish";
    return {
      module: `module-${index + 1}`,
      originalText: `original-${index + 1}`,
      issueAnalysis: {
        severity,
        issue: `issue-${index + 1}`,
        whyItMatters: `why-it-matters-${index + 1}`,
        safeRevisionPrinciple: `safe-revision-${index + 1}`,
        knowledgeBaseAlignment: `根据知识库中的行业标准，signal ${index + 1} requires a validated rewrite path.`,
      },
      diagnosticScore: 7,
      reconstructionDemo: `reconstruction-${index + 1}`,
    };
  });
}

function createSectionFeedback(highCount) {
  const total = Math.max(1, highCount);
  return Array.from({ length: total }, (_, index) => ({
    section: `section-${index + 1}`,
    severity: index < highCount ? "high" : "medium",
    issue: `issue-${index + 1}`,
    whyItMatters: `why-it-matters-${index + 1}`,
    suggestion: `suggestion-${index + 1}`,
  }));
}

function buildReviewPolicyReport(round) {
  const report = cloneFixture("pass.json");
  report.overall.average = round.average;
  report.overall.pass = round.pass;
  report.overall.verdict =
    round.pass ? "PASS" : round.industryRolePassed ? "REVISE" : "NEED_ROLE_INFO";
  report.industryRoleCheck.passed = round.industryRolePassed;
  report.industryRoleCheck.blockingIssue = round.blockingIssue;
  report.globalFiveDimension.total = round.globalTotal;
  report.moduleReviews = createModuleReviews(
    round.blockingModuleReviews,
    round.importantModuleReviews,
  );
  report.sectionFeedback = createSectionFeedback(round.highSectionFeedback);
  report.missingAtsKeywords = createNamedItems(
    "ats-gap",
    round.missingAtsKeywords,
  );
  report.evidenceGap = createNamedItems("evidence-gap", round.evidenceGap);
  return report;
}

test("migration contract: new validator accepts the v2 payload and legacy reader stays explicit", () => {
  const result = validateNewReviewShape(loadFixture("review-v2.json"));

  assert.equal(REVIEW_SCHEMA_VERSION, 2);
  assert.equal(result.valid, true);
  assert.equal(validateReviewShape(loadFixture("review-v2.json")).valid, true);
  assert.equal(validateLegacyReviewShape(loadFixture("pass.json")).valid, true);
});

test("migration contract: v2 permits empty collections but rejects legacy fields and substantive PASS issues", () => {
  const empty = cloneFixture("review-v2.json");
  empty.topIssues = [];
  empty.jdCoverage = { strong: [], weak: [], unsupported: [] };
  empty.strengths = [];
  assert.equal(validateNewReviewShape(empty).valid, true);

  const legacyField = cloneFixture("review-v2.json");
  legacyField.overall = { verdict: "PASS", pass: true };
  const legacyResult = validateNewReviewShape(legacyField);
  assert.equal(legacyResult.valid, false);
  assert.match(legacyResult.errors.join("\n"), /legacy top-level key/);

  const invalidPass = cloneFixture("review-v2.json");
  invalidPass.topIssues[0].priority = "P2";
  const passResult = validateNewReviewShape(invalidPass);
  assert.equal(passResult.valid, false);
  assert.match(passResult.errors.join("\n"), /PASS cannot contain P0, P1, or P2/);

  const unsupportedPriorityEvidence = cloneFixture("review-v2.json");
  unsupportedPriorityEvidence.topIssues[0].priority = "P1";
  unsupportedPriorityEvidence.topIssues[0].resumeEvidence = "";
  unsupportedPriorityEvidence.topIssues[0].jdEvidence = "";
  unsupportedPriorityEvidence.topIssues[0].sourceEvidence = "";
  const evidenceResult = validateNewReviewShape(unsupportedPriorityEvidence);
  assert.equal(evidenceResult.valid, false);
  assert.match(evidenceResult.errors.join("\n"), /P0\/P1 issue must cite/);
});

test("migration contract: finite provider review aliases normalize before strict validation", () => {
  const raw = cloneFixture("review-v2.json");
  raw.verdict = " pass ";
  raw.topIssues[0].priority = " p3 ";
  raw.topIssues[0].category = " match ";
  raw.topIssues[0].resolution = " rewrite_now ";

  assert.equal(validateNewReviewShape(raw).valid, false);
  const normalized = normalizeReviewReportV2(raw);
  assert.equal(normalized.verdict, "PASS");
  assert.equal(normalized.topIssues[0].priority, "P3");
  assert.equal(normalized.topIssues[0].category, "JD_COVERAGE");
  assert.equal(normalized.topIssues[0].resolution, "REWRITE_NOW");
  assert.equal(validateNewReviewShape(normalized).valid, true);
  assert.equal(raw.topIssues[0].category, " match ");

  const unknown = cloneFixture("review-v2.json");
  unknown.topIssues[0].category = "MATCH_SCORE";
  assert.equal(validateNewReviewShape(normalizeReviewReportV2(unknown)).valid, false);
});

test("migration contract: preflight validator accepts all canonical gate decisions", () => {
  assert.equal(PREFLIGHT_SCHEMA_VERSION, "v1");

  for (const fixtureName of [
    "proceed.json",
    "ask-user.json",
    "stop-unsupported.json",
  ]) {
    const result = validatePreflightDecision(
      loadPreflightFixture(fixtureName),
    );
    assert.equal(result.valid, true, fixtureName);
  }
});

test("migration contract: preflight validator rejects missing fields and illegal semantic states", () => {
  const missingFields = validatePreflightDecision({
    decision: "PROCEED",
    confidence: 0.8,
  });
  const badDecision = validatePreflightDecision({
    ...loadPreflightFixture("proceed.json"),
    decision: "WRITE_ANYWAY",
  });
  const askWithoutQuestions = validatePreflightDecision({
    ...loadPreflightFixture("ask-user.json"),
    blockingQuestions: [],
  });
  const stopWithoutUnsupportedTargets = validatePreflightDecision({
    ...loadPreflightFixture("stop-unsupported.json"),
    unsupportedTargets: [],
  });

  assert.equal(missingFields.valid, false);
  assert.match(
    missingFields.errors.join("\n"),
    /missingEvidence must be an array/,
  );
  assert.match(badDecision.errors.join("\n"), /decision must be one of/);
  assert.match(
    askWithoutQuestions.errors.join("\n"),
    /blockingQuestions must contain at least 1 item/,
  );
  assert.match(
    stopWithoutUnsupportedTargets.errors.join("\n"),
    /unsupportedTargets must contain at least 1 item/,
  );
});

test("migration contract: preflight validation outcome keeps strict failure messaging explicit", () => {
  const outcome = createPreflightValidationOutcome(
    validatePreflightDecision({
      ...loadPreflightFixture("proceed.json"),
      safeWritingScope: [],
    }),
    FAILURE_POLICY_MODES.LOCAL_CI,
  );

  assert.equal(outcome.shouldFail, true);
  assert.match(outcome.message, /前置门控输出不符合 v1 合同/);
  assert.match(outcome.message, /safeWritingScope/);
});

test("migration contract: optimization decision accepts every allowlisted action", () => {
  const fixture = loadOptimizationFixture("valid-actions.json");

  assert.equal(OPTIMIZATION_DECISION_SCHEMA_VERSION, "v1");
  assert.deepEqual(
    fixture.cases.map((testCase) => testCase.decision.action),
    OPTIMIZATION_ACTIONS,
  );
  for (const testCase of fixture.cases) {
    assert.equal(
      validateOptimizationDecision(testCase.decision).valid,
      true,
      testCase.name,
    );
  }
});

test("migration contract: optimization decision rejects every invalid action fixture", () => {
  const fixture = loadOptimizationFixture("invalid-actions.json");

  for (const testCase of fixture.cases) {
    const result = validateOptimizationDecision(testCase.decision);
    assert.equal(result.valid, false, testCase.name);
    assert.ok(result.errors.length > 0, testCase.name);
  }

  const missingEvidenceRefs = validateOptimizationDecision({
    action: "KEYWORD_OPTIMIZE",
    target: "content.skills",
    reason: "Missing required field.",
    expectedImprovement: "Improve ATS alignment.",
    risk: "low",
  });
  assert.equal(missingEvidenceRefs.valid, false);
  assert.match(missingEvidenceRefs.errors.join("\n"), /evidenceRefs/);
});

test("migration contract: legacy real artifact is rejected explicitly", () => {
  const result = validateLegacyReviewShape(loadFixture("legacy-real-artifact.json"));

  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /legacy field/);
  assert.match(result.errors.join("\n"), /ruthlessDissection/);
  assert.match(result.errors.join("\n"), /eliminationWarning/);
});

test("migration contract: semantic invariants retain verdict checks while allowing empty evidence gaps", () => {
  const result = validateLegacyReviewShape(loadFixture("semantic-invalid.json"));

  assert.equal(result.valid, false);
  assert.match(
    result.errors.join("\n"),
    /keepAsIs must contain at least 1 item/,
  );
  assert.doesNotMatch(
    result.errors.join("\n"),
    /evidenceGap must contain at least 1 item/,
  );
  assert.match(
    result.errors.join("\n"),
    /overall\.pass must be true when overall\.verdict is PASS/,
  );
});

test("migration contract: manual mode preserves readable review contract failure messaging", () => {
  const fixture = loadFixture(
    "failure-policy-validation-outcomes.json",
  ).cases.find((item) => item.mode === FAILURE_POLICY_MODES.MANUAL);
  const outcome = createReviewValidationOutcome(
    fixture.validation,
    fixture.mode,
  );

  assert.equal(outcome.shouldFail, fixture.expectedShouldFail);
  for (const snippet of fixture.expectedMessageIncludes) {
    assert.match(outcome.message, new RegExp(snippet));
  }
});

test("migration contract: fixture-backed CI-like failure-policy parity rejects invalid review payloads", () => {
  const fixture = loadFixture(
    "failure-policy-validation-outcomes.json",
  ).cases.find((item) => item.mode === FAILURE_POLICY_MODES.LOCAL_CI);
  const outcome = createReviewValidationOutcome(
    fixture.validation,
    fixture.mode,
  );

  assert.equal(outcome.shouldFail, fixture.expectedShouldFail);
  for (const snippet of fixture.expectedMessageIncludes) {
    assert.match(outcome.message, new RegExp(snippet));
  }
});

test("migration contract: failure-policy mode resolution preserves manual, local-ci, and github-actions strings", () => {
  const fixture = loadFixture("failure-policy-mode-resolution.json");

  for (const testCase of fixture.cases) {
    assert.equal(
      resolveFailurePolicyMode(testCase.env),
      testCase.expectedMode,
      testCase.name,
    );
  }
});

test("migration contract: review-policy loop score sequence matches source-of-truth fixture", () => {
  const fixture = loadFixture("loop-score-sequence.json");

  for (const testCase of fixture.cases) {
    let state = createReviewPolicyState({
      initialResumePath: "initial-resume.yml",
      maxRounds: testCase.maxRounds,
    });

    testCase.rounds.forEach((round, index) => {
      const report = buildReviewPolicyReport(round);
      const validation = validateReviewShape(report);
      assert.equal(
        validation.valid,
        true,
        `${testCase.name} round ${index + 1} review payload should remain valid`,
      );

      const result = applyReviewPolicyRound(state, {
        round: index + 1,
        resumePath: `draft-r${index + 1}.yml`,
        reviewPath: `review-r${index + 1}.json`,
        report,
      });

      state = result.state;

      assert.equal(
        result.decision.bestResumePath,
        round.expectedBestResumePath,
        `${testCase.name} round ${index + 1} bestResumePath`,
      );
      assert.equal(
        result.decision.bestReviewPath,
        round.expectedBestReviewPath,
        `${testCase.name} round ${index + 1} bestReviewPath`,
      );
      assert.equal(
        result.decision.stopReason,
        round.expectedStopReason,
        `${testCase.name} round ${index + 1} stopReason`,
      );
    });
  }
});

test("migration contract: v2 Best selection prioritizes P0/P1/P2 counts before score and stops on PASS", () => {
  const first = cloneFixture("review-v2.json");
  first.verdict = "REVISE";
  first.overallScore = 95;
  first.topIssues[0].priority = "P1";

  const second = cloneFixture("review-v2.json");
  second.verdict = "REVISE";
  second.overallScore = 60;
  second.topIssues = [];
  second.jdCoverage = { strong: [], weak: [], unsupported: [] };

  const third = cloneFixture("review-v2.json");
  third.verdict = "REVISE";
  third.overallScore = 80;
  third.topIssues = [];
  third.jdCoverage = { strong: [], weak: [], unsupported: [] };

  const pass = cloneFixture("review-v2.json");
  pass.verdict = "PASS";
  pass.topIssues = [];
  pass.jdCoverage = { strong: [], weak: [], unsupported: [] };

  let state = createReviewPolicyState({ initialResumePath: "initial.yml", maxRounds: 4 });
  const firstResult = applyReviewPolicyRound(state, { round: 1, resumePath: "r1.yml", reviewPath: "r1.json", report: first });
  state = firstResult.state;
  const secondResult = applyReviewPolicyRound(state, { round: 2, resumePath: "r2.yml", reviewPath: "r2.json", report: second });
  state = secondResult.state;
  const thirdResult = applyReviewPolicyRound(state, { round: 3, resumePath: "r3.yml", reviewPath: "r3.json", report: third });
  state = thirdResult.state;
  const passResult = applyReviewPolicyRound(state, { round: 4, resumePath: "r4.yml", reviewPath: "r4.json", report: pass });

  assert.equal(firstResult.decision.improved, true);
  assert.equal(secondResult.decision.improved, true);
  assert.equal(secondResult.decision.bestResumePath, "r2.yml");
  assert.equal(thirdResult.decision.improved, true);
  assert.equal(thirdResult.decision.bestResumePath, "r3.yml");
  assert.equal(passResult.decision.shouldStop, true);
  assert.equal(passResult.decision.stopReason, "pass");
});
