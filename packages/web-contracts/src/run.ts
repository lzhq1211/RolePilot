export const RUN_STATUSES = [
  "DRAFT",
  "READY",
  "QUEUED",
  "RUNNING",
  "NEEDS_USER_INPUT",
  "COMPLETED",
  "UNSUPPORTED",
  "FAILED",
  "CANCELLED",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export type ExternalRunStatus = Exclude<RunStatus, "DRAFT" | "READY">;

export const RUN_STEP_IDS = ["mine", "jd-analysis", "preflight", "write", "review"] as const;
export type RunStepId = (typeof RUN_STEP_IDS)[number];

export const RUN_STEP_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "waiting",
  "skipped",
] as const;
export type RunStepStatus = (typeof RUN_STEP_STATUSES)[number];

export const RUN_FAILURE_CODES = [
  "WORKER_INTERRUPTED",
  "RUN_EXECUTION_FAILED",
  "SOURCE_TEXT_UNAVAILABLE",
  "CHECKPOINT_INVALID",
  "ARTIFACT_PERSIST_FAILED",
] as const;
export type RunFailureCode = (typeof RUN_FAILURE_CODES)[number];

export const RUN_STOP_REASONS = [
  "needs-user-input",
  "unsupported-input",
  "pass",
  "early-stop",
  "max-rounds",
  "cancelled",
] as const;
export type RunStopReason = (typeof RUN_STOP_REASONS)[number];

export const RUN_EVENT_TYPES = [
  "run.status",
  "run.step",
  "run.progress",
  "run.artifact",
  "run.completed",
  "run.cancelled",
  "run.failed",
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export const RUN_EVIDENCE_STATUSES = ["PENDING", "CONSUMED", "ABANDONED"] as const;
export type RunEvidenceStatus = (typeof RUN_EVIDENCE_STATUSES)[number];

export const RUN_CLEANUP_STATUSES = [
  "NOT_REQUESTED",
  "PENDING",
  "COMPLETED",
  "FAILED",
] as const;
export type RunCleanupStatus = (typeof RUN_CLEANUP_STATUSES)[number];

export const RUN_ARTIFACT_TYPES = [
  "timeline",
  "jd-analysis",
  "preflight",
  "questions",
  "unsupported",
  "resume",
  "review-report",
  "optimization-decision",
  "supplemental-evidence",
  "checkpoint",
  "checkpoint-manifest",
  "log",
] as const;
export type RunArtifactType = (typeof RUN_ARTIFACT_TYPES)[number];

export const RUN_ARTIFACT_STATUSES = [
  "STAGED",
  "PUBLISHED",
  "CLEANUP_PENDING",
  "DELETED",
] as const;
export type RunArtifactStatus = (typeof RUN_ARTIFACT_STATUSES)[number];

export const RUN_LIMITS = Object.freeze({
  maxEvidenceCodePoints: 20_000,
  maxEvidenceBodyBytes: 128 * 1024,
} as const);

export type RunStepStatusDto = {
  id: RunStepId;
  status: RunStepStatus;
};

export type RunDto = {
  id: string;
  status: RunStatus;
  company: string;
  title: string;
  resumeSourceId: string;
  currentStep: RunStepId | null;
  stepStatuses: RunStepStatusDto[];
  stopReason: RunStopReason | null;
  failureCode: RunFailureCode | null;
  pendingUserQuestions: string[];
  artifactIds: string[];
  checkpointArtifactId: string | null;
  parentRunId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type RunListDto = {
  items: RunDto[];
  nextCursor: string | null;
};

export type RunEvidenceInput = {
  evidenceText: string;
};

export type CancelRunInput = Record<string, never>;

type RunEventBase<Type extends RunEventType, Payload> = {
  id: string;
  runId: string;
  sequence: number;
  type: Type;
  payload: Payload;
  createdAt: string;
};

export type RunStatusEvent = RunEventBase<
  "run.status",
  {
    runId: string;
    status: ExternalRunStatus;
    stopReason: RunStopReason | null;
    failureCode: RunFailureCode | null;
  }
>;

export type RunStepEvent = RunEventBase<
  "run.step",
  {
    runId: string;
    stepId: RunStepId;
    status: RunStepStatus;
    durationMs: number | null;
  }
>;

export type RunProgressEvent = RunEventBase<
  "run.progress",
  {
    runId: string;
    stepId: RunStepId;
    progress: number;
    durationMs: number | null;
  }
>;

export type RunArtifactEvent = RunEventBase<
  "run.artifact",
  {
    runId: string;
    artifactId: string;
  }
>;

export type RunCompletedEvent = RunEventBase<
  "run.completed",
  {
    runId: string;
    status: "COMPLETED";
    stopReason: Extract<RunStopReason, "pass" | "early-stop" | "max-rounds">;
  }
>;

export type RunCancelledEvent = RunEventBase<
  "run.cancelled",
  {
    runId: string;
    status: "CANCELLED";
    stopReason: "cancelled";
  }
>;

export type RunFailedEvent = RunEventBase<
  "run.failed",
  {
    runId: string;
    status: "FAILED";
    failureCode: RunFailureCode;
  }
>;

export type RunEvent =
  | RunStatusEvent
  | RunStepEvent
  | RunProgressEvent
  | RunArtifactEvent
  | RunCompletedEvent
  | RunCancelledEvent
  | RunFailedEvent;

export type ContractValidationResult =
  | { valid: true; errors: [] }
  | { valid: false; errors: string[] };

export function validateRunStepStatuses(value: unknown): ContractValidationResult {
  if (!Array.isArray(value)) {
    return invalid(["stepStatuses must be an array"]);
  }
  if (value.length !== RUN_STEP_IDS.length) {
    return invalid([`stepStatuses must contain exactly ${RUN_STEP_IDS.length} steps`]);
  }

  const errors: string[] = [];
  const ids: unknown[] = [];
  for (const [index, step] of value.entries()) {
    if (!isRecord(step)) {
      errors.push(`stepStatuses[${index}] must be an object`);
      continue;
    }
    if (!hasOnlyKeys(step, ["id", "status"])) {
      errors.push(`stepStatuses[${index}] contains unknown fields`);
    }
    ids.push(step.id);
    if (!isOneOf(step.id, RUN_STEP_IDS)) {
      errors.push(`stepStatuses[${index}].id must be a known step`);
    }
    if (!isOneOf(step.status, RUN_STEP_STATUSES)) {
      errors.push(`stepStatuses[${index}].status must be a known step status`);
    }
  }

  if (new Set(ids).size !== ids.length) {
    errors.push("stepStatuses must not contain duplicate step ids");
  }
  if (errors.length === 0 && !RUN_STEP_IDS.every((id) => ids.includes(id))) {
    errors.push("stepStatuses must contain all five required steps");
  }
  return errors.length === 0 ? valid() : invalid(errors);
}

export function validateRunDto(value: unknown): ContractValidationResult {
  if (!isRecord(value)) return invalid(["RunDto must be an object"]);

  const errors: string[] = [];
  const expectedKeys = [
    "id",
    "status",
    "company",
    "title",
    "resumeSourceId",
    "currentStep",
    "stepStatuses",
    "stopReason",
    "failureCode",
    "pendingUserQuestions",
    "artifactIds",
    "checkpointArtifactId",
    "parentRunId",
    "createdAt",
    "updatedAt",
    "completedAt",
  ];
  if (!hasOnlyKeys(value, expectedKeys)) errors.push("RunDto contains unknown fields");

  for (const field of ["id", "company", "title", "resumeSourceId", "createdAt", "updatedAt"]) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      errors.push(`${field} must be a non-empty string`);
    }
  }
  if (!isOneOf(value.status, RUN_STATUSES)) errors.push("status must be a known Run status");
  if (value.currentStep !== null && !isOneOf(value.currentStep, RUN_STEP_IDS)) {
    errors.push("currentStep must be a known step or null");
  }
  const stepsResult = validateRunStepStatuses(value.stepStatuses);
  if (!stepsResult.valid) errors.push(...stepsResult.errors);
  if (value.stopReason !== null && !isOneOf(value.stopReason, RUN_STOP_REASONS)) {
    errors.push("stopReason must be a known stop reason or null");
  }
  if (value.failureCode !== null && !isOneOf(value.failureCode, RUN_FAILURE_CODES)) {
    errors.push("failureCode must be a known failure code or null");
  }
  const pendingUserQuestions = value.pendingUserQuestions;
  if (!isStringArray(pendingUserQuestions)) {
    errors.push("pendingUserQuestions must be an array of strings");
  }
  const artifactIds = value.artifactIds;
  if (!isStringArray(artifactIds)) {
    errors.push("artifactIds must be an array of strings");
  }
  for (const field of ["checkpointArtifactId", "parentRunId", "completedAt"]) {
    if (value[field] !== null && typeof value[field] !== "string") {
      errors.push(`${field} must be a string or null`);
    }
  }

  errors.push(...validateRunTerminalFields(value.status, value.stopReason, value.failureCode));
  if (
    errors.length === 0 &&
    value.status === "NEEDS_USER_INPUT" &&
    isStringArray(pendingUserQuestions) &&
    pendingUserQuestions.length === 0
  ) {
    errors.push("NEEDS_USER_INPUT must include pendingUserQuestions");
  }
  return errors.length === 0 ? valid() : invalid(errors);
}

export function validateRunEvidenceInput(value: unknown): ContractValidationResult {
  if (!isRecord(value) || !hasOnlyKeys(value, ["evidenceText"])) {
    return invalid(["evidence input must contain only evidenceText"]);
  }
  if (typeof value.evidenceText !== "string" || value.evidenceText.trim().length === 0) {
    return invalid(["evidenceText must be a non-empty string"]);
  }
  if ([...value.evidenceText].length > RUN_LIMITS.maxEvidenceCodePoints) {
    return invalid([`evidenceText must not exceed ${RUN_LIMITS.maxEvidenceCodePoints} code points`]);
  }
  return valid();
}

export function validateRunEvent(value: unknown): ContractValidationResult {
  if (!isRecord(value)) return invalid(["RunEvent must be an object"]);
  if (!hasOnlyKeys(value, ["id", "runId", "sequence", "type", "payload", "createdAt"])) {
    return invalid(["RunEvent contains unknown fields"]);
  }
  const errors: string[] = [];
  for (const field of ["id", "runId", "createdAt"]) {
    if (typeof value[field] !== "string" || value[field].length === 0) {
      errors.push(`${field} must be a non-empty string`);
    }
  }
  const sequence = value.sequence;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) {
    errors.push("sequence must be a positive safe integer");
  }
  if (!isOneOf(value.type, RUN_EVENT_TYPES)) errors.push("type must be a known Run event type");
  const payload = value.payload;
  if (!isRecord(payload)) return invalid([...errors, "payload must be an object"]);
  if (errors.length > 0) return invalid(errors);

  if (payload.runId !== value.runId) errors.push("payload.runId must match runId");
  switch (value.type) {
    case "run.status":
      if (!hasOnlyKeys(payload, ["runId", "status", "stopReason", "failureCode"])) {
        errors.push("run.status payload contains unknown fields");
      }
      if (!isOneOf(payload.status, RUN_STATUSES.filter((status) => status !== "DRAFT" && status !== "READY"))) {
        errors.push("run.status payload has an invalid status");
      }
      errors.push(...validateRunTerminalFields(payload.status, payload.stopReason, payload.failureCode));
      break;
    case "run.step":
      validateStepPayload(payload, errors);
      break;
    case "run.progress":
      validateStepPayload(payload, errors, true);
      if (typeof payload.progress !== "number" || !Number.isFinite(payload.progress) || payload.progress < 0 || payload.progress > 1) {
        errors.push("run.progress payload.progress must be between 0 and 1");
      }
      break;
    case "run.artifact":
      if (!hasOnlyKeys(payload, ["runId", "artifactId"])) errors.push("run.artifact payload contains unknown fields");
      if (typeof payload.artifactId !== "string" || payload.artifactId.length === 0) {
        errors.push("run.artifact payload.artifactId must be a non-empty string");
      }
      break;
    case "run.completed":
      if (!hasOnlyKeys(payload, ["runId", "status", "stopReason"])) errors.push("run.completed payload contains unknown fields");
      if (payload.status !== "COMPLETED") errors.push("run.completed payload.status must be COMPLETED");
      if (!isOneOf(payload.stopReason, ["pass", "early-stop", "max-rounds"])) errors.push("run.completed payload has an invalid stopReason");
      break;
    case "run.cancelled":
      if (!hasOnlyKeys(payload, ["runId", "status", "stopReason"])) errors.push("run.cancelled payload contains unknown fields");
      if (payload.status !== "CANCELLED") errors.push("run.cancelled payload.status must be CANCELLED");
      if (payload.stopReason !== "cancelled") errors.push("run.cancelled payload.stopReason must be cancelled");
      break;
    case "run.failed":
      if (!hasOnlyKeys(payload, ["runId", "status", "failureCode"])) errors.push("run.failed payload contains unknown fields");
      if (payload.status !== "FAILED") errors.push("run.failed payload.status must be FAILED");
      if (!isOneOf(payload.failureCode, RUN_FAILURE_CODES)) errors.push("run.failed payload has an invalid failureCode");
      break;
  }
  return errors.length === 0 ? valid() : invalid(errors);
}

function validateStepPayload(
  payload: Record<string, unknown>,
  errors: string[],
  allowProgress = false,
): void {
  const allowedKeys = ["runId", "stepId", "status", "durationMs"];
  if (allowProgress) allowedKeys.push("progress");
  if (!hasOnlyKeys(payload, allowedKeys)) {
    errors.push("step event payload contains unknown fields");
  }
  if (!isOneOf(payload.stepId, RUN_STEP_IDS)) errors.push("step event payload.stepId is invalid");
  if (!isOneOf(payload.status, RUN_STEP_STATUSES)) errors.push("step event payload.status is invalid");
  const durationMs = payload.durationMs;
  if (durationMs !== null && (typeof durationMs !== "number" || !Number.isSafeInteger(durationMs) || durationMs < 0)) {
    errors.push("step event payload.durationMs must be a non-negative integer or null");
  }
}

function validateRunTerminalFields(
  status: unknown,
  stopReason: unknown,
  failureCode: unknown,
): string[] {
  const errors: string[] = [];
  if (status === "FAILED") {
    if (!isOneOf(failureCode, RUN_FAILURE_CODES)) errors.push("FAILED requires a known failureCode");
    if (stopReason !== null) errors.push("FAILED requires stopReason to be null");
  } else if (failureCode !== null) {
    errors.push("only FAILED may have a failureCode");
  }

  const requiredReasons: Partial<Record<RunStatus, RunStopReason>> = {
    NEEDS_USER_INPUT: "needs-user-input",
    UNSUPPORTED: "unsupported-input",
    CANCELLED: "cancelled",
  };
  const requiredReason = requiredReasons[status as RunStatus];
  if (requiredReason && stopReason !== requiredReason) {
    errors.push(`${status} requires stopReason=${requiredReason}`);
  }
  if (status === "COMPLETED" && !isOneOf(stopReason, ["pass", "early-stop", "max-rounds"])) {
    errors.push("COMPLETED requires a controlled completion stopReason");
  }
  if (["DRAFT", "READY", "QUEUED", "RUNNING"].includes(status as string) && stopReason !== null) {
    errors.push(`${status} requires stopReason to be null`);
  }
  return errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hasOnlyKeys(record: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every((key) => allowed.has(key));
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function valid(): { valid: true; errors: [] } {
  return { valid: true, errors: [] };
}

function invalid(errors: string[]): { valid: false; errors: string[] } {
  return { valid: false, errors };
}
