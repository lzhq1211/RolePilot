import {
  type RoutedOptimizationDecision,
} from "platform-policy";
import { createTelemetryEvent } from "platform-runtime";

import { createArtifactBaseName, toJsonText } from "./shared.js";
import { persistMemory, questionAllowance, registerArtifact } from "./slice-artifacts.js";
import {
  buildResumeWritePacket,
  publishQuestionRecords,
  reviseResumeFromReview,
} from "./slice-steps.js";
import type {
  OptimizationDecision,
} from "./types.js";
import type { ResumeSliceContext } from "./vertical-slice-types.js";
import { selectQuestionCandidates } from "./question-policy.js";

const MUTATING_ACTIONS = new Set([
  "REWRITE_SECTION",
  "KEYWORD_OPTIMIZE",
  "DROP_UNSUPPORTED_CLAIM",
  "REORDER",
]);

export type OptimizationExecutionInput = {
  decision: OptimizationDecision;
  routedDecision: RoutedOptimizationDecision;
  reviewReport: Record<string, unknown>;
  revisionRound: number;
  decisionPath: string;
  sourceReviewPath: string;
  sourceResumePath: string;
};

export type OptimizationExecutionResult =
  | { outcome: "stopped"; candidateResume: null }
  | { outcome: "needs-user-input"; candidateResume: null }
  | { outcome: "no-op"; candidateResume: null }
  | {
      outcome: "candidate-created";
      candidateResume: Awaited<ReturnType<typeof reviseResumeFromReview>>;
    };

export function recordOptimizationTelemetry(
  context: ResumeSliceContext,
  lifecycle: "selected" | "rejected" | "executed" | "stopped",
  detail: string,
) {
  const event = createTelemetryEvent({
    runId: context.input.runId,
    sequence: context.state.telemetrySequence,
    elapsedMs: Date.now() - context.startedAt,
    agent: "review-action-router",
    backend: "deterministic",
    action: `optimization-action-${lifecycle}`,
    detail,
  });
  context.state.telemetrySequence += 1;
  context.workspace.recordTelemetry(event);
}

function buildOptimizationQuestion(
  decision: OptimizationDecision,
  routedDecision: RoutedOptimizationDecision,
) {
  if (decision.action === "ASK_USER") {
    return routedDecision.normalizedTarget ?? decision.reason;
  }

  return `请补充“${routedDecision.normalizedTarget ?? decision.target ?? "当前目标经历"}”涉及的可核实事实：${decision.reason}`;
}

function persistOptimizationQuestions(
  context: ResumeSliceContext,
  decision: OptimizationDecision,
  routedDecision: RoutedOptimizationDecision,
) {
  const question = buildOptimizationQuestion(decision, routedDecision);
  const baseName = createArtifactBaseName(context.input.company);
  const proposalFilter = decision.questionProposal ? selectQuestionCandidates(context, [decision.questionProposal]) : null;
  if (proposalFilter?.filtered.length) {
    // 被过滤的 Review 候选保留审计，过滤原因进入现有产物链。
    registerArtifact(
      context,
      { kind: "log", fileName: `${baseName}.question-filter.proposal-${context.state.actionHistory.length + 1}.json`, generator: "rolepilot-engine", stage: "supporting" },
      toJsonText({ stage: "review", filtered: proposalFilter.filtered }),
    );
  }
  const questions = publishQuestionRecords(context, {
    stage: "review",
    questions: proposalFilter ? proposalFilter.allowed : [question],
    target: routedDecision.normalizedTarget ?? decision.target,
    expectedImprovement: decision.expectedImprovement,
  });
  if (questions.length === 0) return [];
  context.state.questionsArtifact = registerArtifact(
    context,
    {
      kind: "questions",
      fileName: `${baseName}.optimization.questions.round-${context.state.userQuestionRoundsUsed + 1}.md`,
      generator: "review-action-router",
      stage: "supporting",
    },
    [
      "# 待确认的问题",
      "",
      ...questions.map((item) => `- ${item}`),
      "",
    ].join("\n"),
  );
  return questions;
}

export async function executeOptimizationAction(
  context: ResumeSliceContext,
  input: OptimizationExecutionInput,
): Promise<OptimizationExecutionResult> {
  const { decision, routedDecision } = input;

  if (!routedDecision.allowed) {
    context.state.optimizationStopReason =
      routedDecision.reasonCodes[0] ?? "router-rejected";
    persistMemory(context);
    return { outcome: "stopped", candidateResume: null };
  }

  if (routedDecision.action === "PASS") {
    context.state.optimizationStopReason = "pass";
    persistMemory(context);
    return { outcome: "stopped", candidateResume: null };
  }

  if (routedDecision.action === "STOP") {
    context.state.optimizationStopReason = "stop-selected";
    persistMemory(context);
    return { outcome: "stopped", candidateResume: null };
  }

  if (routedDecision.action === "ASK_USER") {
    if (context.state.stopReason === "needs-user-input") {
      return { outcome: "needs-user-input", candidateResume: null };
    }
    if (!questionAllowance(context).canAskUser) {
      context.state.optimizationStopReason = "question-budget-exhausted-source-facts";
      recordOptimizationTelemetry(context, "stopped", "question allowance exhausted; stop fact-dependent enhancement and select a safe diagnosed candidate or the frozen source");
      persistMemory(context);
      return { outcome: "stopped", candidateResume: null };
    }
    const questions = persistOptimizationQuestions(context, decision, routedDecision);
    if (questions.length === 0) {
      context.state.optimizationStopReason = "question-already-handled-source-facts";
      persistMemory(context);
      return { outcome: "stopped", candidateResume: null };
    }
    context.state.pendingReviewAction = {
      decision: structuredClone(decision),
      decisionPath: input.decisionPath,
      sourceReviewPath: input.sourceReviewPath,
      sourceResumePath: input.sourceResumePath,
      reviewRound: input.revisionRound - 1,
    };
    context.state.userQuestionRoundsUsed += 1;
    context.state.stopReason = "needs-user-input";
    context.state.optimizationStopReason = "needs-user-input";
    persistMemory(context);
    return { outcome: "needs-user-input", candidateResume: null };
  }

  if (!MUTATING_ACTIONS.has(routedDecision.action)) {
    throw new Error(
      `Optimization executor rejected non-allowlisted action: ${routedDecision.action}`,
    );
  }

  const packet = buildResumeWritePacket(context, {
    revisionRound: input.revisionRound,
    reviewReport: input.reviewReport,
    optimizationDecision: decision,
  });
  const candidateResume = await reviseResumeFromReview(
    context,
    packet,
    input.reviewReport,
  );
  if (context.state.lastWriteNoOp) {
    recordOptimizationTelemetry(context, "executed", "no-op: operation proposal made no content changes; no candidate or extra review created");
    return { outcome: "no-op", candidateResume: null };
  }
  context.state.optimizationStopReason = null;
  persistMemory(context);
  return { outcome: "candidate-created", candidateResume };
}
