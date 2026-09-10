import type {
  createBackendRegistry,
  ReplayResponseEntry,
} from "platform-adapters";
import type { ResumePlanStepId } from "platform-policy";
import type {
  ArtifactRecord,
  CheckpointSnapshot,
  createFileWorkspace,
  createWorkflowPlan,
  createWorkflowRuntime,
} from "platform-runtime";
import {
  createCheckpointStore,
  createDurableMemoryStore,
} from "platform-state";

import type {
  ResumeAgentBindings,
  ResumeAgentName,
  ResumeAppStatusEvent,
  OptimizationActionHistoryEntry,
  PendingReviewAction,
  PreflightDecision,
  QuestionRecord,
  QuestionStage,
  AnswerInterpretation,
  ResumeTarget,
  ResumeVerticalSliceInput,
} from "./types.js";
import type { ReviewBinding } from "./resume-document-operations.js";

type ReviewPolicyStateModule = typeof import("platform-contracts");

export type ReviewPolicyState = ReturnType<
  ReviewPolicyStateModule["createReviewPolicyState"]
>;

export type ResumeSliceMemory = {
  answerInterpretations: AnswerInterpretation[];
  userAnswerTexts: string[];
  candidateVersions: Record<string, number>;
  reviewBindings: Record<string, ReviewBinding>;
  reviewBindingArtifactPaths: Record<string, string>;
  evidenceVersion: number;
  deliveryStatus: "OPTIMIZED" | "SOURCE_ONLY" | null;
  finalReviewPath: string | null;
  schemaVersion: "v3";
  runId: string;
  company: ResumeTarget;
  timelinePath: string | null;
  originalResumePath: string | null;
  originalResumeSourcePath: string | null;
  sourceTextPath: string | null;
  currentResumePath: string | null;
  bestResumePath: string | null;
  bestReviewPath: string | null;
  finalResumePath: string | null;
  preflightDecision: PreflightDecision | null;
  preflightDecisionPath: string | null;
  supplementalEvidencePath: string | null;
  questionsPath: string | null;
  unsupportedPath: string | null;
  pendingUserQuestions: string[];
  questionRecords: QuestionRecord[];
  pendingQuestionStage: QuestionStage | null;
  pendingReviewAction: PendingReviewAction | null;
  safeWritingScope: string[];
  preflightAttempts: number;
  userQuestionRoundsUsed: number;
  optimizationActionsUsed: number;
  actionHistory: OptimizationActionHistoryEntry[];
  bestOptimizationReviewPath: string | null;
  optimizationStopReason: string | null;
  stopReason: string | null;
  reviewRoundsUsed: number;
  /** Proposal attempts per review artifact path (max 2: first pick + one re-selection). */
  proposalAttemptsByReview: Record<string, number>;
  /** Consecutive executed actions whose candidate failed to become the new Best. */
  consecutiveNoProgressActions: number;
};

export type ResumeSliceState = {
  answerInterpretations: AnswerInterpretation[];
  userAnswerTexts: string[];
  candidateVersions: Record<string, number>;
  reviewBindings: Record<string, ReviewBinding>;
  reviewBindingArtifactPaths: Record<string, string>;
  evidenceVersion: number;
  lastWriteNoOp: boolean;
  deliveryStatus: "OPTIMIZED" | "SOURCE_ONLY" | null;
  finalReviewPath: string | null;
  timelineArtifact: ArtifactRecord | null;
  originalResumeArtifact: ArtifactRecord | null;
  originalResumeSourceArtifact: ArtifactRecord | null;
  sourceTextArtifact: ArtifactRecord | null;
  jdAnalysisArtifact: ArtifactRecord | null;
  currentResumeArtifact: ArtifactRecord | null;
  bestResumeArtifact: ArtifactRecord | null;
  bestReviewArtifact: ArtifactRecord | null;
  finalResumeArtifact: ArtifactRecord | null;
  workbenchDeliveryArtifact: ArtifactRecord | null;
  interviewArtifact: ArtifactRecord | null;
  cheatsheetArtifact: ArtifactRecord | null;
  interviewSourceResumePath: string | null;
  cheatsheetSourceResumePath: string | null;
  preflightDecisionArtifact: ArtifactRecord | null;
  questionsArtifact: ArtifactRecord | null;
  unsupportedArtifact: ArtifactRecord | null;
  supplementalEvidenceArtifact: ArtifactRecord | null;
  preflightDecision: PreflightDecision | null;
  pendingUserQuestions: string[];
  questionRecords: QuestionRecord[];
  pendingQuestionStage: QuestionStage | null;
  pendingReviewAction: PendingReviewAction | null;
  safeWritingScope: string[];
  preflightAttempts: number;
  userQuestionRoundsUsed: number;
  optimizationActionsUsed: number;
  actionHistory: OptimizationActionHistoryEntry[];
  bestOptimizationReviewArtifact: ArtifactRecord | null;
  optimizationStopReason: string | null;
  reviewPolicyState: ReviewPolicyState;
  reviewRoundsUsed: number;
  stopReason: string | null;
  resumedFromCheckpoint: boolean;
  telemetrySequence: number;
  /** Proposal attempts per review artifact path (max 2: first pick + one re-selection). */
  proposalAttemptsByReview: Record<string, number>;
  /** Consecutive executed actions whose candidate failed to become the new Best. */
  consecutiveNoProgressActions: number;
};

export type ResumeCheckpointAppState = {
  schemaVersion: "v2" | "v3";
  state: ResumeSliceState;
  agentQueues: Record<ResumeAgentName, ReplayResponseEntry[]>;
};

export type ResumeCheckpointSnapshot = CheckpointSnapshot & {
  appState: ResumeCheckpointAppState;
};

export type ResumeSliceContext = {
  input: ResumeVerticalSliceInput;
  startedAt: number;
  workspace: ReturnType<typeof createFileWorkspace>;
  checkpointStore: ReturnType<typeof createCheckpointStore>;
  memoryStore: ReturnType<typeof createDurableMemoryStore>;
  memoryNamespace: string;
  planFingerprint: string;
  agentBindings: ResumeAgentBindings;
  agentQueues: Record<ResumeAgentName, ReplayResponseEntry[]>;
  state: ResumeSliceState;
  registry: ReturnType<typeof createBackendRegistry>;
  onStatus?: (event: ResumeAppStatusEvent) => void;
};

export type ResumeSliceRuntimeBundle = {
  policy: {
    ok: true;
    value: { steps: Array<{ id: ResumePlanStepId; rationale: string }> };
  };
  workflowPlan: ReturnType<typeof createWorkflowPlan>;
  runtime: ReturnType<typeof createWorkflowRuntime<ResumeSliceContext>>;
  sliceContext: ResumeSliceContext;
};
