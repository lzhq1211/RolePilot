import { createGovernanceReason } from "./governance-reasons.js";
import type {
  ResumePlanStep,
  SupervisorDecision,
  SupervisorInput,
} from "./types.js";

const REVIEW_REPLAN: ResumePlanStep[] = [
  {
    id: "write",
    rationale: "Revise the resume once before re-running review.",
  },
  {
    id: "review",
    rationale: "Re-check the revised resume within the bounded review budget.",
  },
];

export function superviseStep(input: SupervisorInput): SupervisorDecision {
  if (input.currentStep === "interview" && input.status === "succeeded") {
    return {
      decision: "complete",
      reasons: [],
      nextPlan: null,
    };
  }

  if (input.currentStep !== "review") {
    return {
      decision: input.status === "succeeded" ? "continue" : "escalate",
      reasons: [],
      nextPlan: null,
    };
  }

  if (input.status === "succeeded" && input.reviewPassed === true) {
    return {
      decision: "complete",
      reasons: [],
      nextPlan: null,
    };
  }

  const used = input.reviewReplansUsed ?? 0;
  const budget = input.reviewReplanBudget ?? 0;
  if (used < budget) {
    return {
      decision: "replan",
      reasons: [],
      nextPlan: REVIEW_REPLAN.map((step) => ({ ...step })),
    };
  }

  return {
    decision: "escalate",
    reasons: [
      createGovernanceReason(
        "REVIEW_BUDGET_EXHAUSTED",
        "Supervisor exhausted the bounded review replan budget.",
        { used, budget },
      ),
    ],
    nextPlan: null,
  };
}
