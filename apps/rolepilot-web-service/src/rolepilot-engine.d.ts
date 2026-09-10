declare module "rolepilot-engine" {
  export class AnswerInterpretationError extends Error {
    readonly stage: "preflight" | "review";
    readonly questions: string[];
    constructor(stage: "preflight" | "review", questions: string[], cause: unknown);
  }
  export type ResumeAgentBindings = Record<string, { provider: string; mode?: string; model?: string }>;
  export type ResumeAppStatusEvent = { type: string; runId: string; stepId?: string; [key: string]: unknown };
  export type ResumeVerticalSliceInput = {
    rootDir: string; runId: string; createdAt?: string; company: Record<string, unknown>;
    agentBindings: ResumeAgentBindings; importedResumeText?: string; timelineText?: string;
    jdText?: string; includeInterview?: boolean; maxReviewRounds?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal;
    onStatus?: (event: ResumeAppStatusEvent) => void;
    resumeFromCheckpoint?: boolean; userEvidenceText?: string;
  };
  export type ResumeVerticalSliceResult = {
    deliveryStatus?: "OPTIMIZED" | "SOURCE_ONLY" | null;
    finalReviewPath?: string | null;
    workbenchDeliveryPath?: string | null;
    stopReason: string | null;
    pendingUserQuestions: string[];
    pendingQuestionStage?: "preflight" | "review" | null;
    finalResumePath?: string;
    originalResumePath?: string | null;
    originalResumeSourcePath?: string | null;
    sourceTextPath?: string | null;
    artifactManifest: { artifacts: Array<{ kind: string; stage: string; fileName: string; path: string; absolutePath: string }> };
  };
  export function runResumeVerticalSlice(input: ResumeVerticalSliceInput): Promise<ResumeVerticalSliceResult>;
  export function createResumeAgentBindings(config: Record<string, { tool?: string; model?: string }>, overrides?: Record<string, Record<string, unknown>>): ResumeAgentBindings;
}
