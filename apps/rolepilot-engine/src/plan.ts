import { createResumeGoalPlan } from "platform-policy";

import { buildResumeGoalInput, createPlanStepStatuses } from "./shared.js";
import type {
  ResumeAppPlanStepStatus,
  ResumeVerticalSliceInput,
} from "./types.js";

export function createResumeGoalInterfacePlan(
  input: ResumeVerticalSliceInput,
): ResumeAppPlanStepStatus[] {
  const policy = createResumeGoalPlan(buildResumeGoalInput(input));
  if (!policy.ok) {
    throw new Error(policy.reasons[0]?.message ?? "Resume plan was denied.");
  }

  return createPlanStepStatuses(policy.value.steps);
}
