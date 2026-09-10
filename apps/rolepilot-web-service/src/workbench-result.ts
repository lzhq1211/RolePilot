import {
  parseResumeContentV3,
  validateReviewSummary,
  type HistoricalReviewSuggestionDto,
  type ReviewSummaryDto,
  type WorkbenchActionAuditDto,
  type WorkbenchDocumentContent,
  type WorkbenchResultDto,
  type WorkbenchReviewBindingDto,
  type WorkbenchReviewDto,
} from "web-contracts";
import { normalizeReviewReportV2 } from "platform-contracts";

import { DEFAULT_DEPLOYMENT_INSTANCE_ID } from "./deployment.js";
import { parseHistoricalResumeContent } from "./resume-view.js";
import type { RunRepository } from "./run-repository.js";
import type { RunArtifactRecord, RunRecord } from "./run-types.js";
import type { SourceObjectStore } from "./source-object-store.js";

export class WorkbenchResultError extends Error {
  readonly code: "RUN_NOT_FOUND" | "RESULT_NOT_READY" | "RESULT_UNAVAILABLE" | "RESULT_CONTRACT_INVALID";

  constructor(code: WorkbenchResultError["code"]) {
    super(code);
    this.name = "WorkbenchResultError";
    this.code = code;
  }
}

type DeliveryIndex = Record<string, unknown>;

export class WorkbenchResultService {
  readonly #runs: RunRepository;
  readonly #objects: SourceObjectStore;
  readonly #deploymentInstanceId: string;

  constructor({ runs, objects, deploymentInstanceId = DEFAULT_DEPLOYMENT_INSTANCE_ID }: {
    runs: RunRepository;
    objects: SourceObjectStore;
    deploymentInstanceId?: string;
  }) {
    this.#runs = runs;
    this.#objects = objects;
    this.#deploymentInstanceId = deploymentInstanceId;
  }

  async get(runId: string): Promise<WorkbenchResultDto> {
    const run = await this.#runs.get(runId);
    if (!run) throw new WorkbenchResultError("RUN_NOT_FOUND");
    if (["QUEUED", "RUNNING", "NEEDS_USER_INPUT"].includes(run.status)) throw new WorkbenchResultError("RESULT_NOT_READY");
    if (run.status !== "COMPLETED") throw new WorkbenchResultError("RESULT_UNAVAILABLE");

    const artifacts = await this.#artifacts(run);
    const published = artifacts.filter((artifact) => artifact.status === "PUBLISHED");
    const deliveryIndexes = published.filter(isWorkbenchDeliveryArtifact);
    if (deliveryIndexes.length > 1) throw new WorkbenchResultError("RESULT_CONTRACT_INVALID");
    return deliveryIndexes[0]
      ? this.#fromDelivery(run, published, deliveryIndexes[0])
      : this.#fromHistorical(run, published);
  }

  async #fromDelivery(
    run: RunRecord,
    artifacts: RunArtifactRecord[],
    deliveryArtifact: RunArtifactRecord,
  ): Promise<WorkbenchResultDto> {
    const index = await this.#readJson(deliveryArtifact);
    if (index.schemaVersion !== 1 || index.format !== "workbench-delivery") throw new WorkbenchResultError("RESULT_CONTRACT_INVALID");
    if (index.deliveryStatus !== "OPTIMIZED" && index.deliveryStatus !== "SOURCE_ONLY") throw new WorkbenchResultError("RESULT_CONTRACT_INVALID");
    const byPath = new Map(artifacts.map((artifact) => [artifact.relativePath, artifact]));
    const originalRef = requireRecord(index.original);
    const finalRef = requireRecord(index.final);
    const preflightRef = requireRecord(index.preflight);
    const originalArtifact = requireArtifact(byPath, originalRef.path, "resume");
    const finalArtifact = requireArtifact(byPath, finalRef.path, "resume");
    const preflightArtifact = requireArtifact(byPath, preflightRef.path, "preflight");
    if (finalArtifact.role !== "final-resume" || run.finalResumeArtifactId !== finalArtifact.id) throw new WorkbenchResultError("RESULT_CONTRACT_INVALID");

    const original = await this.#readV3(originalArtifact);
    const final = await this.#readV3(finalArtifact);
    if (original.documentId !== originalRef.documentId || final.documentId !== finalRef.documentId) throw new WorkbenchResultError("RESULT_CONTRACT_INVALID");
    const preflight = await this.#readPreflight(preflightArtifact);
    if (preflight.decision !== preflightRef.decision) throw new WorkbenchResultError("RESULT_CONTRACT_INVALID");
    const review = await this.#readDeliveryReview(index.review, byPath, final);
    const actionHistory = readActionHistory(index.actionHistory);
    const candidateVersion = typeof finalRef.candidateVersion === "number" && Number.isInteger(finalRef.candidateVersion)
      ? finalRef.candidateVersion
      : null;

    return {
      runId: run.id,
      availability: "READY",
      deliveryStatus: index.deliveryStatus,
      original: { availability: "AVAILABLE", document: original, originArtifactId: originalArtifact.id },
      final,
      finalOriginArtifactId: finalArtifact.id,
      finalCandidateVersion: candidateVersion,
      preflight,
      review,
      actionHistory,
      actionHistoryStatus: "VERIFIED",
      stopReason: run.stopReason,
    };
  }

  async #fromHistorical(run: RunRecord, artifacts: RunArtifactRecord[]): Promise<WorkbenchResultDto> {
    const finalArtifacts = artifacts.filter((artifact) => artifact.role === "final-resume");
    if (finalArtifacts.length !== 1 || run.finalResumeArtifactId !== finalArtifacts[0]!.id) throw new WorkbenchResultError("RESULT_UNAVAILABLE");
    const final = await this.#readHistorical(finalArtifacts[0]!, `legacy:${run.id}:final`);
    const originalArtifact = artifacts.find((artifact) => artifact.role === "supporting"
      && artifact.artifactType === "resume" && /(^|\.)original(\.|$)/.test(artifact.relativePath));
    const original = originalArtifact
      ? await this.#readHistoricalOrNull(originalArtifact, `legacy:${run.id}:original`)
      : null;
    const preflightArtifact = [...artifacts].reverse().find((artifact) => artifact.artifactType === "preflight") ?? null;
    const reviewArtifact = [...artifacts].reverse().find((artifact) => artifact.artifactType === "review-report") ?? null;

    return {
      runId: run.id,
      availability: "READY",
      deliveryStatus: "HISTORICAL",
      original: original
        ? { availability: "AVAILABLE", document: original, originArtifactId: originalArtifact?.id ?? null }
        : { availability: "UNAVAILABLE", document: null, originArtifactId: null },
      final,
      finalOriginArtifactId: finalArtifacts[0]!.id,
      finalCandidateVersion: null,
      preflight: preflightArtifact ? await this.#readPreflight(preflightArtifact) : null,
      review: reviewArtifact ? await this.#readHistoricalReview(reviewArtifact) : null,
      actionHistory: [],
      actionHistoryStatus: "UNKNOWN",
      stopReason: run.stopReason,
    };
  }

  async #readDeliveryReview(
    value: unknown,
    byPath: Map<string, RunArtifactRecord>,
    final: WorkbenchDocumentContent,
  ): Promise<WorkbenchReviewDto> {
    const review = requireRecord(value);
    const kind = review.kind;
    const reportArtifact = requireArtifact(byPath, review.reportPath, "review-report");
    const report = await this.#readReviewSummary(reportArtifact);
    if (kind === "historical-suggestion") {
      return { kind, report: toHistoricalSuggestion(report), binding: null };
    }
    if (kind !== "final-bound") throw new WorkbenchResultError("RESULT_CONTRACT_INVALID");
    const bindingArtifact = requireArtifact(byPath, review.bindingPath, "log");
    const binding = readBinding(await this.#readJson(bindingArtifact));
    if (binding.reviewArtifactPath !== reportArtifact.relativePath || binding.documentId !== final.documentId) {
      throw new WorkbenchResultError("RESULT_CONTRACT_INVALID");
    }
    return { kind, report, binding };
  }

  async #readReviewSummary(artifact: RunArtifactRecord): Promise<ReviewSummaryDto> {
    const value = normalizeReviewReportV2(await this.#readJson(artifact));
    if (!validateReviewSummary(value).valid) throw new WorkbenchResultError("RESULT_CONTRACT_INVALID");
    return value as ReviewSummaryDto;
  }

  async #readHistoricalReview(artifact: RunArtifactRecord): Promise<WorkbenchReviewDto> {
    try {
      return { kind: "historical-suggestion", report: toHistoricalSuggestion(await this.#readReviewSummary(artifact)), binding: null };
    } catch {
      return { kind: "historical-suggestion", report: null, binding: null };
    }
  }

  async #readV3(artifact: RunArtifactRecord): Promise<WorkbenchDocumentContent> {
    try {
      return parseResumeContentV3(await this.#readJson(artifact));
    } catch {
      throw new WorkbenchResultError("RESULT_CONTRACT_INVALID");
    }
  }

  async #readHistorical(artifact: RunArtifactRecord, documentId: string): Promise<WorkbenchDocumentContent> {
    try {
      return parseHistoricalResumeContent(await this.#readJson(artifact), documentId);
    } catch {
      throw new WorkbenchResultError("RESULT_CONTRACT_INVALID");
    }
  }

  async #readHistoricalOrNull(artifact: RunArtifactRecord, documentId: string): Promise<WorkbenchDocumentContent | null> {
    try {
      return await this.#readHistorical(artifact, documentId);
    } catch {
      return null;
    }
  }

  async #readPreflight(artifact: RunArtifactRecord): Promise<NonNullable<WorkbenchResultDto["preflight"]>> {
    const value = await this.#readJson(artifact);
    if (!isRecord(value) || !isPreflightDecision(value.decision) || !Array.isArray(value.safeWritingScope)
      || value.safeWritingScope.some((item) => typeof item !== "string")) {
      throw new WorkbenchResultError("RESULT_CONTRACT_INVALID");
    }
    return { decision: value.decision, safeWritingScope: [...value.safeWritingScope] };
  }

  async #readJson(artifact: RunArtifactRecord): Promise<DeliveryIndex> {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await this.#objects.read(artifact.storageObjectKey));
      const value = JSON.parse(text) as unknown;
      if (!isRecord(value)) throw new Error();
      return value;
    } catch {
      throw new WorkbenchResultError("RESULT_CONTRACT_INVALID");
    }
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
}

function isWorkbenchDeliveryArtifact(artifact: RunArtifactRecord): boolean {
  const fileName = artifact.relativePath.split("/").at(-1);
  return artifact.artifactType === "log" && artifact.stage === "supporting" && fileName === "workbench-delivery.json";
}

function requireArtifact(
  byPath: Map<string, RunArtifactRecord>,
  value: unknown,
  type: RunArtifactRecord["artifactType"],
): RunArtifactRecord {
  const path = requireRelativePath(value);
  const artifact = byPath.get(path);
  if (!artifact || artifact.artifactType !== type || artifact.status !== "PUBLISHED") throw new WorkbenchResultError("RESULT_CONTRACT_INVALID");
  return artifact;
}

function requireRelativePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\") || value.split("/").includes("..")) {
    throw new WorkbenchResultError("RESULT_CONTRACT_INVALID");
  }
  return value;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new WorkbenchResultError("RESULT_CONTRACT_INVALID");
  return value;
}

function readBinding(value: DeliveryIndex): WorkbenchReviewBindingDto {
  if (typeof value.documentId !== "string" || !Number.isInteger(value.candidateVersion)
    || !Number.isInteger(value.evidenceVersion) || typeof value.reviewArtifactPath !== "string"
    || !Array.isArray(value.issueTargets)) {
    throw new WorkbenchResultError("RESULT_CONTRACT_INVALID");
  }
  const issueTargets = value.issueTargets.map((item) => {
    if (!isRecord(item) || typeof item.issueRef !== "string" || typeof item.issueKey !== "string") throw new WorkbenchResultError("RESULT_CONTRACT_INVALID");
    const target = item.target;
    if (target !== null && (!isRecord(target) || (typeof target.nodeId !== "string" && typeof target.profileField !== "string"))) {
      throw new WorkbenchResultError("RESULT_CONTRACT_INVALID");
    }
    return {
      issueRef: item.issueRef,
      issueKey: item.issueKey,
      target: target === null ? null : typeof target.nodeId === "string" ? { nodeId: target.nodeId } : { profileField: target.profileField as string },
    };
  });
  return {
    documentId: value.documentId,
    candidateVersion: value.candidateVersion as number,
    evidenceVersion: value.evidenceVersion as number,
    reviewArtifactPath: requireRelativePath(value.reviewArtifactPath),
    issueTargets,
  };
}

function readActionHistory(value: unknown): WorkbenchActionAuditDto[] {
  if (!Array.isArray(value)) throw new WorkbenchResultError("RESULT_CONTRACT_INVALID");
  return value.map<WorkbenchActionAuditDto>((item) => {
    if (!isRecord(item) || !Number.isInteger(item.sequence) || !isRecord(item.decision) || !isRecord(item.route)
      || !["rejected", "executed", "stopped", "no-op"].includes(String(item.status))) {
      throw new WorkbenchResultError("RESULT_CONTRACT_INVALID");
    }
    const decision = item.decision;
    const route = item.route;
    const sequence = item.sequence as number;
    if (typeof decision.action !== "string" || (decision.target !== null && typeof decision.target !== "string")
      || typeof decision.reason !== "string" || !Array.isArray(decision.evidenceRefs)
      || decision.evidenceRefs.some((ref) => typeof ref !== "string") || typeof decision.expectedImprovement !== "string"
      || !["low", "medium", "high"].includes(String(decision.risk)) || typeof route.allowed !== "boolean"
      || typeof route.action !== "string" || (route.normalizedTarget !== null && typeof route.normalizedTarget !== "string")
      || !Array.isArray(route.reasonCodes) || route.reasonCodes.some((code) => typeof code !== "string") || typeof route.shouldStop !== "boolean") {
      throw new WorkbenchResultError("RESULT_CONTRACT_INVALID");
    }
    return {
      sequence,
      decision: {
        action: decision.action,
        target: decision.target,
        reason: decision.reason,
        evidenceRefs: [...decision.evidenceRefs],
        expectedImprovement: decision.expectedImprovement,
        risk: decision.risk as "low" | "medium" | "high",
        issueKey: typeof decision.issueKey === "string" ? decision.issueKey : null,
      },
      route: {
        allowed: route.allowed,
        action: route.action,
        normalizedTarget: route.normalizedTarget,
        reasonCodes: [...route.reasonCodes],
        shouldStop: route.shouldStop,
      },
      status: item.status as WorkbenchActionAuditDto["status"],
      rejectedReason: typeof item.rejectedReason === "string" ? item.rejectedReason : null,
    };
  }).sort((left, right) => left.sequence - right.sequence);
}

function toHistoricalSuggestion(report: ReviewSummaryDto): HistoricalReviewSuggestionDto {
  const { overallScore: _overallScore, positioningDiagnosis: _positioningDiagnosis, ...historical } = report;
  return historical;
}

function isPreflightDecision(value: unknown): value is "PROCEED" | "ASK_USER" | "STOP_UNSUPPORTED" {
  return value === "PROCEED" || value === "ASK_USER" || value === "STOP_UNSUPPORTED";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
