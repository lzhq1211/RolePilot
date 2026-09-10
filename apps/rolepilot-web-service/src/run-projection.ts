import {
  RUN_EVENT_TYPES,
  RUN_FAILURE_CODES,
  RUN_STATUSES,
  RUN_STEP_IDS,
  RUN_STEP_STATUSES,
  RUN_STOP_REASONS,
  validateRunEvent,
  validateRunStepStatuses,
  type RunEvent,
} from "web-contracts";

import { RunRepositoryError, type RunRecord } from "./run-types.js";

export function initialRunStepStatuses() {
  return RUN_STEP_IDS.map((id) => ({ id, status: "pending" as const }));
}

export function applyRunEvent(record: RunRecord, event: RunEvent): RunRecord {
  const validation = validateRunEvent(event);
  if (!validation.valid) {
    throw new RunRepositoryError("CONTRACT_INVALID", validation.errors.join("; "));
  }
  if (event.runId !== record.id) {
    throw new RunRepositoryError("CONTRACT_INVALID", "Run event belongs to another run.");
  }
  if (event.sequence !== record.lastEventSequence + 1) {
    throw new RunRepositoryError("RUN_CONFLICT", "Run event sequence is not contiguous.");
  }

  const next = structuredClone(record);
  next.lastEventSequence = event.sequence;
  next.updatedAt = event.createdAt;

  switch (event.type) {
    case "run.status":
      next.status = event.payload.status;
      next.stopReason = event.payload.stopReason;
      next.failureCode = event.payload.failureCode;
      break;
    case "run.step":
      updateStep(next, event.payload.stepId, event.payload.status);
      break;
    case "run.progress":
      break;
    case "run.artifact":
      if (!next.artifactIds.includes(event.payload.artifactId)) {
        next.artifactIds.push(event.payload.artifactId);
      }
      break;
    case "run.completed":
      next.status = "COMPLETED";
      next.stopReason = event.payload.stopReason;
      next.failureCode = null;
      next.completedAt = event.createdAt;
      break;
    case "run.cancelled":
      next.status = "CANCELLED";
      next.stopReason = "cancelled";
      next.failureCode = null;
      next.completedAt = event.createdAt;
      break;
    case "run.failed":
      next.status = "FAILED";
      next.stopReason = null;
      next.failureCode = event.payload.failureCode;
      next.completedAt = event.createdAt;
      break;
  }

  const stepsValidation = validateRunStepStatuses(next.stepStatuses);
  if (!stepsValidation.valid) {
    throw new RunRepositoryError("CONTRACT_INVALID", stepsValidation.errors.join("; "));
  }
  return next;
}

export function assertRunStatusTransition(current: string, next: string): void {
  if (!RUN_STATUSES.includes(current as (typeof RUN_STATUSES)[number])) {
    throw new RunRepositoryError("CONTRACT_INVALID", "Current Run status is invalid.");
  }
  if (!RUN_STATUSES.includes(next as (typeof RUN_STATUSES)[number])) {
    throw new RunRepositoryError("CONTRACT_INVALID", "Next Run status is invalid.");
  }
  if (["COMPLETED", "UNSUPPORTED", "FAILED", "CANCELLED"].includes(current)) {
    throw new RunRepositoryError("RUN_CONFLICT", "Terminal Run cannot be changed.");
  }
  if (current === next) return;

  const allowed = new Set([
    "DRAFT>READY",
    "READY>QUEUED",
    "QUEUED>RUNNING",
    "QUEUED>CANCELLED",
    "RUNNING>NEEDS_USER_INPUT",
    "RUNNING>COMPLETED",
    "RUNNING>UNSUPPORTED",
    "RUNNING>FAILED",
    "RUNNING>CANCELLED",
    "NEEDS_USER_INPUT>QUEUED",
  ]);
  if (!allowed.has(`${current}>${next}`)) {
    throw new RunRepositoryError("RUN_CONFLICT", `Illegal Run status transition: ${current} -> ${next}.`);
  }
}

function updateStep(record: RunRecord, stepId: (typeof RUN_STEP_IDS)[number], status: (typeof RUN_STEP_STATUSES)[number]): void {
  const step = record.stepStatuses.find((candidate) => candidate.id === stepId);
  if (!step) {
    throw new RunRepositoryError("CONTRACT_INVALID", "Run event references an unknown step.");
  }
  step.status = status;
  if (status === "running" || status === "waiting") record.currentStep = stepId;
}

export function assertControlledRunFields(status: string, stopReason: string | null, failureCode: string | null): void {
  if (status === "FAILED" && (!failureCode || !RUN_FAILURE_CODES.includes(failureCode as (typeof RUN_FAILURE_CODES)[number]) || stopReason !== null)) {
    throw new RunRepositoryError("CONTRACT_INVALID", "FAILED requires failureCode and no stopReason.");
  }
  if (status !== "FAILED" && failureCode !== null) {
    throw new RunRepositoryError("CONTRACT_INVALID", "Only FAILED may have failureCode.");
  }
  if (stopReason !== null && !RUN_STOP_REASONS.includes(stopReason as (typeof RUN_STOP_REASONS)[number])) {
    throw new RunRepositoryError("CONTRACT_INVALID", "Run stopReason is not controlled.");
  }
}
