import {
  RUN_ARTIFACT_STATUSES,
  RUN_EVIDENCE_STATUSES,
  RUN_LIMITS,
  RUN_STATUSES,
  RUN_STEP_IDS,
  validateRunDto,
  type RunDto,
  type RunEvent,
  type RunStatus,
} from "web-contracts";

import { IdempotencyKeyConflictError } from "./errors.js";
import { applyRunEvent, assertRunStatusTransition, initialRunStepStatuses } from "./run-projection.js";
import {
  RunRepositoryError,
  toRunDto,
  type CreateRunArtifactInput,
  type CreateRunEvidenceInput,
  type CreateRunRecord,
  type RunArtifactRecord,
  type RunEvidenceSubmissionRecord,
  type RunRecord,
  type RunTransitionInput,
} from "./run-types.js";
import type { IdempotencyRecord } from "./types.js";
import { DEFAULT_DEPLOYMENT_INSTANCE_ID } from "./deployment.js";

export type CreateRunIdempotentInput = CreateRunRecord & {
  idempotencyKey: string;
  requestFingerprint: string;
  expiresAt: string;
};

export type CreateRunResult = {
  run: RunRecord;
  reused: boolean;
};

export interface RunRepository {
  create(input: CreateRunRecord): Promise<RunRecord>;
  createIdempotent(input: CreateRunIdempotentInput): Promise<CreateRunResult>;
  get(runId: string, options?: { includeDeleted?: boolean }): Promise<RunRecord | null>;
  list(options?: { includeDeleted?: boolean }): Promise<RunDto[]>;
  eventsAfter(runId: string, sequence: number): Promise<RunEvent[]>;
  transition(input: RunTransitionInput): Promise<RunRecord>;
  claimNext(eventId: string): Promise<RunRecord | null>;
  startupRecoverRunning(): Promise<number>;
  isReferencedByRun(sourceId: string): Promise<boolean>;
  softDelete(runId: string): Promise<RunRecord | null>;
  createArtifact(input: CreateRunArtifactInput): Promise<RunArtifactRecord>;
  getArtifact(artifactId: string): Promise<RunArtifactRecord | null>;
  updateArtifactStatus(
    artifactId: string,
    status: RunArtifactRecord["status"],
    at: string,
  ): Promise<RunArtifactRecord>;
  createEvidence(input: CreateRunEvidenceInput): Promise<RunEvidenceSubmissionRecord>;
  getEvidence(submissionId: string): Promise<RunEvidenceSubmissionRecord | null>;
  updateEvidenceStatus(
    submissionId: string,
    status: RunEvidenceSubmissionRecord["status"],
    at: string,
  ): Promise<RunEvidenceSubmissionRecord>;
}

export function createRunRepositoryState() {
  return { records: new Map<string, RunRecord>(), events: new Map<string, RunEvent[]>(),
    artifacts: new Map<string, RunArtifactRecord>(), evidence: new Map<string, RunEvidenceSubmissionRecord>(),
    idempotency: new Map<string, IdempotencyRecord>() };
}

export class InMemoryRunRepository implements RunRepository {
  readonly #records: Map<string, RunRecord>;
  readonly #events: Map<string, RunEvent[]>;
  readonly #artifacts: Map<string, RunArtifactRecord>;
  readonly #evidence: Map<string, RunEvidenceSubmissionRecord>;
  readonly #idempotency: Map<string, IdempotencyRecord>;
  readonly #clock: () => string;

  constructor({ clock = () => new Date().toISOString(), state = createRunRepositoryState() }: {
    clock?: () => string; state?: ReturnType<typeof createRunRepositoryState>;
  } = {}) {
    this.#clock = clock;
    this.#records = state.records;
    this.#events = state.events;
    this.#artifacts = state.artifacts;
    this.#evidence = state.evidence;
    this.#idempotency = state.idempotency;
  }

  async create(input: CreateRunRecord): Promise<RunRecord> {
    if (this.#records.has(input.id)) {
      throw new RunRepositoryError("RUN_CONFLICT", "Run id already exists.");
    }

    const record: RunRecord = {
      deploymentInstanceId: input.deploymentInstanceId ?? DEFAULT_DEPLOYMENT_INSTANCE_ID,
      id: input.id,
      status: "QUEUED",
      company: input.company,
      title: input.title,
      resumeSourceId: input.resumeSourceId,
      currentStep: null,
      stepStatuses: initialRunStepStatuses(),
      stopReason: null,
      failureCode: null,
      pendingUserQuestions: [],
      artifactIds: [],
      checkpointArtifactId: null,
      parentRunId: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      completedAt: null,
      lastEventSequence: 0,
      jdText: input.jdText,
      resumeAppRunId: null,
      pendingEvidenceSubmissionId: null,
      cleanupStatus: "NOT_REQUESTED",
      deletedAt: null,
      finalResumeArtifactId: null,
    };
    const event: RunEvent = {
      id: input.eventId,
      runId: input.id,
      sequence: 1,
      type: "run.status",
      payload: {
        runId: input.id,
        status: "QUEUED",
        stopReason: null,
        failureCode: null,
      },
      createdAt: input.createdAt,
    };
    const created = this.#applyTransition(record, {
      runId: input.id,
      expectedStatus: "QUEUED",
      nextStatus: "QUEUED",
      currentStep: null,
      stepStatuses: record.stepStatuses,
      stopReason: null,
      failureCode: null,
      completedAt: null,
      event,
    });
    this.#records.set(input.id, created);
    this.#events.set(input.id, [structuredClone(event)]);
    return structuredClone(created);
  }

  async createIdempotent(input: CreateRunIdempotentInput): Promise<CreateRunResult> {
    const compoundKey = idempotencyCompoundKey("runs.create", input.idempotencyKey);
    const existing = this.#idempotency.get(compoundKey);
    if (existing && existing.expiresAt > this.#clock()) {
      if (existing.requestFingerprint !== input.requestFingerprint || existing.resultKind !== "run") {
        throw new IdempotencyKeyConflictError();
      }
      const run = this.#records.get(existing.resultId);
      if (!run) throw new RunRepositoryError("RUN_CONFLICT", "Run idempotency target is missing.");
      return { run: structuredClone(run), reused: true };
    }
    if (existing) this.#idempotency.delete(compoundKey);

    const run = await this.create(input);
    this.#idempotency.set(compoundKey, {
      deploymentInstanceId: input.deploymentInstanceId ?? DEFAULT_DEPLOYMENT_INSTANCE_ID,
      requestFingerprint: input.requestFingerprint,
      resultKind: "run",
      resultId: input.id,
      sourceId: null,
      expiresAt: input.expiresAt,
    });
    return { run, reused: false };
  }

  async get(runId: string, { includeDeleted = false }: { includeDeleted?: boolean } = {}): Promise<RunRecord | null> {
    const record = this.#records.get(runId);
    if (!record || (!includeDeleted && record.deletedAt)) return null;
    return structuredClone(record);
  }

  async list({ includeDeleted = false }: { includeDeleted?: boolean } = {}): Promise<RunDto[]> {
    return Array.from(this.#records.values())
      .filter((record) => includeDeleted || !record.deletedAt)
      .sort((left, right) => {
        const created = right.createdAt.localeCompare(left.createdAt);
        return created || right.id.localeCompare(left.id);
      })
      .map(toRunDto);
  }

  async eventsAfter(runId: string, sequence: number): Promise<RunEvent[]> {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new RunRepositoryError("CONTRACT_INVALID", "Event sequence cursor is invalid.");
    }
    if (!this.#records.has(runId)) throw new RunRepositoryError("RUN_NOT_FOUND");
    return structuredClone((this.#events.get(runId) ?? []).filter((event) => event.sequence > sequence));
  }

  async transition(input: RunTransitionInput): Promise<RunRecord> {
    const current = this.#records.get(input.runId);
    if (!current || current.deletedAt) throw new RunRepositoryError("RUN_NOT_FOUND");
    const next = this.#applyTransition(current, input);
    this.#records.set(input.runId, next);
    const events = this.#events.get(input.runId) ?? [];
    events.push(structuredClone(input.event));
    this.#events.set(input.runId, events);
    return structuredClone(next);
  }

  async claimNext(eventId: string): Promise<RunRecord | null> {
    const next = Array.from(this.#records.values())
      .filter((record) => record.status === "QUEUED" && !record.deletedAt)
      .sort((left, right) => {
        const created = left.createdAt.localeCompare(right.createdAt);
        return created || left.id.localeCompare(right.id);
      })[0];
    if (!next) return null;

    const event: RunEvent = {
      id: eventId,
      runId: next.id,
      sequence: next.lastEventSequence + 1,
      type: "run.status",
      payload: {
        runId: next.id,
        status: "RUNNING",
        stopReason: null,
        failureCode: null,
      },
      createdAt: this.#clock(),
    };
    return this.transition({
      runId: next.id,
      expectedStatus: "QUEUED",
      nextStatus: "RUNNING",
      currentStep: null,
      stepStatuses: next.stepStatuses,
      stopReason: null,
      failureCode: null,
      completedAt: null,
      event,
    });
  }

  async startupRecoverRunning(): Promise<number> {
    const running = Array.from(this.#records.values()).filter(
      (record) => record.status === "RUNNING" && !record.deletedAt,
    );
    for (const record of running) {
      const event: RunEvent = {
        id: `recovery-${record.id}-${record.lastEventSequence + 1}`,
        runId: record.id,
        sequence: record.lastEventSequence + 1,
        type: "run.failed",
        payload: {
          runId: record.id,
          status: "FAILED",
          failureCode: "WORKER_INTERRUPTED",
        },
        createdAt: this.#clock(),
      };
      const stepStatuses = record.stepStatuses.map((step) => ({
        ...step,
        status: step.status === "running" ? ("failed" as const) : step.status,
      }));
      const recovered = await this.transition({
        runId: record.id,
        expectedStatus: "RUNNING",
        nextStatus: "FAILED",
        currentStep: record.currentStep,
        stepStatuses,
        stopReason: null,
        failureCode: "WORKER_INTERRUPTED",
        completedAt: event.createdAt,
        cleanupStatus: "PENDING",
        event,
      });
      if (recovered.pendingEvidenceSubmissionId) {
        const pending = this.#evidence.get(recovered.pendingEvidenceSubmissionId);
        if (pending?.status === "PENDING") {
          pending.status = "ABANDONED";
          pending.abandonedAt = event.createdAt;
          this.#evidence.set(pending.id, pending);
        }
      }
    }
    return running.length;
  }

  async isReferencedByRun(sourceId: string): Promise<boolean> {
    return Array.from(this.#records.values()).some(
      (record) => record.resumeSourceId === sourceId && !record.deletedAt,
    );
  }

  async softDelete(runId: string): Promise<RunRecord | null> {
    const current = this.#records.get(runId);
    if (!current) return null;
    const deletedAt = this.#clock();
    const deleted = {
      ...current,
      deletedAt,
      cleanupStatus: "PENDING" as const,
      updatedAt: deletedAt,
    };
    this.#records.set(runId, deleted);
    return structuredClone(deleted);
  }

  async createArtifact(input: CreateRunArtifactInput): Promise<RunArtifactRecord> {
    if (!this.#records.has(input.runId)) throw new RunRepositoryError("RUN_NOT_FOUND");
    if (this.#artifacts.has(input.id)) throw new RunRepositoryError("RUN_CONFLICT", "Artifact id already exists.");
    if (!RUN_ARTIFACT_STATUSES.includes(input.status)) throw new RunRepositoryError("CONTRACT_INVALID");
    const record: RunArtifactRecord = {
      ...input,
      deploymentInstanceId: input.deploymentInstanceId ?? DEFAULT_DEPLOYMENT_INSTANCE_ID,
      role: input.role ?? "supporting",
      createdAt: this.#clock(),
      publishedAt: null,
      cleanupRequestedAt: null,
      deletedAt: null,
    };
    this.#artifacts.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async getArtifact(artifactId: string): Promise<RunArtifactRecord | null> {
    const artifact = this.#artifacts.get(artifactId);
    return artifact ? structuredClone(artifact) : null;
  }

  async updateArtifactStatus(
    artifactId: string,
    status: RunArtifactRecord["status"],
    at: string,
  ): Promise<RunArtifactRecord> {
    const current = this.#artifacts.get(artifactId);
    if (!current) throw new RunRepositoryError("ARTIFACT_NOT_FOUND");
    if (!RUN_ARTIFACT_STATUSES.includes(status)) throw new RunRepositoryError("CONTRACT_INVALID");
    const updated = {
      ...current,
      status,
      publishedAt: status === "PUBLISHED" ? at : current.publishedAt,
      cleanupRequestedAt:
        status === "CLEANUP_PENDING" ? at : current.cleanupRequestedAt,
      deletedAt: status === "DELETED" ? at : current.deletedAt,
    };
    this.#artifacts.set(artifactId, updated);
    return structuredClone(updated);
  }

  async createEvidence(input: CreateRunEvidenceInput): Promise<RunEvidenceSubmissionRecord> {
    const run = this.#records.get(input.runId);
    if (!run || run.deletedAt) throw new RunRepositoryError("RUN_NOT_FOUND");
    if (this.#evidence.has(input.id)) throw new RunRepositoryError("RUN_CONFLICT", "Evidence id already exists.");
    if (
      !input.storageObjectKey ||
      !Number.isSafeInteger(input.byteLength) ||
      input.byteLength <= 0 ||
      input.byteLength > RUN_LIMITS.maxEvidenceBodyBytes ||
      !Number.isSafeInteger(input.characterLength) ||
      input.characterLength <= 0 ||
      input.characterLength > RUN_LIMITS.maxEvidenceCodePoints
    ) {
      throw new RunRepositoryError("CONTRACT_INVALID", "Evidence metadata is outside the shared limits.");
    }
    const record: RunEvidenceSubmissionRecord = {
      ...input,
      deploymentInstanceId: input.deploymentInstanceId ?? DEFAULT_DEPLOYMENT_INSTANCE_ID,
      status: "PENDING",
      createdAt: this.#clock(),
      consumedAt: null,
      abandonedAt: null,
    };
    this.#evidence.set(record.id, structuredClone(record));
    run.pendingEvidenceSubmissionId = record.id;
    run.updatedAt = record.createdAt;
    this.#records.set(run.id, run);
    return structuredClone(record);
  }

  async getEvidence(submissionId: string): Promise<RunEvidenceSubmissionRecord | null> {
    const evidence = this.#evidence.get(submissionId);
    return evidence ? structuredClone(evidence) : null;
  }

  async updateEvidenceStatus(
    submissionId: string,
    status: RunEvidenceSubmissionRecord["status"],
    at: string,
  ): Promise<RunEvidenceSubmissionRecord> {
    const current = this.#evidence.get(submissionId);
    if (!current) throw new RunRepositoryError("EVIDENCE_NOT_FOUND");
    if (!RUN_EVIDENCE_STATUSES.includes(status)) throw new RunRepositoryError("CONTRACT_INVALID");
    if (current.status !== "PENDING" || status === "PENDING") {
      throw new RunRepositoryError("RUN_CONFLICT", "Evidence status transition is invalid.");
    }
    const updated = {
      ...current,
      status,
      consumedAt: status === "CONSUMED" ? at : null,
      abandonedAt: status === "ABANDONED" ? at : null,
    };
    this.#evidence.set(submissionId, updated);
    const run = this.#records.get(current.runId);
    if (run?.pendingEvidenceSubmissionId === submissionId) {
      run.pendingEvidenceSubmissionId = null;
      run.updatedAt = at;
      this.#records.set(run.id, run);
    }
    return structuredClone(updated);
  }

  async putIdempotency(scope: string, key: string, record: IdempotencyRecord): Promise<void> {
    const compoundKey = idempotencyCompoundKey(scope, key);
    const existing = this.#idempotency.get(compoundKey);
    if (existing && existing.requestFingerprint !== record.requestFingerprint) {
      throw new IdempotencyKeyConflictError();
    }
    this.#idempotency.set(compoundKey, structuredClone(record));
  }

  #applyTransition(current: RunRecord, input: RunTransitionInput): RunRecord {
    if (current.status !== input.expectedStatus) {
      throw new RunRepositoryError("RUN_CONFLICT", "Run status changed before transition.");
    }
    assertRunStatusTransition(current.status, input.nextStatus);
    if (input.event.runId !== current.id) {
      throw new RunRepositoryError("CONTRACT_INVALID", "Run event belongs to another run.");
    }

    const projected = applyRunEvent(current, input.event);
    if (projected.status !== input.nextStatus) {
      throw new RunRepositoryError("CONTRACT_INVALID", "Run event and next status disagree.");
    }
    const event = input.event;
    if (event.type === "run.step") {
      const changedStep = projected.stepStatuses.find((step) => step.id === event.payload.stepId);
      const requestedStep = input.stepStatuses.find((step) => step.id === event.payload.stepId);
      if (!changedStep || !requestedStep || changedStep.status !== requestedStep.status) {
        throw new RunRepositoryError("CONTRACT_INVALID", "Run step event and projection disagree.");
      }
    }
    if (input.event.type === "run.artifact" && !input.stepStatuses.every((step) => RUN_STEP_IDS.includes(step.id))) {
      throw new RunRepositoryError("CONTRACT_INVALID", "Run projection contains an unknown step.");
    }

    const next: RunRecord = {
      ...projected,
      status: input.nextStatus,
      currentStep: input.currentStep,
      stepStatuses: structuredClone(input.stepStatuses),
      stopReason: input.stopReason,
      failureCode: input.failureCode,
      completedAt: input.completedAt,
      pendingUserQuestions: structuredClone(input.pendingUserQuestions ?? current.pendingUserQuestions),
      artifactIds: structuredClone(input.artifactIds ?? projected.artifactIds),
      checkpointArtifactId:
        input.checkpointArtifactId === undefined
          ? current.checkpointArtifactId
          : input.checkpointArtifactId,
      cleanupStatus: input.cleanupStatus ?? current.cleanupStatus,
      finalResumeArtifactId:
        input.finalResumeArtifactId === undefined
          ? current.finalResumeArtifactId
          : input.finalResumeArtifactId,
    };
    const validation = validateRunDto(toRunDto(next));
    if (!validation.valid) {
      throw new RunRepositoryError("CONTRACT_INVALID", validation.errors.join("; "));
    }
    return next;
  }
}

function idempotencyCompoundKey(scope: string, key: string): string {
  return `${scope}\u0000${key}`;
}
