import type { ReviewSummaryDto } from "./result.js";
import type { ResumeContentV3 } from "./resume-document.js";

// Content format, Agent candidate version and manual-save revision are distinct.
export type WorkbenchDocumentContent = ResumeContentV3;
export type WorkbenchDocumentVariant = "original" | "generated";

export type WorkbenchDeliveryStatus = "OPTIMIZED" | "SOURCE_ONLY";

export type WorkbenchReviewBindingDto = {
  documentId: string;
  candidateVersion: number;
  evidenceVersion: number;
  reviewArtifactPath: string;
  issueTargets: Array<{
    issueRef: string;
    issueKey: string;
    target: { nodeId: string } | { profileField: string } | null;
  }>;
};

export type HistoricalReviewSuggestionDto = Pick<
  ReviewSummaryDto,
  "schemaVersion" | "verdict" | "roleInfoQuestion" | "topIssues" | "jdCoverage" | "strengths"
>;

export type WorkbenchReviewDto =
  | {
    kind: "final-bound";
    report: ReviewSummaryDto;
    binding: WorkbenchReviewBindingDto;
  }
  | {
    kind: "historical-suggestion";
    report: HistoricalReviewSuggestionDto | null;
    binding: null;
  }
  | null;

export type WorkbenchActionAuditDto = {
  sequence: number;
  decision: {
    action: string;
    target: string | null;
    reason: string;
    evidenceRefs: string[];
    expectedImprovement: string;
    risk: "low" | "medium" | "high";
    issueKey: string | null;
  };
  route: {
    allowed: boolean;
    action: string;
    normalizedTarget: string | null;
    reasonCodes: string[];
    shouldStop: boolean;
  };
  status: "rejected" | "executed" | "stopped" | "no-op";
  rejectedReason: string | null;
};

export type WorkbenchResultDto = {
  runId: string;
  availability: "READY";
  deliveryStatus: WorkbenchDeliveryStatus | "HISTORICAL";
  original: {
    availability: "AVAILABLE" | "UNAVAILABLE";
    document: ResumeContentV3 | null;
    originArtifactId: string | null;
  };
  final: ResumeContentV3;
  finalOriginArtifactId: string;
  finalCandidateVersion: number | null;
  preflight: {
    decision: "PROCEED" | "ASK_USER" | "STOP_UNSUPPORTED";
    safeWritingScope: string[];
  } | null;
  review: WorkbenchReviewDto;
  actionHistory: WorkbenchActionAuditDto[];
  actionHistoryStatus: "VERIFIED" | "UNKNOWN";
  stopReason: "needs-user-input" | "unsupported-input" | "pass" | "early-stop" | "max-rounds" | "cancelled" | null;
};

export type WorkbenchAvailableDocumentDto = {
  availability: "AVAILABLE";
  documentId: string;
  variant: WorkbenchDocumentVariant;
  initialContent: WorkbenchDocumentContent;
  content: WorkbenchDocumentContent;
  revision: number;
  updatedAt: string | null;
  originArtifactId: string;
  reviewBinding: WorkbenchReviewBindingDto | null;
  review: WorkbenchReviewDto;
  contentEdited: boolean;
};

export type WorkbenchUnavailableDocumentDto = {
  availability: "UNAVAILABLE";
  documentId: null;
  variant: "original";
  initialContent: null;
  content: null;
  revision: 0;
  updatedAt: null;
  originArtifactId: null;
  reviewBinding: null;
  review: null;
  contentEdited: false;
};

export type WorkbenchDocumentDto = WorkbenchAvailableDocumentDto | WorkbenchUnavailableDocumentDto;

export type WorkbenchDto = {
  runId: string;
  availability: "READY";
  deliveryStatus: WorkbenchResultDto["deliveryStatus"];
  original: WorkbenchDocumentDto;
  generated: WorkbenchAvailableDocumentDto;
  finalCandidateVersion: number | null;
  preflight: WorkbenchResultDto["preflight"];
  actionHistory: WorkbenchActionAuditDto[];
  actionHistoryStatus: WorkbenchResultDto["actionHistoryStatus"];
  stopReason: WorkbenchResultDto["stopReason"];
};

export type WorkbenchSaveInput = {
  content: WorkbenchDocumentContent;
  expectedRevision: number;
};

export type WorkbenchSaveResponseDto = {
  documentId: string;
  revision: number;
  updatedAt: string;
};
