declare module "platform-adapters" {
  export type BackendProvider =
    | "claude"
    | "opencode"
    | "codex"
    | "openai-chat"
    | "anthropic-api";
  export type BackendExecutionMode = "live" | "stub" | "replay";

  export type ReplayResponseEntry =
    | string
    | {
        text?: string;
        outputText?: string;
        file?: string;
        responseFile?: string;
        error?:
          | string
          | {
              message: string;
              code?: string;
              retryable?: boolean;
              metadata?: Record<string, unknown>;
            };
        raw?: unknown;
        metadata?: Record<string, unknown>;
      };

  export type NormalizedBackendRequest = {
    requestId: string;
    provider: BackendProvider;
    mode: BackendExecutionMode;
    input: string;
    metadata?: Record<string, unknown>;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    extraArgs?: string[];
    replay?: {
      entries?: ReplayResponseEntry[];
      filePath?: string;
      cwd?: string;
    };
  };

  export type NormalizedBackendResult = {
    requestId: string;
    provider: BackendProvider;
    mode: BackendExecutionMode;
    status: "succeeded" | "failed";
    outputText?: string;
    raw?: unknown;
    metadata?: Record<string, unknown>;
  };

  export type BackendAdapter = {
    provider: BackendProvider;
    execute(
      request: NormalizedBackendRequest,
    ): Promise<NormalizedBackendResult>;
  };

  export type BackendRegistry = {
    execute(
      request: NormalizedBackendRequest,
    ): Promise<NormalizedBackendResult>;
  };

  export function createConcreteAdapters(options?: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  }): readonly BackendAdapter[];

  export function createBackendRegistry(
    adapters: readonly BackendAdapter[],
  ): BackendRegistry;
}

declare module "platform-contracts" {
  export const REVIEW_SCHEMA_VERSION: 2;
  export const LEGACY_REVIEW_SCHEMA_VERSION: "v1";
  export const PREFLIGHT_SCHEMA_VERSION: "v1";
  export const OPTIMIZATION_DECISION_SCHEMA_VERSION: "v1";

  export const PREFLIGHT_DECISIONS: readonly [
    "PROCEED",
    "ASK_USER",
    "STOP_UNSUPPORTED",
  ];

  export const REVIEW_V2_PRIORITIES: readonly ["P0", "P1", "P2", "P3"];
  export const REVIEW_V2_CATEGORIES: readonly [
    "UNSUPPORTED_CLAIM",
    "POSITIONING",
    "JD_COVERAGE",
    "EVIDENCE_PRESENTATION",
    "CONTENT_PRIORITY",
    "WORDING",
  ];
  export const REVIEW_V2_RESOLUTIONS: readonly [
    "REWRITE_NOW",
    "NEEDS_CONFIRMATION",
    "CAPABILITY_GAP",
  ];
  export const REVIEW_V2_CATEGORY_ALIASES: Readonly<Record<string, string>>;

  export const REVIEW_STOP_REASONS: {
    PASS: "pass";
    EARLY_STOP: "early-stop";
    MAX_ROUNDS: "max-rounds";
  };

  export type ReviewPolicyState = {
    maxRounds: number;
    bestScore: number;
    bestSignal: unknown;
    bestResumePath: string | null;
    bestReviewReport: unknown;
    bestReviewPath: string | null;
    lastScore: number;
    lastSignal: unknown;
    lastReviewReport: unknown;
    lastReviewPath: string | null;
    noProgressStreak: number;
    stopReason: string | null;
  };

  export function createReviewPolicyState(input?: {
    initialResumePath?: string | null;
    maxRounds?: number;
  }): ReviewPolicyState;

  export function applyReviewPolicyRound(
    state: ReviewPolicyState,
    input: {
      round: number;
      resumePath: string;
      reviewPath: string;
      report: Record<string, unknown>;
      candidateFollowsExecutedAction?: boolean;
      targetedImprovement?: boolean;
    },
  ): {
    state: ReviewPolicyState;
    decision: {
      round: number;
      average: number;
      improved: boolean;
      shouldStop: boolean;
      shouldRevise: boolean;
      stopReason: string | null;
      bestScore: number;
      bestResumePath: string | null;
      bestReviewReport: unknown;
      bestReviewPath: string | null;
      lastReviewReport: unknown;
      lastReviewPath: string | null;
    };
  };

  export function resolveFailurePolicyMode(
    env?: NodeJS.ProcessEnv,
  ): "manual" | "local-ci" | "github-actions";

  export function createReviewValidationOutcome(
    validation: { valid: boolean; errors?: string[] },
    mode: "manual" | "local-ci" | "github-actions",
  ): { shouldFail: boolean; message: string | null };

  export function createPreflightValidationOutcome(
    validation: { valid: boolean; errors?: string[] },
    mode: "manual" | "local-ci" | "github-actions",
  ): { shouldFail: boolean; message: string | null };

  export function validatePreflightDecision(data: unknown): {
    valid: boolean;
    errors?: string[];
    data?: unknown;
  };

  export function validateOptimizationDecision(data: unknown): {
    valid: boolean;
    errors?: string[];
    data?: unknown;
  };

  export function validateReviewShape(data: unknown): {
    valid: boolean;
    errors?: string[];
    data?: unknown;
    legacy?: boolean;
  };

  export function validateLegacyReviewShape(data: unknown): {
    valid: boolean;
    errors?: string[];
    data?: unknown;
  };

  export function validateNewReviewShape(data: unknown): {
    valid: boolean;
    errors?: string[];
    data?: unknown;
  };

  export function isReviewReportV2(data: unknown): boolean;

  export function normalizeReviewReportV2(data: unknown): unknown;
}

declare module "platform-policy" {
  export function isForbiddenQualificationQuestion(
    value: string | null | undefined,
  ): boolean;
  export function isRoleInfoQuestion(
    value: string | null | undefined,
  ): boolean;
  export type ResumePlanStepId =
    | "mine"
    | "jd-analysis"
    | "preflight"
    | "write"
    | "review"
    | "interview";
  export type ResumeGoalPlanInput = {
    goal: string;
    hasTimelineContext?: boolean;
    includeInterview?: boolean;
    requestedReviewRounds?: number | "unbounded" | null;
  };

  export type OptimizationAction =
    | "PASS"
    | "ASK_USER"
    | "REWRITE_SECTION"
    | "KEYWORD_OPTIMIZE"
    | "DROP_UNSUPPORTED_CLAIM"
    | "REORDER"
    | "STOP";

  export type OptimizationRouteReasonCode =
    | "INVALID_ISSUE_BINDING"
    | "FORBIDDEN_QUALIFICATION_QUESTION"
    | "ACTION_NOT_ALLOWLISTED"
    | "PASS_CONFLICTS_WITH_REVIEW"
    | "PASS_SELECTED"
    | "STOP_SELECTED"
    | "ASK_USER_SELECTED"
    | "BUDGET_EXHAUSTED"
    | "REPEATED_ACTION"
    | "EVIDENCE_REQUIRED"
    | "UNRESOLVED_EVIDENCE_GAP"
    | "QUESTION_BUDGET_EXHAUSTED"
    | "UNSUPPORTED_TARGET_REINFORCEMENT"
    | "PREFLIGHT_NOT_PROCEED"
    | "HIGH_RISK_REQUIRES_USER_INPUT";

  export type RoutedOptimizationDecision = {
    allowed: boolean;
    action: string;
    normalizedTarget: string | null;
    reasonCodes: OptimizationRouteReasonCode[];
    shouldStop: boolean;
  };

  export function routeOptimizationDecision(input: {
    strengthensRestrictedClaim?: boolean;
    questionProposalAllowed?: boolean;
    reviewReport: Record<string, unknown>;
    decision: {
      issueRef?: string;
      issueKey?: string;
      targetNode?: { nodeId: string } | { profileField: string } | null;
      evidenceVersion?: number;
      action: string;
      target: string | null;
      reason: string;
      evidenceRefs: string[];
      expectedImprovement: string;
      risk: "low" | "medium" | "high";
    };
    actionHistory: Array<{ action: string; target: string | null; issueKey?: string; targetNode?: { nodeId: string } | { profileField: string } | null; evidenceVersion?: number }>;
    preflightDecision: {
      decision: "PROCEED" | "ASK_USER" | "STOP_UNSUPPORTED";
      missingEvidence: string[];
      unsupportedTargets: string[];
    };
    remainingBudget: number;
    canAskUser?: boolean;
    issueBindingValid?: boolean;
    currentArtifactPaths: {
      resumePath: string;
      reviewPath: string;
    };
  }): RoutedOptimizationDecision;

  export function createResumeGoalPlan(input: ResumeGoalPlanInput):
    | {
        ok: true;
        value: {
          goalFamily: "resume-workflow";
          goal: string;
          steps: { id: ResumePlanStepId; rationale: string }[];
          maxSteps: number;
          reviewMode: "single-pass";
        };
        reasons: Array<{ code: string; message: string }>;
      }
    | {
        ok: false;
        value: null;
        reasons: Array<{ code: string; message: string }>;
      };

  export function superviseStep(input: {
    currentStep: ResumePlanStepId;
    status: "succeeded" | "failed";
    reviewPassed?: boolean;
    reviewReplansUsed?: number;
    reviewReplanBudget?: number;
  }): {
    decision: "continue" | "replan" | "escalate" | "complete";
    reasons: Array<{ code: string; message: string }>;
    nextPlan: Array<{ id: ResumePlanStepId; rationale: string }> | null;
  };
}

declare module "platform-runtime" {
  export type ArtifactRecord = {
    artifactId: string;
    runId: string;
    kind: string;
    stage: string;
    generator: string;
    fileName: string;
    path: string;
    absolutePath: string;
  };

  export type CheckpointSnapshot = {
    schemaVersion: "v1";
    graph: unknown;
    events: Array<{
      sequence: number;
      type: string;
      taskId?: string;
      stopReason?: string;
    }>;
    stopReason: string | null;
    nextSequence: number;
    manifest: {
      schemaVersion: "v1";
      taskOrder: string[];
      completedTaskIds: string[];
      failedTaskIds: string[];
      stopReason: string | null;
      eventCount: number;
    };
  };

  export type WorkflowTask = {
    id: string;
    dependencies: string[];
    payload?: unknown;
  };

  export function createFileWorkspace(options: {
    rootDir: string;
    runId: string;
    createdAt?: string;
  }): {
    telemetry: {
      logPath: string;
      streamPath: string;
    };
    registerArtifact(input: {
      kind: string;
      fileName: string;
      generator: string;
      stage?: string;
    }): ArtifactRecord;
    recordTelemetry(event: unknown): unknown;
    createArtifactManifest(): {
      schemaVersion: "v1";
      runId: string;
      createdAt: string;
      rootDir: string;
      layout: Record<string, string>;
      artifacts: ArtifactRecord[];
    };
  };

  export function createTelemetryEvent(input: {
    runId: string;
    sequence: number;
    elapsedMs: number;
    agent: string;
    backend?: string;
    action: string;
    detail: string;
  }): unknown;

  export function createWorkflowPlan(
    tasks: Array<{ id: string; dependencies?: string[]; payload?: unknown }>,
  ): {
    tasks: WorkflowTask[];
    tasksById: Record<string, WorkflowTask>;
    taskIds: string[];
    executionOrder: string[];
  };

  export function createWorkflowRuntime<TContext>(input: {
    plan: ReturnType<typeof createWorkflowPlan>;
    context: TContext;
    checkpoint?: CheckpointSnapshot;
    executeTask: (
      task: WorkflowTask,
      runtimeContext: { graph: unknown; events: unknown[]; context: TContext },
    ) => Promise<unknown> | unknown;
    shouldStopAfterTask?: (
      task: WorkflowTask,
      graph: unknown,
    ) =>
      | boolean
      | {
          stopReason: "completed" | "failed" | "cancelled" | "blocked";
        };
    signal?: AbortSignal;
  }): {
    run(): Promise<{
      graph: unknown;
      events: unknown[];
      stopReason: string | null;
      manifest: CheckpointSnapshot["manifest"];
      checkpoint: CheckpointSnapshot;
    }>;
    getManifest(): CheckpointSnapshot["manifest"];
  };
}

declare module "platform-state" {
  export function createCheckpointStore(options?: { rootDir: string }): {
    save<TSnapshot extends { schemaVersion: string }>(input: {
      checkpointId: string;
      runId: string;
      threadId: string;
      planFingerprint: string;
      snapshot: TSnapshot;
    }): {
      schemaVersion: "v1";
      checkpointId: string;
      runId: string;
      threadId: string;
      planFingerprint: string;
      createdAt: string;
      snapshot: TSnapshot;
    };
    resume<TSnapshot extends { schemaVersion: string }>(input: {
      runId: string;
      threadId: string;
      planFingerprint: string;
      expectedCheckpointId?: string;
    }): {
      schemaVersion: "v1";
      checkpointId: string;
      runId: string;
      threadId: string;
      planFingerprint: string;
      createdAt: string;
      snapshot: TSnapshot;
    };
  };

  export function createDurableMemoryStore(options?: { rootDir: string }): {
    put<TValue>(
      namespace: string,
      value: TValue,
    ): {
      schemaVersion: "v1";
      namespace: string;
      updatedAt: string;
      value: TValue;
    };
  };
}
