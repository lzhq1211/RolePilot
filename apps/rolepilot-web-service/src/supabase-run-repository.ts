import {
  RUN_ARTIFACT_STATUSES,
  RUN_EVIDENCE_STATUSES,
  RUN_LIMITS,
  validateRunDto,
  validateRunEvent,
  validateRunStepStatuses,
  type RunDto,
  type RunEvent,
  type RunStatus,
} from "web-contracts";

import { IdempotencyKeyConflictError } from "./errors.js";
import {
  SupabaseRestClient,
  SupabaseRestError,
  SupabaseIdempotencyStore,
} from "./supabase.js";
import type { IdempotencyStore } from "./source-repository.js";
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
import { assertRunStatusTransition } from "./run-projection.js";
import type { CreateRunIdempotentInput, CreateRunResult, RunRepository } from "./run-repository.js";
import { DEFAULT_DEPLOYMENT_INSTANCE_ID } from "./deployment.js";

type RunRow = {
  id: string;
  deployment_instance_id?: string;
  final_resume_artifact_id?: string | null;
  resume_source_id: string;
  company: string;
  title: string;
  jd_text: string;
  status: string;
  current_step: string | null;
  step_statuses: unknown;
  last_event_sequence: number | string;
  stop_reason: string | null;
  failure_code: string | null;
  resume_app_run_id: string | null;
  checkpoint_artifact_id: string | null;
  pending_evidence_submission_id: string | null;
  parent_run_id: string | null;
  pending_user_questions: unknown;
  cleanup_status: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  deleted_at: string | null;
};

type RunEventRow = {
  id: string;
  run_id: string;
  sequence: number | string;
  event_type: string;
  payload: unknown;
  created_at: string;
};

type ArtifactRow = {
  id: string;
  deployment_instance_id?: string;
  artifact_role?: string;
  run_id: string;
  artifact_type: string;
  stage: string;
  status: string;
  storage_object_key: string;
  relative_path: string;
  mime_type: string;
  size_bytes: number | string;
  created_at: string;
  published_at: string | null;
  cleanup_requested_at: string | null;
  deleted_at: string | null;
};

type EvidenceRow = {
  id: string;
  deployment_instance_id?: string;
  run_id: string;
  request_fingerprint: string;
  storage_object_key: string;
  byte_length: number | string;
  character_length: number | string;
  status: string;
  created_at: string;
  consumed_at: string | null;
  abandoned_at: string | null;
};

export class SupabaseRunRepository implements RunRepository {
  readonly #client: SupabaseRestClient;
  readonly #idempotencyStore: IdempotencyStore;
  readonly #clock: () => string;
  readonly #deploymentInstanceId: string;

  constructor({
    client,
    idempotencyStore = new SupabaseIdempotencyStore({ client }),
    clock = () => new Date().toISOString(),
    deploymentInstanceId = DEFAULT_DEPLOYMENT_INSTANCE_ID,
  }: {
    client: SupabaseRestClient;
    idempotencyStore?: IdempotencyStore;
    clock?: () => string;
    deploymentInstanceId?: string;
  }) {
    this.#client = client;
    this.#idempotencyStore = idempotencyStore;
    this.#deploymentInstanceId = deploymentInstanceId;
    this.#clock = clock;
  }

  async create(input: CreateRunRecord): Promise<RunRecord> {
    const result = await this.createIdempotent({
      ...input,
      idempotencyKey: `run-id:${input.id}`,
      requestFingerprint: `direct-create:${input.id}:${input.createdAt}`,
      expiresAt: "9999-12-31T23:59:59.000Z",
    });
    return result.run;
  }

  async createIdempotent(input: CreateRunIdempotentInput): Promise<CreateRunResult> {
    const existing = await this.#idempotencyStore.get("runs.create", input.idempotencyKey);
    if (existing) {
      assertRunIdempotency(existing, input.requestFingerprint);
      const run = await this.get(existing.resultId);
      if (!run) throw new RunRepositoryError("RUN_CONFLICT", "Run idempotency target is missing.");
      return { run, reused: true };
    }

    try {
      const row = await this.#client.rpc<RunRow>("rolepilot_create_run_scoped", {
        p_deployment_instance_id: this.#deploymentInstanceId,
        p_run_id: input.id,
        p_resume_source_id: input.resumeSourceId,
        p_company: input.company,
        p_title: input.title,
        p_jd_text: input.jdText,
        p_extracted_text_object_key: input.extractedTextObjectKey,
        p_request_fingerprint: input.requestFingerprint,
        p_idempotency_key: input.idempotencyKey,
        p_idempotency_expires_at: input.expiresAt,
        p_event_id: input.eventId,
        p_created_at: input.createdAt,
      });
      const run = await this.#runFromRow(requiredRecord(row));
      return { run, reused: run.id !== input.id };
    } catch (error) {
      if (error instanceof SupabaseRestError && error.code === "23505") {
        const winner = await this.#idempotencyStore.get("runs.create", input.idempotencyKey);
        if (winner) {
          assertRunIdempotency(winner, input.requestFingerprint);
          const run = await this.get(winner.resultId);
          if (run) return { run, reused: true };
        }
        throw new IdempotencyKeyConflictError();
      }
      if (error instanceof SupabaseRestError && error.code === "P0002") {
        throw new RunRepositoryError("RUN_NOT_RESUMABLE", "Resume source is not ready.");
      }
      throwMappedRunError(error);
    }
  }

  async get(
    runId: string,
    { includeDeleted = false }: { includeDeleted?: boolean } = {},
  ): Promise<RunRecord | null> {
    const deletedFilter = includeDeleted ? "" : "&deleted_at=is.null";
    const rows = await this.#client.json<RunRow[]>(
      `/rest/v1/runs?select=*&id=eq.${encodeURIComponent(runId)}&deployment_instance_id=eq.${encodeURIComponent(this.#deploymentInstanceId)}${deletedFilter}&limit=1`,
    );
    return rows[0] ? this.#runFromRow(rows[0]) : null;
  }

  async list({ includeDeleted = false }: { includeDeleted?: boolean } = {}): Promise<RunDto[]> {
    const deletedFilter = includeDeleted ? "" : "&deleted_at=is.null";
    const rows = await this.#client.json<RunRow[]>(
      `/rest/v1/runs?select=*&deployment_instance_id=eq.${encodeURIComponent(this.#deploymentInstanceId)}&${deletedFilter ? "deleted_at=is.null&" : ""}order=created_at.desc,id.desc`,
    );
    const artifactIds = await this.#artifactIdsByRun();
    return Promise.all(
      rows.map(async (row) => toRunDto(await this.#runFromRow(row, artifactIds.get(row.id) ?? []))),
    );
  }

  async eventsAfter(runId: string, sequence: number): Promise<RunEvent[]> {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new RunRepositoryError("CONTRACT_INVALID", "Event sequence cursor is invalid.");
    }
    const events: RunEvent[] = [];
    let cursor = sequence;
    for (;;) {
      const rows = await this.#client.json<RunEventRow[]>(
        `/rest/v1/run_events?select=*&run_id=eq.${encodeURIComponent(runId)}&deployment_instance_id=eq.${encodeURIComponent(this.#deploymentInstanceId)}&sequence=gt.${cursor}&order=sequence.asc&limit=100`,
      );
      const page = rows.map(runEventFromRow);
      events.push(...page);
      if (page.length < 100) return events;
      cursor = page[page.length - 1]!.sequence;
    }
  }

  async transition(input: RunTransitionInput): Promise<RunRecord> {
    assertRunStatusTransition(input.expectedStatus, input.nextStatus);
    const stepsValidation = validateRunStepStatuses(input.stepStatuses);
    if (!stepsValidation.valid) {
      throw new RunRepositoryError("CONTRACT_INVALID", stepsValidation.errors.join("; "));
    }
    const eventValidation = validateRunEvent(input.event);
    if (!eventValidation.valid) {
      throw new RunRepositoryError("CONTRACT_INVALID", eventValidation.errors.join("; "));
    }
    if (input.event.runId !== input.runId) {
      throw new RunRepositoryError("CONTRACT_INVALID", "Run event belongs to another run.");
    }
    assertEventMatchesTransition(input);
    const projectionValidation = validateRunDto({
      id: input.runId,
      status: input.nextStatus,
      company: "projection",
      title: "projection",
      resumeSourceId: "source",
      currentStep: input.currentStep,
      stepStatuses: input.stepStatuses,
      stopReason: input.stopReason,
      failureCode: input.failureCode,
      pendingUserQuestions: input.pendingUserQuestions ?? [],
      artifactIds: [],
      checkpointArtifactId: null,
      parentRunId: null,
      createdAt: "2000-01-01T00:00:00.000Z",
      updatedAt: input.event.createdAt,
      completedAt: input.completedAt,
    });
    if (!projectionValidation.valid) {
      throw new RunRepositoryError("CONTRACT_INVALID", projectionValidation.errors.join("; "));
    }
    try {
      await this.#client.rpc("rolepilot_transition_run_scoped", {
        p_deployment_instance_id: this.#deploymentInstanceId,
        p_final_resume_artifact_id: input.finalResumeArtifactId ?? null,
        p_update_final_resume_artifact_id: input.finalResumeArtifactId !== undefined,
        p_run_id: input.runId,
        p_expected_status: input.expectedStatus,
        p_next_status: input.nextStatus,
        p_current_step: input.currentStep,
        p_step_statuses: input.stepStatuses,
        p_stop_reason: input.stopReason,
        p_failure_code: input.failureCode,
        p_pending_user_questions: input.pendingUserQuestions ?? null,
        p_checkpoint_artifact_id: input.checkpointArtifactId ?? null,
        p_update_checkpoint_artifact_id: input.checkpointArtifactId !== undefined,
        p_cleanup_status: input.cleanupStatus ?? null,
        p_event_id: input.event.id,
        p_event_type: input.event.type,
        p_event_payload: input.event.payload,
        p_completed_at: input.completedAt,
      });
      const next = await this.get(input.runId);
      if (!next) throw new RunRepositoryError("RUN_NOT_FOUND");
      return next;
    } catch (error) {
      throwMappedRunError(error);
    }
  }

  async claimNext(eventId: string): Promise<RunRecord | null> {
    try {
      const value = await this.#client.rpc<RunRow | RunRow[] | null>(
        "rolepilot_claim_next_run",
        { p_event_id: eventId, p_deployment_instance_id: this.#deploymentInstanceId },
      );
      const row = firstRecord(value);
      return row ? this.#runFromRow(row) : null;
    } catch (error) {
      throwMappedRunError(error);
    }
  }

  async startupRecoverRunning(): Promise<number> {
    try {
      const value = await this.#client.rpc<number | number[]>("rolepilot_startup_recover_scoped", { p_deployment_instance_id: this.#deploymentInstanceId });
      const count = Array.isArray(value) ? value[0] : value;
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new RunRepositoryError("CONTRACT_INVALID", "Recovery count is invalid.");
      }
      return count;
    } catch (error) {
      throwMappedRunError(error);
    }
  }

  async isReferencedByRun(sourceId: string): Promise<boolean> {
    const rows = await this.#client.json<Array<{ id: string }>>(
      `/rest/v1/runs?select=id&deployment_instance_id=eq.${encodeURIComponent(this.#deploymentInstanceId)}&resume_source_id=eq.${encodeURIComponent(sourceId)}&deleted_at=is.null&limit=1`,
    );
    return rows.length > 0;
  }

  async softDelete(runId: string): Promise<RunRecord | null> {
    try {
      const value = await this.#client.rpc<RunRow | RunRow[] | null>("rolepilot_soft_delete_run", { p_run_id: runId, p_deployment_instance_id: this.#deploymentInstanceId });
      const row = firstRecord(value);
      return row ? this.#runFromRow(row, await this.#artifactIds(row.id)) : null;
    } catch (error) { throwMappedRunError(error); }
  }

  async createArtifact(input: CreateRunArtifactInput): Promise<RunArtifactRecord> {
    if (!RUN_ARTIFACT_STATUSES.includes(input.status)) {
      throw new RunRepositoryError("CONTRACT_INVALID");
    }
    try {
      const [row] = await this.#client.json<ArtifactRow[]>("/rest/v1/artifacts", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          deployment_instance_id: this.#deploymentInstanceId,
          id: input.id,
          run_id: input.runId,
          artifact_role: input.role ?? "supporting",
          artifact_type: input.artifactType,
          stage: input.stage,
          status: input.status,
          storage_object_key: input.storageObjectKey,
          relative_path: input.relativePath,
          mime_type: input.mimeType,
          size_bytes: input.sizeBytes,
        }),
      });
      return artifactFromRow(requiredRecord(row));
    } catch (error) {
      throwMappedRunError(error);
    }
  }

  async getArtifact(artifactId: string): Promise<RunArtifactRecord | null> {
    const rows = await this.#client.json<ArtifactRow[]>(
      `/rest/v1/artifacts?select=*&id=eq.${encodeURIComponent(artifactId)}&deployment_instance_id=eq.${encodeURIComponent(this.#deploymentInstanceId)}&limit=1`,
    );
    return rows[0] ? artifactFromRow(rows[0]) : null;
  }

  async updateArtifactStatus(
    artifactId: string,
    status: RunArtifactRecord["status"],
    at: string,
  ): Promise<RunArtifactRecord> {
    if (!RUN_ARTIFACT_STATUSES.includes(status)) {
      throw new RunRepositoryError("CONTRACT_INVALID");
    }
    const changes: Record<string, string> = { status };
    if (status === "PUBLISHED") changes.published_at = at;
    if (status === "CLEANUP_PENDING") changes.cleanup_requested_at = at;
    if (status === "DELETED") changes.deleted_at = at;
    try {
      const [row] = await this.#client.json<ArtifactRow[]>(
        `/rest/v1/artifacts?id=eq.${encodeURIComponent(artifactId)}&deployment_instance_id=eq.${encodeURIComponent(this.#deploymentInstanceId)}`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(changes),
        },
      );
      if (!row) throw new RunRepositoryError("ARTIFACT_NOT_FOUND");
      return artifactFromRow(row);
    } catch (error) {
      throwMappedRunError(error);
    }
  }

  async createEvidence(input: CreateRunEvidenceInput): Promise<RunEvidenceSubmissionRecord> {
    if (!validEvidenceMetadata(input)) {
      throw new RunRepositoryError("CONTRACT_INVALID", "Evidence metadata is outside the shared limits.");
    }
    try {
      const [row] = await this.#client.json<EvidenceRow[]>("/rest/v1/run_evidence_submissions", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          id: input.id,
          run_id: input.runId,
          deployment_instance_id: this.#deploymentInstanceId,
          request_fingerprint: input.requestFingerprint,
          storage_object_key: input.storageObjectKey,
          byte_length: input.byteLength,
          character_length: input.characterLength,
          status: "PENDING",
          created_at: this.#clock(),
        }),
      });
      const evidence = evidenceFromRow(requiredRecord(row));
      await this.#client.json(`/rest/v1/runs?id=eq.${encodeURIComponent(input.runId)}&deployment_instance_id=eq.${encodeURIComponent(this.#deploymentInstanceId)}&deleted_at=is.null`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ pending_evidence_submission_id: evidence.id }),
      });
      return evidence;
    } catch (error) {
      throwMappedRunError(error);
    }
  }

  async getEvidence(submissionId: string): Promise<RunEvidenceSubmissionRecord | null> {
    const rows = await this.#client.json<EvidenceRow[]>(
      `/rest/v1/run_evidence_submissions?select=*&id=eq.${encodeURIComponent(submissionId)}&deployment_instance_id=eq.${encodeURIComponent(this.#deploymentInstanceId)}&limit=1`,
    );
    return rows[0] ? evidenceFromRow(rows[0]) : null;
  }

  async updateEvidenceStatus(
    submissionId: string,
    status: RunEvidenceSubmissionRecord["status"],
    at: string,
  ): Promise<RunEvidenceSubmissionRecord> {
    if (!RUN_EVIDENCE_STATUSES.includes(status) || status === "PENDING") {
      throw new RunRepositoryError("CONTRACT_INVALID");
    }
    const current = await this.getEvidence(submissionId);
    if (!current) throw new RunRepositoryError("EVIDENCE_NOT_FOUND");
    if (current.status !== "PENDING") {
      throw new RunRepositoryError("RUN_CONFLICT", "Evidence status transition is invalid.");
    }
    const changes =
      status === "CONSUMED"
        ? { status, consumed_at: at, abandoned_at: null }
        : { status, consumed_at: null, abandoned_at: at };
    try {
      const [row] = await this.#client.json<EvidenceRow[]>(
        `/rest/v1/run_evidence_submissions?id=eq.${encodeURIComponent(submissionId)}&deployment_instance_id=eq.${encodeURIComponent(this.#deploymentInstanceId)}&status=eq.PENDING`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(changes),
        },
      );
      if (!row) throw new RunRepositoryError("EVIDENCE_NOT_FOUND");
      await this.#client.json(
        `/rest/v1/runs?id=eq.${encodeURIComponent(current.runId)}&deployment_instance_id=eq.${encodeURIComponent(this.#deploymentInstanceId)}&pending_evidence_submission_id=eq.${encodeURIComponent(submissionId)}`,
        {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ pending_evidence_submission_id: null }),
        },
      );
      return evidenceFromRow(row);
    } catch (error) {
      throwMappedRunError(error);
    }
  }

  async #runFromRow(row: RunRow, artifactIds?: string[]): Promise<RunRecord> {
    return {
      ...runDtoFromRow(row, artifactIds ?? (await this.#artifactIds(row.id))),
      lastEventSequence: toSafeInteger(row.last_event_sequence, "last_event_sequence"),
      jdText: row.jd_text,
      resumeAppRunId: row.resume_app_run_id,
      pendingEvidenceSubmissionId: row.pending_evidence_submission_id,
      cleanupStatus: row.cleanup_status as RunRecord["cleanupStatus"],
      deletedAt: row.deleted_at,
      deploymentInstanceId: row.deployment_instance_id ?? DEFAULT_DEPLOYMENT_INSTANCE_ID,
      finalResumeArtifactId: row.final_resume_artifact_id ?? null,
    };
  }

  async #artifactIds(runId: string): Promise<string[]> {
    const rows = await this.#client.json<Array<{ id: string }>>(
      `/rest/v1/artifacts?select=id&run_id=eq.${encodeURIComponent(runId)}&deployment_instance_id=eq.${encodeURIComponent(this.#deploymentInstanceId)}&status=neq.DELETED&order=created_at.asc,id.asc`,
    );
    return rows.map((row) => row.id);
  }

  async #artifactIdsByRun(): Promise<Map<string, string[]>> {
    const rows = await this.#client.json<Array<{ id: string; run_id: string }>>(
      `/rest/v1/artifacts?select=id,run_id&deployment_instance_id=eq.${encodeURIComponent(this.#deploymentInstanceId)}&status=neq.DELETED&order=created_at.asc,id.asc`,
    );
    const result = new Map<string, string[]>();
    for (const row of rows) {
      const ids = result.get(row.run_id) ?? [];
      ids.push(row.id);
      result.set(row.run_id, ids);
    }
    return result;
  }
}

function runDtoFromRow(row: RunRow, artifactIds: string[]): RunDto {
  const dto: RunDto = {
    id: row.id,
    status: row.status as RunStatus,
    company: row.company,
    title: row.title,
    resumeSourceId: row.resume_source_id,
    currentStep: row.current_step as RunDto["currentStep"],
    stepStatuses: row.step_statuses as RunDto["stepStatuses"],
    stopReason: row.stop_reason as RunDto["stopReason"],
    failureCode: row.failure_code as RunDto["failureCode"],
    pendingUserQuestions: row.pending_user_questions as string[],
    artifactIds,
    checkpointArtifactId: row.checkpoint_artifact_id,
    parentRunId: row.parent_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
  const result = validateRunDto(dto);
  if (!result.valid) throw new RunRepositoryError("CONTRACT_INVALID", result.errors.join("; "));
  return dto;
}

function runEventFromRow(row: RunEventRow): RunEvent {
  const event = {
    id: row.id,
    runId: row.run_id,
    sequence: toSafeInteger(row.sequence, "event sequence"),
    type: row.event_type,
    payload: row.payload,
    createdAt: row.created_at,
  } as RunEvent;
  const result = validateRunEvent(event);
  if (!result.valid) throw new RunRepositoryError("CONTRACT_INVALID", result.errors.join("; "));
  return event;
}

function artifactFromRow(row: ArtifactRow): RunArtifactRecord {
  return {
    id: row.id,
    runId: row.run_id,
    deploymentInstanceId: row.deployment_instance_id ?? DEFAULT_DEPLOYMENT_INSTANCE_ID,
    role: (row.artifact_role ?? "supporting") as RunArtifactRecord["role"],
    artifactType: row.artifact_type as RunArtifactRecord["artifactType"],
    stage: row.stage,
    status: row.status as RunArtifactRecord["status"],
    storageObjectKey: row.storage_object_key,
    relativePath: row.relative_path,
    mimeType: row.mime_type,
    sizeBytes: toSafeInteger(row.size_bytes, "artifact size_bytes"),
    createdAt: row.created_at,
    publishedAt: row.published_at,
    cleanupRequestedAt: row.cleanup_requested_at,
    deletedAt: row.deleted_at,
  };
}

function evidenceFromRow(row: EvidenceRow): RunEvidenceSubmissionRecord {
  return {
    id: row.id,
    runId: row.run_id,
    deploymentInstanceId: row.deployment_instance_id ?? DEFAULT_DEPLOYMENT_INSTANCE_ID,
    requestFingerprint: row.request_fingerprint,
    storageObjectKey: row.storage_object_key,
    byteLength: toSafeInteger(row.byte_length, "evidence byte_length"),
    characterLength: toSafeInteger(row.character_length, "evidence character_length"),
    status: row.status as RunEvidenceSubmissionRecord["status"],
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
    abandonedAt: row.abandoned_at,
  };
}

function assertRunIdempotency(
  record: { requestFingerprint: string; resultKind: string },
  requestFingerprint: string,
): void {
  if (record.requestFingerprint !== requestFingerprint || record.resultKind !== "run") {
    throw new IdempotencyKeyConflictError();
  }
}

function assertEventMatchesTransition(input: RunTransitionInput): void {
  if (
    ["run.step", "run.progress", "run.artifact"].includes(input.event.type) &&
    input.nextStatus !== input.expectedStatus
  ) {
    throw new RunRepositoryError("CONTRACT_INVALID", "Non-status event cannot change Run status.");
  }
  const eventStatus =
    input.event.type === "run.status" ||
    input.event.type === "run.completed" ||
    input.event.type === "run.cancelled" ||
    input.event.type === "run.failed"
      ? input.event.payload.status
      : null;
  if (eventStatus !== null && eventStatus !== input.nextStatus) {
    throw new RunRepositoryError("CONTRACT_INVALID", "Run event and next status disagree.");
  }
}

function validEvidenceMetadata(input: CreateRunEvidenceInput): boolean {
  return (
    input.storageObjectKey.length > 0 &&
    Number.isSafeInteger(input.byteLength) &&
    input.byteLength > 0 &&
    input.byteLength <= RUN_LIMITS.maxEvidenceBodyBytes &&
    Number.isSafeInteger(input.characterLength) &&
    input.characterLength > 0 &&
    input.characterLength <= RUN_LIMITS.maxEvidenceCodePoints
  );
}

function firstRecord<T>(value: T | T[] | null): T | null {
  const record = Array.isArray(value) ? value[0] ?? null : value;
  return isNullComposite(record) ? null : record;
}

function isNullComposite(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "id" in value && (value as { id?: unknown }).id === null);
}

function requiredRecord<T>(value: T | T[] | null | undefined): T {
  const record = firstRecord(value ?? null);
  if (!record) throw new RunRepositoryError("CONTRACT_INVALID", "Supabase returned no record.");
  return record;
}

function toSafeInteger(value: number | string, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RunRepositoryError("CONTRACT_INVALID", `${label} is invalid.`);
  }
  return parsed;
}

function throwMappedRunError(error: unknown): never {
  if (error instanceof RunRepositoryError) throw error;
  if (error instanceof SupabaseRestError) {
    if (error.code === "P0001" || error.code === "23505") {
      throw new RunRepositoryError("RUN_CONFLICT");
    }
    if (error.code === "P0002") throw new RunRepositoryError("RUN_NOT_FOUND");
  }
  throw error;
}
