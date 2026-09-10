import {
  allowPolicy,
  createGovernanceReason,
  denyPolicy,
} from "./governance-reasons.js";
import type {
  BoundedResumeGoalPlan,
  ResumeGoalPlanInput,
  ResumePlanStep,
} from "./types.js";

function normalizeGoal(goal: string) {
  return goal.trim().toLowerCase();
}

function isResumeWorkflowGoal(goal: string) {
  return /(resume|cv|interview|review|job|application)/i.test(goal);
}

function shouldIncludeInterview(goal: string, includeInterview?: boolean) {
  if (typeof includeInterview === "boolean") {
    return includeInterview;
  }

  return /(interview|full workflow|full flow|end-to-end|pipeline)/i.test(goal);
}

function createStep(
  id: ResumePlanStep["id"],
  rationale: string,
): ResumePlanStep {
  return { id, rationale };
}

export function createResumeGoalPlan(input: ResumeGoalPlanInput) {
  const goal = String(input.goal ?? "").trim();
  if (!goal || !isResumeWorkflowGoal(goal)) {
    return denyPolicy(
      createGovernanceReason(
        "OUT_OF_SCOPE_GOAL",
        "Only bounded resume-oriented workflow goals are supported.",
        { goal },
      ),
    );
  }

  if (
    input.requestedReviewRounds === "unbounded" ||
    (typeof input.requestedReviewRounds === "number" &&
      Number.isFinite(input.requestedReviewRounds) &&
      input.requestedReviewRounds > 1)
  ) {
    return denyPolicy(
      createGovernanceReason(
        "UNBOUNDED_PLAN",
        "Planner only supports a single review step; repeated review loops belong to the supervisor.",
        { requestedReviewRounds: input.requestedReviewRounds },
      ),
    );
  }

  const normalizedGoal = normalizeGoal(goal);
  const steps: ResumePlanStep[] = [];

  if (!input.hasTimelineContext) {
    steps.push(
      createStep(
        "mine",
        "Collect missing timeline context before drafting the resume.",
      ),
    );
  }

  steps.push(
    createStep(
      "jd-analysis",
      "Analyze the target company and role before deciding whether writing is supported.",
    ),
    createStep(
      "preflight",
      "Run the preflight gate before allowing resume drafting.",
    ),
    createStep("write", "Draft the resume before any evaluation step."),
    createStep(
      "review",
      "Evaluate the draft once before any optional interview prep.",
    ),
  );

  if (shouldIncludeInterview(normalizedGoal, input.includeInterview)) {
    steps.push(
      createStep(
        "interview",
        "Prepare interview materials after the reviewed resume workflow.",
      ),
    );
  }

  const plan: BoundedResumeGoalPlan = {
    goalFamily: "resume-workflow",
    goal,
    steps,
    maxSteps: steps.length,
    reviewMode: "single-pass",
  };

  return allowPolicy(plan);
}
