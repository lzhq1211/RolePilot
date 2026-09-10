import YAML from "yaml";

import {
  createPreflightValidationOutcome,
  createReviewValidationOutcome,
  resolveFailurePolicyMode,
  validatePreflightDecision,
  validateOptimizationDecision,
  validateReviewShape,
  validateNewReviewShape,
  normalizeReviewReportV2,
} from "platform-contracts";

import { isPlainObject, parseJsonObject } from "./shared.js";
import { parseQuestionCandidate } from "./question-policy.js";
import { materializeOriginalResume, originalFromImportedText } from "./resume-document.js";
import type {
  OptimizationDecision,
  PreflightDecision,
} from "./types.js";

export function stripMarkdownFences(text: string): string {
  return text
    .replace(/^```(?:ya?ml|json)?\s*\n?/gm, "")
    .replace(/\n?```\s*$/gm, "")
    .trim();
}

/**
 * Stable error type for YAML.parse syntax failures. Policy layers use it to
 * distinguish a malformed model response from contract/shape validation errors;
 * the message text is unchanged.
 */
export class YamlSyntaxError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "YamlSyntaxError";
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isYamlSyntaxError(error: unknown): error is YamlSyntaxError {
  return error instanceof YamlSyntaxError;
}

export function cleanAndValidateYaml(text: string, label: string): string {
  const cleaned = stripMarkdownFences(text);
  try {
    YAML.parse(cleaned);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new YamlSyntaxError(`${label} returned invalid YAML: ${reason}`, {
      cause: error,
    });
  }
  return cleaned;
}

export function parseMineOutput(
  text: string,
  options: { documentId: string; importedResumeText: string; allowLegacy: boolean },
) {
  const cleaned = cleanAndValidateYaml(text, "Miner output");
  const parsed: unknown = YAML.parse(cleaned);  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Miner output must be a structured envelope.");
  }
  const payload = parsed as Record<string, unknown>;
  if ("originalResume" in payload || "schemaVersion" in payload) {
    if (payload.schemaVersion !== 1 || !payload.originalResume
      || Object.keys(payload).some((key) => !["schemaVersion", "originalResume", "timeline"].includes(key))) {
      throw new TypeError("Miner envelope requires schemaVersion 1, originalResume and timeline only.");
    }
    const timeline = payload.timeline;
    if (!timeline || typeof timeline !== "object" || Array.isArray(timeline)) {
      throw new TypeError("Miner envelope timeline must be an object.");
    }
    return {
      originalResume: materializeOriginalResume(payload.originalResume, options.documentId),
      timelineText: YAML.stringify(timeline),
      legacy: false,
    };
  }
  if (!options.allowLegacy || (!Array.isArray(payload.timeline) && !payload.content)) {
    throw new TypeError("Miner output is missing originalResume; timeline-only output is supported only by legacy stub/replay.");
  }
  return {
    originalResume: originalFromImportedText(options.importedResumeText, options.documentId),
    timelineText: cleaned,
    legacy: true,
  };
}

export function parseReviewReport(reviewText: string) {
  const cleaned = stripMarkdownFences(reviewText);
  return parseJsonObject(cleaned, "Reviewer output");
}

/**
 * Deterministic normalization for one known Review v2 representation error:
 * the model emits topIssues[].section as null or blank for resume-wide issues.
 * Only schemaVersion 2 reports are touched; null/blank strings become
 * "overall". Missing fields and wrong types stay untouched so the strict
 * contract validation keeps rejecting them. Nothing else is modified.
 */
export function normalizeReviewSectionValues(
  report: Record<string, unknown>,
): { report: Record<string, unknown>; changes: Array<{ path: string; from: unknown; to: string }> } {
  if (report.schemaVersion !== 2 || !Array.isArray(report.topIssues)) {
    return { report, changes: [] };
  }
  const changes: Array<{ path: string; from: unknown; to: string }> = [];
  report.topIssues.forEach((issue, index) => {
    if (!isPlainObject(issue)) return;
    const section = issue.section;
    if (section === null || (typeof section === "string" && section.trim().length === 0)) {
      issue.section = "overall";
      changes.push({ path: `topIssues[${index}].section`, from: section, to: "overall" });
    }
  });
  return { report, changes };
}

export function parsePreflightDecision(preflightText: string) {
  const cleaned = stripMarkdownFences(preflightText);
  return parseJsonObject(cleaned, "Preflight reviewer output");
}

/**
 * Deterministic location fix for one known Preflight shape error: the model
 * nests questionCandidates inside writingBoundary instead of the top level.
 * Relocation applies only when schemaVersion is 1, the boundary is an object,
 * the top-level property is absent, and the nested value is an array. Content,
 * order, and every other field stay untouched; anything else keeps failing the
 * strict contract validation.
 */
export function normalizePreflightProposalLocation(
  proposal: Record<string, unknown>,
): { proposal: Record<string, unknown>; relocated: boolean } {
  const boundary = proposal.writingBoundary;
  if (
    proposal.schemaVersion === 1
    && isPlainObject(boundary)
    && !("questionCandidates" in proposal)
    && Array.isArray(boundary.questionCandidates)
  ) {
    const { questionCandidates, ...boundaryWithoutCandidates } = boundary;
    return {
      proposal: { ...proposal, writingBoundary: boundaryWithoutCandidates, questionCandidates },
      relocated: true,
    };
  }
  return { proposal, relocated: false };
}

export function parseOptimizationDecision(decisionText: string) {
  const cleaned = stripMarkdownFences(decisionText);
  return parseJsonObject(cleaned, "Optimization decision output");
}

/**
 * Deterministic normalization for one known OptimizationDecision shape error:
 * the model emits targetNode as a bare node-ID string instead of the
 * {"nodeId": ...} object. Wrapping applies only when the string exactly matches
 * a node ID of the current candidate document; anything else stays untouched
 * so the strict contract validation keeps rejecting it. No other field changes.
 */
export function normalizeOptimizationTargetNode(
  decision: Record<string, unknown>,
  nodeIds: { has(key: string): boolean } | null,
): { decision: Record<string, unknown>; change: { from: string; to: { nodeId: string } } | null } {
  const targetNode = decision.targetNode;
  if (nodeIds && typeof targetNode === "string" && nodeIds.has(targetNode)) {
    return {
      decision: { ...decision, targetNode: { nodeId: targetNode } },
      change: { from: targetNode, to: { nodeId: targetNode } },
    };
  }
  return { decision, change: null };
}

export function validatePreflightDecisionPayload(
  decision: Record<string, unknown>,
  env?: NodeJS.ProcessEnv,
  options: { allowLegacy?: boolean } = {},
): PreflightDecision {
  if (decision.schemaVersion === 1) {
    if (Object.keys(decision).some((key) => !["schemaVersion", "writingBoundary", "questionCandidates"].includes(key))
      || !decision.writingBoundary || typeof decision.writingBoundary !== "object" || Array.isArray(decision.writingBoundary)
      || !Array.isArray(decision.questionCandidates)) throw new Error("Invalid Preflight proposal envelope.");
    const boundary = decision.writingBoundary as Record<string, unknown>;
    if (Object.keys(boundary).some((key) => !["confidence", "missingEvidence", "eligibilityNotes", "unsupportedTargets", "safeWritingScope"].includes(key))) throw new Error("Preflight writingBoundary contains unknown fields.");
    decision = { ...boundary, decision: "PROCEED", blockingQuestions: [], questionCandidates: decision.questionCandidates.map(parseQuestionCandidate) };
  } else if (!options.allowLegacy) {
    throw new Error("Preflight requires a schemaVersion 1 proposal envelope; legacy decisions are offline-only.");
  }
  const validation = validatePreflightDecision(decision);
  const outcome = createPreflightValidationOutcome(
    validation,
    resolveFailurePolicyMode(env),
  );
  if (!validation.valid) {
    throw new Error(
      outcome.message ?? "Preflight reviewer output failed validation.",
    );
  }
  return {
    ...decision,
    eligibilityNotes: Array.isArray(decision.eligibilityNotes)
      ? decision.eligibilityNotes
      : [],
  } as PreflightDecision;
}

export function validateOptimizationDecisionPayload(
  decision: Record<string, unknown>,
  options: { structuredContent?: boolean; allowLegacy?: boolean } = {},
): OptimizationDecision {
  const validation = validateOptimizationDecision(decision);
  if (!validation.valid) {
    throw new Error(
      `Optimization decision output failed v1 validation: ${validation.errors?.join(", ") ?? "unknown validation error"}`,
    );
  }
  if (options.structuredContent && ["REWRITE_SECTION", "KEYWORD_OPTIMIZE", "DROP_UNSUPPORTED_CLAIM", "REORDER"].includes(String(decision.action))) {
    for (const key of ["issueRef", "issueKey", "targetNode", "evidenceVersion"]) if (!(key in decision)) throw new Error(`Optimization v3 mutation requires ${key}.`);
  }
  if (decision.restrictionRefs !== undefined && (!Array.isArray(decision.restrictionRefs) || decision.restrictionRefs.some((item) => typeof item !== "string" || !item.trim()))) throw new Error("restrictionRefs must be an array of restriction strings.");
  if (decision.action === "ASK_USER") {
    if (decision.questionProposal !== undefined) decision.questionProposal = parseQuestionCandidate(decision.questionProposal);
    else if (!options.allowLegacy) throw new Error("Optimization ASK_USER requires questionProposal.");
  } else if (decision.questionProposal !== undefined) throw new Error("Only ASK_USER may carry questionProposal.");
  return decision as OptimizationDecision;
}

export function validateReviewReport(
  report: Record<string, unknown>,
  env?: NodeJS.ProcessEnv,
  options: { allowLegacy?: boolean; strict?: boolean } = {},
) {
  const normalized = normalizeReviewReportV2(report);
  if (normalized && typeof normalized === "object" && normalized !== report) {
    Object.assign(report, normalized);
  }
  const validation = options.allowLegacy
    ? validateReviewShape(report)
    : validateNewReviewShape(report);
  const outcome = createReviewValidationOutcome(
    validation,
    resolveFailurePolicyMode(env),
  );
  const strict = options.strict ?? !options.allowLegacy;
  if (!validation.valid && (strict || outcome.shouldFail)) {
    const errorText =
      validation.errors?.join(", ") ?? "unknown validation error";
    throw new Error(
      strict && !outcome.shouldFail
        ? `审核输出不符合 Review schemaVersion 2 合同，运行时严格模式已拒绝继续: ${errorText}`
        : outcome.message ?? errorText,
    );
  }
  return validation;
}
