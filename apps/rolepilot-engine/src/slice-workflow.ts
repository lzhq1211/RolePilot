import fs from "node:fs";
import { AnswerInterpretationError } from "./question-policy.js";

import {
  createBackendRegistry,
  createConcreteAdapters,
} from "platform-adapters";
import { createResumeGoalPlan } from "platform-policy";
import {
  createFileWorkspace,
  createWorkflowPlan,
  createWorkflowRuntime,
  type CheckpointSnapshot,
  type WorkflowTask,
} from "platform-runtime";
import {
  createCheckpointStore,
  createDurableMemoryStore,
} from "platform-state";

import {
  buildResumeGoalInput,
  assertNonEmptyString,
  createArtifactBaseName,
  createPlanFingerprint,
  createPlanStepStatuses,
  getGoalText,
  toJsonText,
} from "./shared.js";
import { createAgentQueues, resolveTaskAgent } from "./slice-agents.js";
import {
  createInitialState,
  emitStatus,
  persistArtifact,
  persistMemory,
} from "./slice-artifacts.js";
import {
  runJdAnalysisStep,
  runInterviewStep,
  runMineStep,
  runPreflightStep,
  runReviewStep,
  runWriteStep,
  persistSupplementalEvidence,
  seedTimelineIfProvided,
} from "./slice-steps.js";
import type {
  ResumeCheckpointSnapshot,
  ResumeSliceContext,
  ResumeSliceRuntimeBundle,
  ResumeSliceState,
} from "./vertical-slice-types.js";
import type { ResumeVerticalSliceInput } from "./types.js";
function isPreflightStopReason(value: string | null) {
  return value === "needs-user-input" || value === "unsupported-input";
}

const RESUME_CHECKPOINT_THREAD_ID = "resume-vertical-slice";
const RESUME_TASK_IDS_BY_STAGE = {
  preflight: new Set(["preflight", "write", "review", "interview"]),
  review: new Set(["review", "interview"]),
} as const;
const STATE_ARTIFACT_KEYS = [
  "timelineArtifact",
  "originalResumeArtifact",
  "originalResumeSourceArtifact",
  "sourceTextArtifact",
  "jdAnalysisArtifact",
  "currentResumeArtifact",
  "bestResumeArtifact",
  "bestReviewArtifact",
  "finalResumeArtifact",
  "workbenchDeliveryArtifact",
  "interviewArtifact",
  "cheatsheetArtifact",
  "preflightDecisionArtifact",
  "questionsArtifact",
  "unsupportedArtifact",
  "supplementalEvidenceArtifact",
  "bestOptimizationReviewArtifact",
] as const satisfies ReadonlyArray<keyof ResumeSliceState>;

function assertResumeCheckpointSnapshot(
  value: unknown,
): asserts value is ResumeCheckpointSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Resume checkpoint snapshot must be an object.");
  }

  const appState = Reflect.get(value, "appState");
  if (!appState || typeof appState !== "object" || Array.isArray(appState)) {
    throw new Error("Resume checkpoint is missing appState.");
  }
  const schemaVersion = Reflect.get(appState, "schemaVersion");
  if (schemaVersion === "v1") {
    throw new Error(
      "Resume checkpoint uses legacy appState v1 and cannot be resumed safely. Start a new run; the existing checkpoint is preserved.",
    );
  }
  if (schemaVersion !== "v2" && schemaVersion !== "v3") {
    throw new Error("Unsupported resume checkpoint appState schema.");
  }

  const state = Reflect.get(appState, "state");
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("Resume checkpoint appState.state must be an object.");
  }

  const agentQueues = Reflect.get(appState, "agentQueues");
  if (!agentQueues || typeof agentQueues !== "object" || Array.isArray(agentQueues)) {
    throw new Error("Resume checkpoint appState.agentQueues must be an object.");
  }
  for (const agent of ["miner", "writer", "reviewer", "interviewer"]) {
    if (!Array.isArray(Reflect.get(agentQueues, agent))) {
      throw new Error(
        `Resume checkpoint appState.agentQueues.${agent} must be an array.`,
      );
    }
  }
}

function restoreArtifactRecord(
  context: ResumeSliceContext,
  artifact: ResumeSliceState[(typeof STATE_ARTIFACT_KEYS)[number]],
) {
  if (!artifact) {
    return null;
  }
  if (!fs.existsSync(artifact.absolutePath)) {
    throw new Error(
      `Resume checkpoint artifact is missing: ${artifact.absolutePath}`,
    );
  }

  const restored = context.workspace.registerArtifact({
    kind: artifact.kind,
    fileName: artifact.fileName,
    generator: artifact.generator,
    stage: artifact.stage,
  });
  if (
    restored.absolutePath !== artifact.absolutePath ||
    restored.path !== artifact.path
  ) {
    throw new Error(
      `Resume checkpoint artifact path does not match current workspace: ${artifact.path}`,
    );
  }
  return restored;
}

function restoreActionHistoryArtifact(
  context: ResumeSliceContext,
  artifactPath: string | null,
) {
  if (!artifactPath) return;
  const fileName = artifactPath.split("/").at(-1);
  if (!fileName) throw new Error("Resume checkpoint action artifact path is invalid.");
  const spec = fileName.includes(".optimization.decision-")
    ? { kind: "optimization-decision" as const, fileName, generator: "reviewer", stage: "draft" as const }
    : fileName.includes(".review.")
      ? { kind: "review-report" as const, fileName, generator: "reviewer", stage: "draft" as const }
      : fileName.includes(".resume.")
        ? { kind: "resume" as const, fileName, generator: "writer", stage: "draft" as const }
        : null;
  if (!spec) throw new Error(`Resume checkpoint action artifact has an unsupported path: ${artifactPath}`);
  const restored = context.workspace.registerArtifact(spec);
  if (restored.absolutePath !== artifactPath) {
    throw new Error(`Resume checkpoint action artifact path does not match current workspace: ${artifactPath}`);
  }
}

function hydrateResumeCheckpointState(
  context: ResumeSliceContext,
  checkpoint: ResumeCheckpointSnapshot,
) {
  assertResumeCheckpointSnapshot(checkpoint);
  const restoredState = structuredClone(checkpoint.appState.state);
  for (const key of STATE_ARTIFACT_KEYS) {
    restoredState[key] = restoreArtifactRecord(context, restoredState[key]);
  }
  for (const entry of restoredState.actionHistory ?? []) {
    restoreActionHistoryArtifact(context, entry.decisionPath);
    restoreActionHistoryArtifact(context, entry.candidateResumePath);
    restoreActionHistoryArtifact(context, entry.sourceReviewPath);
    restoreActionHistoryArtifact(context, entry.resultReviewPath);
  }
  context.state = restoredState;
  context.state.userAnswerTexts ??= [];
  context.state.answerInterpretations ??= [];
  if (checkpoint.appState.schemaVersion === "v2") {
    for (const record of context.state.questionRecords ?? []) {
      record.acceptedFacts = [];
      record.corrections = [];
      record.sourceQuote = null;
      if (record.status === "answered" || record.status === "partial") record.status = "off_topic";
    }
  }
  context.state.candidateVersions ??= {};
  context.state.reviewBindings ??= {};
  context.state.reviewBindingArtifactPaths ??= {};
  context.state.evidenceVersion ??= 0;
  context.state.lastWriteNoOp = false;
  context.state.deliveryStatus ??= null;
  context.state.finalReviewPath ??= null;
  context.state.questionRecords ??= [];
  context.state.pendingQuestionStage ??= null;
  context.state.pendingReviewAction ??= null;
  context.agentQueues = structuredClone(checkpoint.appState.agentQueues);

  if (context.state.stopReason !== "needs-user-input") {
    throw new Error(
      "Resume checkpoint is not waiting for user evidence and cannot be resumed.",
    );
  }
  if (!context.state.timelineArtifact || !context.state.jdAnalysisArtifact) {
    throw new Error(
      "Resume checkpoint is missing completed timeline or JD analysis artifacts.",
    );
  }
  if (
    context.state.pendingQuestionStage !== "preflight" &&
    context.state.pendingQuestionStage !== "review"
  ) {
    throw new Error("Resume checkpoint is missing the blocked workflow stage.");
  }
}

function resetAppStateForEvidenceResume(
  context: ResumeSliceContext,
  stage: "preflight" | "review",
) {
  context.state.pendingUserQuestions = [];
  context.state.questionsArtifact = null;
  context.state.finalResumeArtifact = null;
  context.state.workbenchDeliveryArtifact = null;
  context.state.interviewArtifact = null;
  context.state.cheatsheetArtifact = null;
  context.state.interviewSourceResumePath = null;
  context.state.cheatsheetSourceResumePath = null;
  context.state.stopReason = null;
  context.state.pendingQuestionStage = null;
  if (stage === "preflight") {
    context.state.preflightDecision = null;
    context.state.preflightDecisionArtifact = null;
    context.state.safeWritingScope = [];
    context.state.unsupportedArtifact = null;
    context.state.currentResumeArtifact = null;
    context.state.bestResumeArtifact = null;
    context.state.bestReviewArtifact = null;
    context.state.bestOptimizationReviewArtifact = null;
    context.state.optimizationStopReason = null;
    context.state.reviewPolicyState = createInitialState().reviewPolicyState;
    context.state.reviewRoundsUsed = 0;
    context.state.pendingReviewAction = null;
  }
  context.state.resumedFromCheckpoint = true;
}

function prepareRuntimeCheckpointForEvidenceResume(
  checkpoint: ResumeCheckpointSnapshot,
  taskIds: string[],
  stage: "preflight" | "review",
): ResumeCheckpointSnapshot {
  const resumed = structuredClone(checkpoint);
  const graph = resumed.graph;
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
    throw new Error("Resume checkpoint graph must be an object.");
  }
  const tasks = Reflect.get(graph, "tasks");
  if (!tasks || typeof tasks !== "object" || Array.isArray(tasks)) {
    throw new Error("Resume checkpoint graph.tasks must be an object.");
  }

  const resetTaskIds = RESUME_TASK_IDS_BY_STAGE[stage];
  for (const taskId of resetTaskIds) {
    if (!taskIds.includes(taskId)) {
      continue;
    }
    const task = Reflect.get(tasks, taskId);
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      throw new Error(`Resume checkpoint is missing task "${taskId}".`);
    }
    Reflect.set(tasks, taskId, { id: taskId, status: "pending" });
  }

  resumed.stopReason = null;
  resumed.manifest = {
    ...resumed.manifest,
    completedTaskIds: resumed.manifest.completedTaskIds.filter(
      (taskId) => !resetTaskIds.has(taskId),
    ),
    failedTaskIds: resumed.manifest.failedTaskIds.filter(
      (taskId) => !resetTaskIds.has(taskId),
    ),
    stopReason: null,
  };
  return resumed;
}

function createResumeCheckpointSnapshot(
  context: ResumeSliceContext,
  checkpoint: CheckpointSnapshot,
): ResumeCheckpointSnapshot {
  return {
    ...checkpoint,
    appState: {
      schemaVersion: "v3",
      state: structuredClone(context.state),
      agentQueues: structuredClone(context.agentQueues),
    },
  };
}

export function executeWorkflowTask(
  task: WorkflowTask,
  context: ResumeSliceContext,
) {
  const { stepId } = resolveTaskAgent(task);
  switch (stepId) {
    case "mine":
      return runMineStep(context);
    case "jd-analysis":
      return runJdAnalysisStep(context);
    case "preflight":
      return runPreflightStep(context);
    case "write":
      return runWriteStep(context);
    case "review":
      return runReviewStep(context);
    case "interview":
      return runInterviewStep(context);
  }
}

export async function createResumeSliceContext(
  input: ResumeVerticalSliceInput,
  checkpoint?: CheckpointSnapshot,
): Promise<ResumeSliceRuntimeBundle> {
  const policy = createResumeGoalPlan(buildResumeGoalInput(input));
  if (!policy.ok) {
    throw new Error(policy.reasons[0]?.message ?? "Resume plan was denied.");
  }

  const workflowPlan = createWorkflowPlan(
    policy.value.steps.map((step, index) => ({
      id: step.id,
      dependencies: index === 0 ? [] : [policy.value.steps[index - 1].id],
      payload: step,
    })),
  );
  const workspace = createFileWorkspace({
    rootDir: input.rootDir,
    runId: input.runId,
    createdAt: input.createdAt,
  });
  const checkpointStore = createCheckpointStore({ rootDir: input.rootDir });
  const memoryStore = createDurableMemoryStore({ rootDir: input.rootDir });
  const agentBindings = input.agentBindings;
  const registry = createBackendRegistry(
    createConcreteAdapters({
      env: input.env,
      cwd: input.rootDir,
    }),
  );
  const sliceContext: ResumeSliceContext = {
    input,
    startedAt: Date.now(),
    workspace,
    checkpointStore,
    memoryStore,
    memoryNamespace: `rolepilot-engine.${input.runId}`,
    planFingerprint: createPlanFingerprint(workflowPlan.executionOrder),
    agentBindings,
    agentQueues: createAgentQueues(agentBindings),
    state: createInitialState(),
    registry,
    onStatus: input.onStatus,
  };

  let runtimeCheckpoint = checkpoint;
  if (input.resumeFromCheckpoint) {
    if (checkpoint) {
      throw new Error(
        "Resume checkpoints must be loaded from the checkpoint store, not passed directly.",
      );
    }
    const userEvidenceText = assertNonEmptyString(
      input.userEvidenceText,
      "Resuming from checkpoint requires non-empty userEvidenceText.",
    );
    const record = checkpointStore.resume<ResumeCheckpointSnapshot>({
      runId: input.runId,
      threadId: RESUME_CHECKPOINT_THREAD_ID,
      planFingerprint: sliceContext.planFingerprint,
    });
    hydrateResumeCheckpointState(sliceContext, record.snapshot);
    const stage = sliceContext.state.pendingQuestionStage;
    if (stage !== "preflight" && stage !== "review") {
      throw new Error("Resume checkpoint is missing the blocked workflow stage.");
    }
    try {
      await persistSupplementalEvidence(sliceContext, userEvidenceText);
    } catch (error) {
      if (error instanceof AnswerInterpretationError) {
        // Keep the blocked graph and unmodified facts, but retain the submitted
        // text, diagnostic artifacts and consumed offline responses for retry.
        saveCheckpoint(sliceContext, record.snapshot);
      }
      throw error;
    }
    resetAppStateForEvidenceResume(sliceContext, stage);
    runtimeCheckpoint = prepareRuntimeCheckpointForEvidenceResume(
      record.snapshot,
      workflowPlan.executionOrder,
      stage,
    );
  } else {
    seedTimelineIfProvided(sliceContext);
    persistMemory(sliceContext);
  }

  emitStatus(sliceContext, {
    type: "plan-created",
    runId: input.runId,
    goal: getGoalText(input),
    steps: createPlanStepStatuses(policy.value.steps),
  });
  const runtime = createWorkflowRuntime({
    plan: workflowPlan,
    checkpoint: runtimeCheckpoint,
    signal: input.signal,
    context: sliceContext,
    executeTask: (task, runtimeContext) => {
      const { stepId, agent } = resolveTaskAgent(task);
      emitStatus(runtimeContext.context, {
        type: "task-started",
        runId: runtimeContext.context.input.runId,
        stepId,
        agent,
        detail: `started ${task.id}`,
      });

      return Promise.resolve(executeWorkflowTask(task, runtimeContext.context))
        .then((output) => {
          emitStatus(runtimeContext.context, {
            type: "task-completed",
            runId: runtimeContext.context.input.runId,
            stepId,
            agent,
            detail: `completed ${task.id}`,
          });
          return output;
        })
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          emitStatus(runtimeContext.context, {
            type: "task-failed",
            runId: runtimeContext.context.input.runId,
            stepId,
            agent,
            detail,
          });
          throw error;
        });
    },
    shouldStopAfterTask(task) {
      if (
        task.id === "preflight" &&
        isPreflightStopReason(sliceContext.state.stopReason)
      ) {
        return { stopReason: "blocked" };
      }
      if (
        task.id === "review" &&
        sliceContext.state.stopReason === "needs-user-input"
      ) {
        return { stopReason: "blocked" };
      }
      return false;
    },
  } as Parameters<typeof createWorkflowRuntime<ResumeSliceContext>>[0] & {
    signal?: AbortSignal;
  });

  return {
    policy,
    workflowPlan,
    runtime,
    sliceContext,
  };
}

export function saveCheckpoint(
  context: ResumeSliceContext,
  checkpoint: CheckpointSnapshot,
) {
  return context.checkpointStore.save({
    checkpointId: `${context.input.runId}-checkpoint`,
    runId: context.input.runId,
    threadId: RESUME_CHECKPOINT_THREAD_ID,
    planFingerprint: context.planFingerprint,
    snapshot: createResumeCheckpointSnapshot(context, checkpoint),
  });
}

export function writeManifest(
  context: ResumeSliceContext,
  workflowManifest: ReturnType<
    ResumeSliceRuntimeBundle["runtime"]["getManifest"]
  >,
) {
  const manifestRecord = context.workspace.registerArtifact({
    kind: "log",
    fileName: `${createArtifactBaseName(context.input.company)}.manifest.json`,
    generator: "rolepilot-engine",
    stage: "supporting",
  });
  const artifactManifest = context.workspace.createArtifactManifest();
  persistArtifact(
    manifestRecord,
    toJsonText({
      schemaVersion: "v1",
      runId: context.input.runId,
      workflowManifest,
      artifactManifest,
      originalSource: {
        originalResumePath: context.state.originalResumeArtifact?.absolutePath ?? null,
        provenancePath: context.state.originalResumeSourceArtifact?.absolutePath ?? null,
        sourceTextPath: context.state.sourceTextArtifact?.absolutePath ?? null,
      },
      delivery: { status: context.state.deliveryStatus, finalReviewPath: context.state.finalReviewPath },
      reviewLoop: {
        roundsUsed: context.state.reviewRoundsUsed,
        stopReason: context.state.stopReason,
        bestResumePath: context.state.bestResumeArtifact?.absolutePath ?? null,
        bestReviewPath: context.state.bestReviewArtifact?.absolutePath ?? null,
      },
      optimizationLoop: {
        actionsUsed: context.state.optimizationActionsUsed,
        maxActions:
          context.input.maxOptimizationActions ??
          context.input.reviewReplanBudget ??
          Math.max(0, (context.input.maxReviewRounds ?? 3) - 1),
        stopReason: context.state.optimizationStopReason,
        actionHistory: context.state.actionHistory,
        bestResumePath: context.state.bestResumeArtifact?.absolutePath ?? null,
        bestReviewPath: context.state.bestReviewArtifact?.absolutePath ?? null,
        bestOptimizationReviewPath:
          context.state.bestOptimizationReviewArtifact?.absolutePath ?? null,
      },
      preflight: {
        decision: context.state.preflightDecision,
        eligibilityNotes: context.state.preflightDecision?.eligibilityNotes ?? [],
        decisionPath:
          context.state.preflightDecisionArtifact?.absolutePath ?? null,
        questionsPath: context.state.questionsArtifact?.absolutePath ?? null,
        unsupportedPath:
          context.state.unsupportedArtifact?.absolutePath ?? null,
        pendingUserQuestions: [...context.state.pendingUserQuestions],
        safeWritingScope: [...context.state.safeWritingScope],
        stopReason:
          context.state.preflightDecision?.decision === "ASK_USER"
            ? "needs-user-input"
            : context.state.preflightDecision?.decision === "STOP_UNSUPPORTED"
              ? "unsupported-input"
              : null,
      },
      checkpoint: {
        resumedFromCheckpoint: context.state.resumedFromCheckpoint,
        supplementalEvidencePath:
          context.state.supplementalEvidenceArtifact?.absolutePath ?? null,
        preflightAttempts: context.state.preflightAttempts,
        userQuestionRoundsUsed: context.state.userQuestionRoundsUsed,
        pendingQuestionStage: context.state.pendingQuestionStage,
        questionRecords: context.state.questionRecords,
        answerInterpretations: context.state.answerInterpretations,
        evidenceVersion: context.state.evidenceVersion,
      },
      finalDelivery: {
        status: context.state.deliveryStatus ?? "unavailable",
        format: "workbench-delivery",
        deliveryIndexPath: context.state.workbenchDeliveryArtifact?.path ?? null,
        finalResumePath: context.state.finalResumeArtifact?.path ?? null,
        sourceBestResumePath: context.state.bestResumeArtifact?.path ?? null,
        interview: {
          path: context.state.interviewArtifact?.absolutePath ?? null,
          sourceResumePath: context.state.interviewSourceResumePath,
        },
        cheatsheet: {
          path: context.state.cheatsheetArtifact?.absolutePath ?? null,
          sourceResumePath: context.state.cheatsheetSourceResumePath,
        },
      },
    }),
  );
  emitStatus(context, {
    type: "artifact-created",
    runId: context.input.runId,
    artifact: manifestRecord,
  });
  return {
    manifestPath: manifestRecord.absolutePath,
    artifactManifest: context.workspace.createArtifactManifest(),
  };
}
