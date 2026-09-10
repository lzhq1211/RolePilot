import {
  parseResumeContentV3,
  type WorkbenchAvailableDocumentDto,
  type WorkbenchDocumentContent,
  type WorkbenchDocumentDto,
  type WorkbenchDocumentVariant,
  type WorkbenchDto,
  type WorkbenchResultDto,
  type WorkbenchSaveResponseDto,
} from "web-contracts";

import { WorkbenchResultError, WorkbenchResultService } from "./workbench-result.js";
import type { WorkbenchDocumentRecord, WorkbenchRepository } from "./workbench-repository.js";

export type WorkbenchServiceErrorCode =
  | "REQUEST_INVALID"
  | "RUN_NOT_FOUND"
  | "RESULT_NOT_READY"
  | "RESULT_UNAVAILABLE"
  | "RESULT_CONTRACT_INVALID"
  | "WORKBENCH_DOCUMENT_NOT_FOUND"
  | "WORKBENCH_REVISION_CONFLICT";

export class WorkbenchServiceError extends Error {
  readonly code: WorkbenchServiceErrorCode;

  constructor(code: WorkbenchServiceErrorCode) {
    super(code);
    this.name = "WorkbenchServiceError";
    this.code = code;
  }
}

export class WorkbenchService {
  readonly #results: WorkbenchResultService;
  readonly #documents: WorkbenchRepository;

  constructor({ results, documents }: { results: WorkbenchResultService; documents: WorkbenchRepository }) {
    this.#results = results;
    this.#documents = documents;
  }

  async get(runId: string): Promise<WorkbenchDto> {
    const result = await this.#result(runId);
    const stored = await this.#documents.list(runId);
    if (stored.kind === "not-found") throw new WorkbenchServiceError("RUN_NOT_FOUND");
    const byDocumentId = indexStoredDocuments(result, stored.documents);
    const generatedReviewBinding = result.review?.kind === "final-bound" ? result.review.binding : null;

    return {
      runId: result.runId,
      availability: result.availability,
      deliveryStatus: result.deliveryStatus,
      original: result.original.availability === "AVAILABLE" && result.original.document && result.original.originArtifactId
        ? documentDto({
          initial: result.original.document,
          variant: "original",
          originArtifactId: result.original.originArtifactId,
          stored: byDocumentId.get(result.original.document.documentId),
          reviewBinding: null,
          review: null,
        })
        : unavailableOriginal(),
      generated: documentDto({
        initial: result.final,
        variant: "generated",
        originArtifactId: result.finalOriginArtifactId,
        stored: byDocumentId.get(result.final.documentId),
        reviewBinding: generatedReviewBinding,
        review: result.review,
      }),
      finalCandidateVersion: result.finalCandidateVersion,
      preflight: result.preflight,
      actionHistory: result.actionHistory,
      actionHistoryStatus: result.actionHistoryStatus,
      stopReason: result.stopReason,
    };
  }

  async save(
    runId: string,
    documentId: string,
    contentValue: unknown,
    expectedRevision: number,
  ): Promise<WorkbenchSaveResponseDto> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new WorkbenchServiceError("REQUEST_INVALID");
    }
    let content: WorkbenchDocumentContent;
    try {
      content = parseResumeContentV3(contentValue);
    } catch {
      throw new WorkbenchServiceError("REQUEST_INVALID");
    }
    if (content.documentId !== documentId) throw new WorkbenchServiceError("REQUEST_INVALID");

    const result = await this.#result(runId);
    const variant = resolveVariant(result, documentId);
    if (!variant) throw new WorkbenchServiceError("WORKBENCH_DOCUMENT_NOT_FOUND");
    const saved = await this.#documents.save({ runId, documentId, variant, content, expectedRevision });
    if (saved.kind === "not-found") throw new WorkbenchServiceError("WORKBENCH_DOCUMENT_NOT_FOUND");
    if (saved.kind === "conflict") throw new WorkbenchServiceError("WORKBENCH_REVISION_CONFLICT");
    return {
      documentId: saved.document.documentId,
      revision: saved.document.revision,
      updatedAt: saved.document.updatedAt,
    };
  }

  async #result(runId: string): Promise<WorkbenchResultDto> {
    try {
      return await this.#results.get(runId);
    } catch (error) {
      if (error instanceof WorkbenchResultError) throw new WorkbenchServiceError(error.code);
      throw error;
    }
  }
}

function resolveVariant(result: WorkbenchResultDto, documentId: string): WorkbenchDocumentVariant | null {
  if (result.final.documentId === documentId) return "generated";
  if (result.original.availability === "AVAILABLE" && result.original.document?.documentId === documentId) return "original";
  return null;
}

function indexStoredDocuments(
  result: WorkbenchResultDto,
  records: WorkbenchDocumentRecord[],
): Map<string, WorkbenchDocumentRecord> {
  const allowed = new Map<string, WorkbenchDocumentVariant>([[result.final.documentId, "generated"]]);
  if (result.original.availability === "AVAILABLE" && result.original.document) {
    allowed.set(result.original.document.documentId, "original");
  }
  const indexed = new Map<string, WorkbenchDocumentRecord>();
  for (const record of records) {
    if (record.runId !== result.runId || allowed.get(record.documentId) !== record.variant || indexed.has(record.documentId)) {
      throw new WorkbenchServiceError("RESULT_CONTRACT_INVALID");
    }
    indexed.set(record.documentId, record);
  }
  return indexed;
}

function documentDto({
  initial,
  variant,
  originArtifactId,
  stored,
  reviewBinding,
  review,
}: {
  initial: WorkbenchDocumentContent;
  variant: WorkbenchDocumentVariant;
  originArtifactId: string;
  stored: WorkbenchDocumentRecord | undefined;
  reviewBinding: WorkbenchAvailableDocumentDto["reviewBinding"];
  review: WorkbenchAvailableDocumentDto["review"];
}): WorkbenchAvailableDocumentDto {
  const content = stored?.content ?? initial;
  return {
    availability: "AVAILABLE",
    documentId: initial.documentId,
    variant,
    initialContent: structuredClone(initial),
    content: structuredClone(content),
    revision: stored?.revision ?? 0,
    updatedAt: stored?.updatedAt ?? null,
    originArtifactId,
    reviewBinding,
    review,
    contentEdited: stored ? JSON.stringify(content) !== JSON.stringify(initial) : false,
  };
}

function unavailableOriginal(): WorkbenchDocumentDto {
  return {
    availability: "UNAVAILABLE",
    documentId: null,
    variant: "original",
    initialContent: null,
    content: null,
    revision: 0,
    updatedAt: null,
    originArtifactId: null,
    reviewBinding: null,
    review: null,
    contentEdited: false,
  };
}
