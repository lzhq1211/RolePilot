import { createHash } from "node:crypto";

import type { ResumeGoalPlanInput, ResumePlanStepId } from "platform-policy";

import type {
  ResumeAgentName,
  ResumeAppPlanStepStatus,
  ResumeTarget,
  ResumeVerticalSliceInput,
} from "./types.js";

export function slugify(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "artifact"
  );
}

export function toJsonText(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function stripMarkdownFences(text: string): string {
  return text
    .replace(/^```(?:ya?ml|json)?\s*\n?/gm, "")
    .replace(/\n?```\s*$/gm, "")
    .trim();
}

export function assertNonEmptyString(value: unknown, message: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }

  return value.trim();
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Stable error type for JSON.parse syntax failures. Policy layers use it to
 * distinguish a malformed model response from contract/shape validation errors;
 * the message text is unchanged.
 */
export class JsonSyntaxError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "JsonSyntaxError";
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isJsonSyntaxError(error: unknown): error is JsonSyntaxError {
  return error instanceof JsonSyntaxError;
}

export function parseJsonObject(text: string, label: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new JsonSyntaxError(`${label} contains invalid JSON: ${reason}`, {
      cause: error,
    });
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return parsed;
}

export function createArtifactBaseName(company: ResumeTarget) {
  const companyName =
    typeof company.company === "string" ? company.company : "target-company";
  const role =
    typeof company.title === "string"
      ? company.title
      : typeof company.role === "string"
        ? company.role
        : typeof company.jobTitle === "string"
          ? company.jobTitle
          : "resume-role";

  return `${slugify(companyName)}-${slugify(role)}`;
}

export function getGoalText(input: ResumeVerticalSliceInput) {
  const interviewSuffix =
    input.includeInterview === false ? "" : " with interview prep";
  return (
    input.goal ??
    `Resume vertical slice for ${String(input.company.company ?? "target company")}${interviewSuffix}`
  );
}

export function stepIdToAgent(stepId: ResumePlanStepId): ResumeAgentName {
  switch (stepId) {
    case "mine":
      return "miner";
    case "jd-analysis":
      return "writer";
    case "preflight":
      return "reviewer";
    case "write":
      return "writer";
    case "review":
      return "reviewer";
    case "interview":
      return "interviewer";
  }
}

export function createPlanStepStatuses(
  steps: Array<{ id: ResumePlanStepId; rationale: string }>,
): ResumeAppPlanStepStatus[] {
  return steps.map((step) => ({
    id: step.id,
    agent: stepIdToAgent(step.id),
    rationale: step.rationale,
  }));
}

export function buildResumeGoalInput(
  input: ResumeVerticalSliceInput,
): ResumeGoalPlanInput {
  return {
    goal: getGoalText(input),
    hasTimelineContext: input.importedResumeText?.trim()
      ? false
      : input.hasTimelineContext ?? Boolean(input.timelineText),
    includeInterview: input.includeInterview ?? true,
    requestedReviewRounds: 1,
  };
}

export function createPlanFingerprint(taskIds: string[]) {
  return createHash("sha256").update(taskIds.join("|"), "utf8").digest("hex");
}
