import type {
  RunArtifactStatus,
  RunArtifactType,
  RunCleanupStatus,
  RunDto,
  RunEvidenceStatus,
  RunEvent,
  RunFailureCode,
  RunStatus,
  RunStepId,
  RunStepStatusDto,
  RunStopReason,
} from "web-contracts";

export type RunRecord = RunDto & {
  deploymentInstanceId: string;
  lastEventSequence: number;
  jdText: string;
  resumeAppRunId: string | null;
  pendingEvidenceSubmissionId: string | null;
  cleanupStatus: RunCleanupStatus;
  deletedAt: string | null;
  finalResumeArtifactId: string | null;
};

export type CreateRunRecord = {
  deploymentInstanceId?: string;
  id: string;
  resumeSourceId: string;
  company: string;
  title: string;
  jdText: string;
  extractedTextObjectKey: string;
  createdAt: string;
  eventId: string;
};

export type RunTransitionInput = {
  runId: string;
  expectedStatus: RunStatus;
  nextStatus: RunStatus;
  currentStep: RunStepId | null;
  stepStatuses: RunStepStatusDto[];
  stopReason: RunStopReason | null;
  failureCode: RunFailureCode | null;
  completedAt: string | null;
  pendingUserQuestions?: string[];
  artifactIds?: string[];
  checkpointArtifactId?: string | null;
  finalResumeArtifactId?: string | null;
  cleanupStatus?: RunCleanupStatus;
  event: RunEvent;
};

export type RunArtifactRecord = {
  id: string;
  runId: string;
  deploymentInstanceId: string;
  role: "supporting" | "final-resume" | "derived";
  artifactType: RunArtifactType;
  stage: string;
  status: RunArtifactStatus;
  storageObjectKey: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  publishedAt: string | null;
  cleanupRequestedAt: string | null;
  deletedAt: string | null;
};

export type CreateRunArtifactInput = Omit<
  RunArtifactRecord,
  "createdAt" | "publishedAt" | "cleanupRequestedAt" | "deletedAt" | "deploymentInstanceId" | "role"
> & {
  deploymentInstanceId?: string;
  role?: RunArtifactRecord["role"];
};

export type RunEvidenceSubmissionRecord = {
  id: string;
  runId: string;
  deploymentInstanceId: string;
  requestFingerprint: string;
  storageObjectKey: string;
  byteLength: number;
  characterLength: number;
  status: RunEvidenceStatus;
  createdAt: string;
  consumedAt: string | null;
  abandonedAt: string | null;
};

export type CreateRunEvidenceInput = Omit<
  RunEvidenceSubmissionRecord,
  "createdAt" | "consumedAt" | "abandonedAt" | "status" | "deploymentInstanceId"
> & { deploymentInstanceId?: string };

export type RunRepositoryErrorCode =
  | "RUN_NOT_FOUND"
  | "RUN_CONFLICT"
  | "RUN_NOT_RESUMABLE"
  | "IDEMPOTENCY_CONFLICT"
  | "CONTRACT_INVALID"
  | "ARTIFACT_NOT_FOUND"
  | "EVIDENCE_NOT_FOUND";

export class RunRepositoryError extends Error {
  readonly code: RunRepositoryErrorCode;

  constructor(code: RunRepositoryErrorCode, message: string = code) {
    super(message);
    this.name = "RunRepositoryError";
    this.code = code;
  }
}

export function toRunDto(record: RunRecord): RunDto {
  const {
    lastEventSequence: _lastEventSequence,
    jdText: _jdText,
    resumeAppRunId: _resumeAppRunId,
    pendingEvidenceSubmissionId: _pendingEvidenceSubmissionId,
    cleanupStatus: _cleanupStatus,
    deletedAt: _deletedAt,
    deploymentInstanceId: _deploymentInstanceId,
    finalResumeArtifactId: _finalResumeArtifactId,
    ...dto
  } = record;
  return structuredClone(dto);
}
