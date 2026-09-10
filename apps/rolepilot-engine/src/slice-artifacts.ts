import fs from "node:fs";
import path from "node:path";

import { createReviewPolicyState } from "platform-contracts";
import type { ResumeAppStatusEvent } from "./types.js";
import type {
  ResumeSliceContext,
  ResumeSliceMemory,
  ResumeSliceState,
} from "./vertical-slice-types.js";

export const MAX_USER_QUESTION_ROUNDS = 2;

export function questionAllowance(context: ResumeSliceContext) {
  const used = context.state.userQuestionRoundsUsed;
  const remainingQuestionRounds = Number.isInteger(used) && used >= 0
    ? Math.max(0, MAX_USER_QUESTION_ROUNDS - used)
    : 0;
  return { remainingQuestionRounds, canAskUser: remainingQuestionRounds > 0 };
}

export function emitStatus(
  context: ResumeSliceContext,
  event: ResumeAppStatusEvent,
) {
  context.onStatus?.(event);
}

export function createInitialState(): ResumeSliceState {
  return {
    answerInterpretations: [],
    userAnswerTexts: [],
    candidateVersions: {},
    reviewBindings: {},
    reviewBindingArtifactPaths: {},
    evidenceVersion: 0,
    lastWriteNoOp: false,
    deliveryStatus: null,
    finalReviewPath: null,
    timelineArtifact: null,
    originalResumeArtifact: null,
    originalResumeSourceArtifact: null,
    sourceTextArtifact: null,
    jdAnalysisArtifact: null,
    currentResumeArtifact: null,
    bestResumeArtifact: null,
    bestReviewArtifact: null,
    finalResumeArtifact: null,
    workbenchDeliveryArtifact: null,
    interviewArtifact: null,
    cheatsheetArtifact: null,
    interviewSourceResumePath: null,
    cheatsheetSourceResumePath: null,
    preflightDecisionArtifact: null,
    questionsArtifact: null,
    unsupportedArtifact: null,
    supplementalEvidenceArtifact: null,
    preflightDecision: null,
    pendingUserQuestions: [],
    questionRecords: [],
    pendingQuestionStage: null,
    pendingReviewAction: null,
    safeWritingScope: [],
    preflightAttempts: 0,
    userQuestionRoundsUsed: 0,
    optimizationActionsUsed: 0,
    actionHistory: [],
    bestOptimizationReviewArtifact: null,
    optimizationStopReason: null,
    reviewPolicyState: createReviewPolicyState(),
    reviewRoundsUsed: 0,
    stopReason: null,
    resumedFromCheckpoint: false,
    telemetrySequence: 1,
    proposalAttemptsByReview: {},
    consecutiveNoProgressActions: 0,
  };
}

function createMemorySnapshot(context: ResumeSliceContext): ResumeSliceMemory {
  return {
    answerInterpretations: structuredClone(context.state.answerInterpretations),
    userAnswerTexts: [...context.state.userAnswerTexts],
    candidateVersions: { ...context.state.candidateVersions },
    reviewBindings: structuredClone(context.state.reviewBindings),
    reviewBindingArtifactPaths: { ...context.state.reviewBindingArtifactPaths },
    evidenceVersion: context.state.evidenceVersion,
    deliveryStatus: context.state.deliveryStatus,
    finalReviewPath: context.state.finalReviewPath,
    schemaVersion: "v3",
    runId: context.input.runId,
    company: context.input.company,
    timelinePath: context.state.timelineArtifact?.absolutePath ?? null,
    originalResumePath: context.state.originalResumeArtifact?.absolutePath ?? null,
    originalResumeSourcePath: context.state.originalResumeSourceArtifact?.absolutePath ?? null,
    sourceTextPath: context.state.sourceTextArtifact?.absolutePath ?? null,
    currentResumePath:
      context.state.currentResumeArtifact?.absolutePath ?? null,
    bestResumePath: context.state.bestResumeArtifact?.absolutePath ?? null,
    bestReviewPath: context.state.bestReviewArtifact?.absolutePath ?? null,
    finalResumePath: context.state.finalResumeArtifact?.absolutePath ?? null,
    preflightDecision: context.state.preflightDecision,
    preflightDecisionPath:
      context.state.preflightDecisionArtifact?.absolutePath ?? null,
    supplementalEvidencePath:
      context.state.supplementalEvidenceArtifact?.absolutePath ?? null,
    questionsPath: context.state.questionsArtifact?.absolutePath ?? null,
    unsupportedPath: context.state.unsupportedArtifact?.absolutePath ?? null,
    pendingUserQuestions: [...context.state.pendingUserQuestions],
    questionRecords: structuredClone(context.state.questionRecords),
    pendingQuestionStage: context.state.pendingQuestionStage,
    pendingReviewAction: structuredClone(context.state.pendingReviewAction),
    safeWritingScope: [...context.state.safeWritingScope],
    preflightAttempts: context.state.preflightAttempts,
    userQuestionRoundsUsed: context.state.userQuestionRoundsUsed,
    optimizationActionsUsed: context.state.optimizationActionsUsed,
    actionHistory: structuredClone(context.state.actionHistory),
    bestOptimizationReviewPath:
      context.state.bestOptimizationReviewArtifact?.absolutePath ?? null,
    optimizationStopReason: context.state.optimizationStopReason,
    stopReason: context.state.stopReason,
    reviewRoundsUsed: context.state.reviewRoundsUsed,
    proposalAttemptsByReview: { ...context.state.proposalAttemptsByReview },
    consecutiveNoProgressActions: context.state.consecutiveNoProgressActions,
  };
}

export function persistMemory(context: ResumeSliceContext) {
  context.memoryStore.put(
    context.memoryNamespace,
    createMemorySnapshot(context),
  );
}

export function persistArtifact(
  record: { absolutePath: string },
  content: string,
) {
  fs.mkdirSync(path.dirname(record.absolutePath), { recursive: true });
  fs.writeFileSync(record.absolutePath, content, "utf8");
}

export function registerArtifact(
  context: ResumeSliceContext,
  spec: Parameters<ResumeSliceContext["workspace"]["registerArtifact"]>[0],
  content: string,
) {
  const record = context.workspace.registerArtifact(spec);
  persistArtifact(record, content);
  emitStatus(context, {
    type: "artifact-created",
    runId: context.input.runId,
    artifact: record,
  });
  return record;
}

export function requireTimeline(context: ResumeSliceContext) {
  if (context.state.timelineArtifact) {
    return context.state.timelineArtifact;
  }

  throw new Error(
    "Resume write requires timeline context. Provide timelineText or run mine first.",
  );
}

export function requireResume(context: ResumeSliceContext) {
  if (context.state.currentResumeArtifact) {
    return context.state.currentResumeArtifact;
  }

  throw new Error(
    "Resume review requires a drafted resume. Run write before review.",
  );
}

export function requireFinalResume(context: ResumeSliceContext) {
  if (context.state.finalResumeArtifact) {
    return context.state.finalResumeArtifact;
  }

  throw new Error(
    "Interview preparation requires a finalized resume. Review must complete first.",
  );
}
