import { validateRunResultDto, type ResultActionAuditDto, type ReviewSummaryDto, type RunResultDto } from "web-contracts";
import { normalizeReviewReportV2 } from "platform-contracts";

import type { SourceObjectStore } from "./source-object-store.js";
import type { RunRepository } from "./run-repository.js";
import type { SourceRepository } from "./source-repository.js";
import type { RunArtifactRecord, RunRecord } from "./run-types.js";
import { diffResumes } from "./resume-diff.js";
import { parseResumeViewText } from "./resume-view.js";
import { DEFAULT_DEPLOYMENT_INSTANCE_ID } from "./deployment.js";

export class ResultServiceError extends Error {
  readonly code: "RUN_NOT_FOUND" | "RESULT_NOT_READY" | "RESULT_UNAVAILABLE" | "RESULT_CONTRACT_INVALID" | "REQUEST_INVALID";
  constructor(code: ResultServiceError["code"]) {
    super(code);
    this.name = "ResultServiceError";
    this.code = code;
  }
}

export class ResultService {
  readonly #runs: RunRepository;
  readonly #sources: SourceRepository;
  readonly #objects: SourceObjectStore;
  readonly #deploymentInstanceId: string;

  constructor({ runs, sources, objects, deploymentInstanceId = DEFAULT_DEPLOYMENT_INSTANCE_ID }: {
    runs: RunRepository;
    sources: SourceRepository;
    objects: SourceObjectStore;
    deploymentInstanceId?: string;
  }) {
    this.#runs = runs;
    this.#sources = sources;
    this.#objects = objects;
    this.#deploymentInstanceId = deploymentInstanceId;
  }

  async get(runId: string): Promise<RunResultDto> {
    const run = await this.#runs.get(runId);
    if (!run) throw new ResultServiceError("RUN_NOT_FOUND");
    if (["QUEUED", "RUNNING", "NEEDS_USER_INPUT"].includes(run.status)) throw new ResultServiceError("RESULT_NOT_READY");
    if (run.status !== "COMPLETED") throw new ResultServiceError("RESULT_UNAVAILABLE");

    const allArtifacts = await this.#artifacts(run);
    const finalArtifacts = allArtifacts.filter((artifact) => artifact.role === "final-resume");
    const artifacts = allArtifacts.filter((artifact) => artifact.status === "PUBLISHED");
    const finalArtifact = finalArtifacts[0];
    const preflightArtifact = [...artifacts].reverse().find((artifact) => artifact.artifactType === "preflight");
    if (finalArtifacts.length !== 1 || !finalArtifact || finalArtifact.status !== "PUBLISHED" || (run.finalResumeArtifactId && run.finalResumeArtifactId !== finalArtifact.id) || !preflightArtifact) throw new ResultServiceError("RESULT_UNAVAILABLE");
    const resume = await this.#readResume(finalArtifact);
    const preflight = await this.#readPreflight(preflightArtifact);
    const review = await this.#readReview(artifacts);
    const decisions = artifacts.filter((artifact) => artifact.artifactType === "optimization-decision");
    const actionHistory = await this.#readActions(decisions);
    if (decisions.length > 0 && actionHistory.length !== decisions.length) throw new ResultServiceError("RESULT_UNAVAILABLE");
    const originalResume = await this.#readOriginal(run);
    const diffStatus = originalResume ? "READY" : "UNAVAILABLE";
    const dto: RunResultDto = {
      runId: run.id,
      availability: "READY",
      resume,
      originalResume,
      diffStatus,
      diff: originalResume ? diffResumes(originalResume, resume) : [],
      preflight,
      review,
      actionHistory,
      stopReason: run.stopReason,
    };
    if (!validateRunResultDto(dto).valid) throw new ResultServiceError("RESULT_CONTRACT_INVALID");
    return dto;
  }

  async #artifacts(run: RunRecord): Promise<RunArtifactRecord[]> {
    const artifacts: RunArtifactRecord[] = [];
    for (const id of run.artifactIds) {
      const artifact = await this.#runs.getArtifact(id);
      if (!artifact || artifact.runId !== run.id || artifact.deploymentInstanceId !== this.#deploymentInstanceId || artifact.deletedAt) continue;
      artifacts.push(artifact);
    }
    return artifacts;
  }

  async #readResume(artifact: RunArtifactRecord) {
    try { return parseResumeViewText(new TextDecoder("utf-8", { fatal: true }).decode(await this.#objects.read(artifact.storageObjectKey))); } catch { throw new ResultServiceError("RESULT_CONTRACT_INVALID"); }
  }

  async #readPreflight(artifact: RunArtifactRecord): Promise<RunResultDto["preflight"]> {
    try {
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await this.#objects.read(artifact.storageObjectKey))) as Record<string, unknown>;
      if (!value || typeof value !== "object" || !["PROCEED", "ASK_USER", "STOP_UNSUPPORTED"].includes(String(value.decision)) || !Array.isArray(value.safeWritingScope) || value.safeWritingScope.some((item) => typeof item !== "string")) throw new Error();
      return { decision: value.decision as "PROCEED" | "ASK_USER" | "STOP_UNSUPPORTED", safeWritingScope: value.safeWritingScope as string[] };
    } catch { throw new ResultServiceError("RESULT_CONTRACT_INVALID"); }
  }

  async #readReview(artifacts: RunArtifactRecord[]): Promise<ReviewSummaryDto | null> {
    const artifact = [...artifacts].reverse().find((candidate) => candidate.artifactType === "review-report");
    if (!artifact) return null;
    try {
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await this.#objects.read(artifact.storageObjectKey))) as Record<string, unknown>;
      // Historical reports without schemaVersion remain readable elsewhere, but
      // are not converted into the v2 display contract.
      const normalized = normalizeReviewReportV2(value);
      if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) return null;
      const normalizedRecord = normalized as Record<string, unknown>;
      if (normalizedRecord.schemaVersion !== 2) return null;
      return normalizedRecord as unknown as ReviewSummaryDto;
    } catch {
      throw new ResultServiceError("RESULT_CONTRACT_INVALID");
    }
  }

  async #readActions(artifacts: RunArtifactRecord[]): Promise<ResultActionAuditDto[]> {
    const actions: ResultActionAuditDto[] = [];
    for (const artifact of artifacts) {
      try {
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await this.#objects.read(artifact.storageObjectKey))) as Record<string, unknown>;
        const action = value.action;
        if (!["PASS", "STOP", "REWRITE_SECTION", "KEYWORD_OPTIMIZE", "DROP_UNSUPPORTED_CLAIM", "REORDER", "ASK_USER"].includes(String(action))) throw new Error();
        actions.push({ sequence: Number(value.sequence) || actions.length + 1, action: action as ResultActionAuditDto["action"], target: typeof value.target === "string" ? value.target : null, reason: typeof value.reason === "string" ? value.reason : "", evidenceRefs: Array.isArray(value.evidenceRefs) ? value.evidenceRefs.filter((item): item is string => typeof item === "string") : [], risk: value.risk === "high" || value.risk === "medium" ? value.risk : "low", routerResult: value.routerResult === "rejected" || value.routerResult === "stopped" ? value.routerResult : "allowed", reviewImproved: typeof value.reviewImproved === "boolean" ? value.reviewImproved : null });
      } catch { throw new ResultServiceError("RESULT_CONTRACT_INVALID"); }
    }
    return actions.sort((left, right) => left.sequence - right.sequence);
  }

  async #readOriginal(run: RunRecord) {
    try { return parseResumeViewText(await this.#sources.readExtractedText(run.resumeSourceId)); } catch { return null; }
  }
}
