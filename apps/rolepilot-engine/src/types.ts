import type {
  BackendExecutionMode,
  BackendProvider,
  ReplayResponseEntry,
} from "platform-adapters";
import type { ResumePlanStepId } from "platform-policy";
import type {
  OptimizationAction,
  RoutedOptimizationDecision,
} from "platform-policy";
import type { ArtifactRecord, CheckpointSnapshot } from "platform-runtime";

export type ResumeAgentName = "miner" | "writer" | "reviewer" | "interviewer";

export type ResumeAgentBinding = {
  provider: BackendProvider;
  mode?: BackendExecutionMode;
  model?: string;
  env?: NodeJS.ProcessEnv;
  temperature?: number;
  maxTokens?: number;
  extraArgs?: string[];
  replayEntries?: ReplayResponseEntry[];
};

export type ResumeAgentBindings = Record<ResumeAgentName, ResumeAgentBinding>;

export type ResumeTarget = {
  company?: string;
  title?: string;
  role?: string;
  jobTitle?: string;
  [key: string]: unknown;
};

export type PreflightDecisionKind =
  | "PROCEED"
  | "ASK_USER"
  | "STOP_UNSUPPORTED";

export type PreflightDecision = {
  decision: PreflightDecisionKind;
  confidence: number;
  missingEvidence: string[];
  blockingQuestions: string[];
  eligibilityNotes?: string[];
  unsupportedTargets: string[];
  safeWritingScope: string[];
  questionCandidates?: QuestionCandidate[];
};

export type QuestionCandidate = {
  gapId?: string;
  existingGapId?: string | null;
  intent?: "content_fact" | "target_role" | "qualification";
  target?: string | null;
  missingFact?: string;
  question: string;
  expectedImprovement: string;
  sourceAssessment?: "unanswered" | "partial" | "answered";
  priority?: string;
};

export type OptimizationDecision = {
  restrictionRefs?: string[];
  questionProposal?: QuestionCandidate;
  issueRef?: string;
  issueKey?: string;
  targetNode?: { nodeId: string } | { profileField: string } | null;
  evidenceVersion?: number;
  action: OptimizationAction;
  target: string | null;
  reason: string;
  evidenceRefs: string[];
  expectedImprovement: string;
  risk: "low" | "medium" | "high";
};

export type OptimizationActionHistoryEntry = {
  sequence: number;
  decision: OptimizationDecision;
  decisionPath: string;
  route: RoutedOptimizationDecision;
  status: "rejected" | "executed" | "stopped" | "no-op";
  candidateResumePath: string | null;
  sourceReviewPath: string;
  resultReviewPath: string | null;
  rejectedReason: string | null;
};

export type QuestionStage = "preflight" | "review";

export type QuestionStatus = "pending" | "answered" | "partial" | "unavailable" | "skipped" | "off_topic";

export type QuestionRecord = {
  intent?: QuestionCandidate["intent"];
  missingFact?: string;
  gapId: string;
  stage: QuestionStage;
  target: string | null;
  question: string;
  expectedImprovement: string;
  status: QuestionStatus;
  answer: string | null;
  publishedRound: number;
  evidenceVersion: number;
  acceptedFacts?: string[];
  corrections?: string[];
  sourceQuote?: string | null;
};

export type AnswerInterpretation = {
  schemaVersion: 1;
  answers: Array<{
    gapId: string;
    status: Exclude<QuestionStatus, "pending">;
    acceptedFacts: Array<{ fact: string; sourceQuote: string }>;
  }>;
  additionalFacts: Array<{ target: string; fact: string; sourceQuote: string }>;
  corrections: Array<{ target: string; field: string; previousValue: string; value: string; sourceQuote: string }>;
  resolvedRestrictions: Array<{ restriction: string; gapId: string | null; sourceQuote: string }>;
  resolvedMissingEvidence?: Array<{ missingEvidence: string; gapId: string | null; sourceQuote: string }>;
  scopeUpdates?: Array<{ previousScope: string; replacement: string; restriction: string }>;
};

/** Accepted user evidence kept in a writer/reviewer-friendly ledger shape. */
export type StructuredEvidenceFact = {
  target: string;
  fact: string;
  sourceQuote: string;
  gapId?: string | null;
  kind: "accepted" | "additional";
};

export type PendingReviewAction = {
  decision: OptimizationDecision;
  decisionPath: string;
  sourceReviewPath: string;
  sourceResumePath: string;
  reviewRound: number;
};

export type ResumeVerticalSliceInput = {
  rootDir: string;
  runId: string;
  goal?: string;
  createdAt?: string;
  company: ResumeTarget;
  agentBindings: ResumeAgentBindings;
  hasTimelineContext?: boolean;
  includeInterview?: boolean;
  reviewReplanBudget?: number;
  maxReviewRounds?: number;
  maxOptimizationActions?: number;
  importedResumeText?: string;
  timelineText?: string;
  jdText?: string;
  resumeFromCheckpoint?: boolean;
  userEvidenceText?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onStatus?: (event: ResumeAppStatusEvent) => void;
};

export type ResumeAppPlanStepStatus = {
  id: ResumePlanStepId;
  agent: ResumeAgentName;
  rationale: string;
};

export type ResumeAppStatusEvent =
  | {
      type: "plan-created";
      runId: string;
      goal: string;
      steps: ResumeAppPlanStepStatus[];
    }
  | {
      type: "task-started" | "task-completed" | "task-failed";
      runId: string;
      stepId: ResumePlanStepId;
      agent: ResumeAgentName;
      detail: string;
    }
  | {
      type: "task-progress";
      runId: string;
      stepId: ResumePlanStepId;
      agent: ResumeAgentName;
      detail: string;
      stage: string;
      requestId: string;
      elapsedMs: number;
    }
  | {
      type: "artifact-created";
      runId: string;
      artifact: ArtifactRecord;
    }
  | {
      type: "run-completed";
      runId: string;
      stopReason: string | null;
      reviewRoundsUsed: number;
      manifestPath: string;
    }
  | {
      type: "run-cancelled";
      runId: string;
      reason: string;
      reviewRoundsUsed: number;
      manifestPath: string;
    };

export type ResumeGoalInterfaceInput = ResumeVerticalSliceInput;

export type ResumeVerticalSliceResult = {
  deliveryStatus: "OPTIMIZED" | "SOURCE_ONLY" | null;
  finalReviewPath: string | null;
  workbenchDeliveryPath: string | null;
  runId: string;
  stopReason: string | null;
  finalResumePath: string | null;
  bestResumePath: string | null;
  bestReviewPath: string | null;
  interviewPath: string | null;
  cheatsheetPath: string | null;
  interviewSourceResumePath: string | null;
  cheatsheetSourceResumePath: string | null;
  timelinePath: string;
  originalResumePath: string | null;
  originalResumeSourcePath: string | null;
  sourceTextPath: string | null;
  jdAnalysisPath: string;
  preflightDecisionPath: string | null;
  supplementalEvidencePath: string | null;
  questionsPath: string | null;
  unsupportedPath: string | null;
  preflightDecision: PreflightDecision | null;
  pendingUserQuestions: string[];
  pendingQuestionStage: QuestionStage | null;
  optimizationActionsUsed: number;
  actionHistory: OptimizationActionHistoryEntry[];
  optimizationStopReason: string | null;
  manifestPath: string;
  logPath: string;
  telemetryPath: string;
  resumedFromCheckpoint: boolean;
  workflowManifest: CheckpointSnapshot["manifest"];
  artifactManifest: {
    schemaVersion: "v1";
    runId: string;
    createdAt: string;
    rootDir: string;
    layout: Record<string, string>;
    artifacts: ArtifactRecord[];
  };
  reviewRoundsUsed: number;
};

export type ResumeGoalInterfaceOutput = {
  result: ResumeVerticalSliceResult;
  plan: ResumeAppPlanStepStatus[];
};

export type ResumeGoalInterfaceWriter = {
  writeLine: (line: string) => void;
};

export const RESUME_APP_BOUNDARY = {
  packageName: "rolepilot-engine",
  workflow: "mine-jd-analysis-preflight-write-review-interview",
  executionModel: "local-first",
  replay: "deterministic",
} as const;
