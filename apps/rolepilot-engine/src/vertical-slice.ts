import { getFailedTaskMessage } from "./slice-agents.js";
import { emitStatus, persistMemory } from "./slice-artifacts.js";
import {
  createResumeSliceContext,
  saveCheckpoint,
  writeManifest,
} from "./slice-workflow.js";
import type {
  ResumeVerticalSliceInput,
  ResumeVerticalSliceResult,
} from "./types.js";
import type { ResumeSliceContext } from "./vertical-slice-types.js";

function isPreflightStopReason(value: string | null) {
  return value === "needs-user-input" || value === "unsupported-input";
}

function requireArtifactPath(
  artifact: { absolutePath: string } | null,
  label: string,
) {
  if (!artifact) {
    throw new Error(`${label} artifact is missing from resume slice state.`);
  }
  return artifact.absolutePath;
}

function assertFinalDeliveryConsistency(
  sliceContext: ResumeSliceContext,
  expectsInterview: boolean,
) {
  if (!expectsInterview) {
    return;
  }

  const finalResume = requireArtifactPath(
    sliceContext.state.finalResumeArtifact,
    "Final resume",
  );
  if (
    sliceContext.state.interviewSourceResumePath !== finalResume ||
    sliceContext.state.cheatsheetSourceResumePath !== finalResume
  ) {
    throw new Error(
      "Interview and cheatsheet must both reference the current final resume.",
    );
  }
}

function createResultFromState(
  input: ResumeVerticalSliceInput,
  sliceContext: ResumeSliceContext,
  runtimeState: {
    manifest: ResumeVerticalSliceResult["workflowManifest"];
  },
  manifest: {
    manifestPath: string;
    artifactManifest: ResumeVerticalSliceResult["artifactManifest"];
  },
): ResumeVerticalSliceResult {
  const finalResume = sliceContext.state.finalResumeArtifact;
  const bestResume = sliceContext.state.bestResumeArtifact;
  const bestReview = sliceContext.state.bestReviewArtifact;
  const interview = sliceContext.state.interviewArtifact;
  const cheatsheet = sliceContext.state.cheatsheetArtifact;
  const timeline = sliceContext.state.timelineArtifact;
  const jdAnalysis = sliceContext.state.jdAnalysisArtifact;

  return {
    deliveryStatus: sliceContext.state.deliveryStatus,
    finalReviewPath: sliceContext.state.finalReviewPath,
    workbenchDeliveryPath:
      sliceContext.state.workbenchDeliveryArtifact?.absolutePath ?? null,
    runId: input.runId,
    stopReason: sliceContext.state.stopReason,
    finalResumePath: finalResume?.absolutePath ?? null,
    bestResumePath: bestResume?.absolutePath ?? null,
    bestReviewPath: bestReview?.absolutePath ?? null,
    interviewPath: interview?.absolutePath ?? null,
    cheatsheetPath: cheatsheet?.absolutePath ?? null,
    interviewSourceResumePath: sliceContext.state.interviewSourceResumePath,
    cheatsheetSourceResumePath: sliceContext.state.cheatsheetSourceResumePath,
    timelinePath: requireArtifactPath(timeline, "Timeline"),
    originalResumePath: sliceContext.state.originalResumeArtifact?.absolutePath ?? null,
    originalResumeSourcePath: sliceContext.state.originalResumeSourceArtifact?.absolutePath ?? null,
    sourceTextPath: sliceContext.state.sourceTextArtifact?.absolutePath ?? null,
    jdAnalysisPath: requireArtifactPath(jdAnalysis, "JD analysis"),
    preflightDecisionPath:
      sliceContext.state.preflightDecisionArtifact?.absolutePath ?? null,
    supplementalEvidencePath:
      sliceContext.state.supplementalEvidenceArtifact?.absolutePath ?? null,
    questionsPath: sliceContext.state.questionsArtifact?.absolutePath ?? null,
    unsupportedPath:
      sliceContext.state.unsupportedArtifact?.absolutePath ?? null,
    preflightDecision: sliceContext.state.preflightDecision,
    pendingUserQuestions: [...sliceContext.state.pendingUserQuestions],
    pendingQuestionStage: sliceContext.state.pendingQuestionStage,
    optimizationActionsUsed: sliceContext.state.optimizationActionsUsed,
    actionHistory: structuredClone(sliceContext.state.actionHistory),
    optimizationStopReason: sliceContext.state.optimizationStopReason,
    manifestPath: manifest.manifestPath,
    logPath: sliceContext.workspace.telemetry.logPath,
    telemetryPath: sliceContext.workspace.telemetry.streamPath,
    resumedFromCheckpoint: sliceContext.state.resumedFromCheckpoint,
    workflowManifest: runtimeState.manifest,
    artifactManifest: manifest.artifactManifest,
    reviewRoundsUsed: sliceContext.state.reviewRoundsUsed,
  };
}

export async function runResumeVerticalSlice(
  input: ResumeVerticalSliceInput,
): Promise<ResumeVerticalSliceResult> {
  const { workflowPlan, runtime, sliceContext } =
    await createResumeSliceContext(input);
  const runtimeState = await runtime.run();
  saveCheckpoint(sliceContext, runtimeState.checkpoint);
  if (runtimeState.stopReason === "cancelled") {
    const manifest = writeManifest(sliceContext, runtimeState.manifest);
    sliceContext.state.stopReason = "cancelled";
    persistMemory(sliceContext);
    emitStatus(sliceContext, {
      type: "run-cancelled",
      runId: input.runId,
      reason: "Run cancelled by user.",
      reviewRoundsUsed: sliceContext.state.reviewRoundsUsed,
      manifestPath: manifest.manifestPath,
    });
    throw new Error("Run cancelled by user.");
  }

  if (runtimeState.stopReason === "failed") {
    writeManifest(sliceContext, runtimeState.manifest);
    persistMemory(sliceContext);
    const { failedTaskId, failedMessage } = getFailedTaskMessage(
      runtimeState.graph,
      workflowPlan.executionOrder,
    );
    throw new Error(
      failedMessage ??
        `Resume vertical slice failed during task "${failedTaskId ?? "unknown"}".`,
    );
  }

  persistMemory(sliceContext);

  const timeline = sliceContext.state.timelineArtifact;
  const jdAnalysis = sliceContext.state.jdAnalysisArtifact;
  if (isPreflightStopReason(sliceContext.state.stopReason)) {
    const manifest = writeManifest(sliceContext, runtimeState.manifest);
    const result = createResultFromState(
      input,
      sliceContext,
      runtimeState,
      manifest,
    );
    emitStatus(sliceContext, {
      type: "run-completed",
      runId: input.runId,
      stopReason: result.stopReason,
      reviewRoundsUsed: result.reviewRoundsUsed,
      manifestPath: result.manifestPath,
    });
    return result;
  }

  const finalResume = sliceContext.state.finalResumeArtifact;
  const bestResume = sliceContext.state.bestResumeArtifact;
  const bestReview = sliceContext.state.bestReviewArtifact;
  const interview = sliceContext.state.interviewArtifact;
  const cheatsheet = sliceContext.state.cheatsheetArtifact;
  const expectsInterview = workflowPlan.executionOrder.includes("interview");
  if (
    !finalResume ||
    !bestResume ||
    !bestReview ||
    !timeline ||
    !jdAnalysis ||
    (expectsInterview && (!interview || !cheatsheet))
  ) {
    throw new Error(
      `Resume vertical slice ended incomplete after tasks: ${workflowPlan.executionOrder.join(
        ", ",
      )}`,
    );
  }
  assertFinalDeliveryConsistency(sliceContext, expectsInterview);

  const manifest = writeManifest(sliceContext, runtimeState.manifest);

  const result = createResultFromState(
    input,
    sliceContext,
    runtimeState,
    manifest,
  );

  emitStatus(sliceContext, {
    type: "run-completed",
    runId: input.runId,
    stopReason: result.stopReason,
    reviewRoundsUsed: result.reviewRoundsUsed,
    manifestPath: result.manifestPath,
  });

  return result;
}
