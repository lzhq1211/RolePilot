import fs from "node:fs";
import { applySourceCorrections, indexResumeNodes } from "./resume-document-operations.js";
import { parseResumeContentV3 } from "web-contracts/resume-document";
import type { AnswerInterpretation, QuestionCandidate } from "./types.js";
import type { ResumeSliceContext } from "./vertical-slice-types.js";
import { executeAgent } from "./slice-agents.js";
import { registerArtifact } from "./slice-artifacts.js";
import { createArtifactBaseName, parseJsonObject, stripMarkdownFences, toJsonText } from "./shared.js";
import { wrapQuestionScreeningPrompt } from "./slice-step-prompts.js";

export class AnswerInterpretationError extends Error {
  constructor(public readonly stage: "preflight" | "review", public readonly questions: string[], cause: unknown) {
    super("补充内容未能解析，请重新提交或跳过。", { cause });
    this.name = "AnswerInterpretationError";
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value.trim();
}

export function parseQuestionCandidate(value: unknown): QuestionCandidate {
  const item = object(value, "Question candidate");
  const fields = ["existingGapId", "intent", "target", "missingFact", "question", "expectedImprovement", "sourceAssessment", "priority"];
  if (Object.keys(item).some((key) => !fields.includes(key))) throw new Error("Question candidate contains unknown fields; gap IDs are assigned by code.");
  if (item.existingGapId !== null) text(item.existingGapId, "existingGapId");
  if (!["content_fact", "target_role", "qualification"].includes(String(item.intent))) throw new Error("Question intent is invalid.");
  // Resumed-answer interpretation uses `unavailable` for a question that was
  // not answered. Keep that status explicit in its own contract, but normalize
  // the equivalent model output at this boundary before validating candidates.
  if (item.sourceAssessment === "unavailable") item.sourceAssessment = "unanswered";
  if (!["unanswered", "partial", "answered"].includes(String(item.sourceAssessment))) throw new Error("Question sourceAssessment is invalid.");
  if (!["P0", "P1", "P2", "P3"].includes(String(item.priority))) throw new Error("Question priority is invalid.");
  for (const field of ["target", "missingFact", "question", "expectedImprovement"]) text(item[field], field);
  return item as QuestionCandidate;
}

export const MAX_QUESTIONS_PER_ROUND = 2;

const normalizedGapText = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");

export function selectQuestionCandidates(context: ResumeSliceContext, candidates: QuestionCandidate[], limit = MAX_QUESTIONS_PER_ROUND) {
  const allowed: QuestionCandidate[] = [];
  const filtered: Array<{ candidate: QuestionCandidate; reason: string }> = [];
  const records = context.state.questionRecords;
  const seen = new Set<string>();
  const priority = (candidate: QuestionCandidate) => ["P0", "P1", "P2", "P3"].indexOf(candidate.priority ?? "P3");
  for (const candidate of [...candidates].sort((a, b) => priority(a) - priority(b))) {
    const existing = candidate.existingGapId ? records.find((record) => record.gapId === candidate.existingGapId) : null;
    if (candidate.existingGapId && !existing) throw new Error("Question existingGapId does not exist in the supplied ledger.");
    const key = normalizedGapText(`${candidate.target ?? ""}:${candidate.missingFact ?? candidate.question}`);
    if (candidate.missingFact && candidate.intent !== "qualification") {
      const original = context.state.originalResumeArtifact ? parseResumeContentV3(JSON.parse(fs.readFileSync(context.state.originalResumeArtifact.absolutePath, "utf8"))) : null;
      const knownRole = Object.values(context.input.company).filter((value) => typeof value === "string");
      const target = candidate.target ?? "";
      const sourceText = context.state.sourceTextArtifact ? fs.readFileSync(context.state.sourceTextArtifact.absolutePath, "utf8") : context.input.importedResumeText ?? context.input.timelineText ?? "";
      const current = context.state.currentResumeArtifact;
      const currentDocument = current && context.state.candidateVersions[current.absolutePath] !== undefined
        ? parseResumeContentV3(JSON.parse(fs.readFileSync(current.absolutePath, "utf8"))) : null;
      const supplementalFacts = context.state.answerInterpretations.flatMap((entry) => [
        ...entry.answers.flatMap((answer) => answer.acceptedFacts), ...entry.additionalFacts,
      ]);
      const supplementalTarget = supplementalFacts.some((fact) => fact.fact.includes(target) || fact.sourceQuote.includes(target));
      if (!(original && (target === "profile" || indexResumeNodes(original).has(target)))
        && !(currentDocument && indexResumeNodes(currentDocument).has(target))
        && !knownRole.includes(target) && !sourceText.includes(target) && !supplementalTarget) {
        seen.add(key);
        filtered.push({ candidate, reason: "target-unresolved" });
        continue;
      }
    }
    const reason = candidate.intent === "qualification" ? "qualification"
      : candidate.sourceAssessment === "answered" ? "already-answered"
        : existing || records.some((record) => normalizedGapText(record.question) === normalizedGapText(candidate.question)
          || (record.target === candidate.target && Boolean(candidate.missingFact) && normalizedGapText(record.missingFact ?? "") === normalizedGapText(candidate.missingFact ?? ""))) ? "gap-already-handled"
          : seen.has(key) ? "duplicate" : null;
    seen.add(key);
    if (reason) filtered.push({ candidate, reason });
    else if (allowed.length >= limit) filtered.push({ candidate, reason: "question-count-limit" });
    else allowed.push(candidate);
  }
  return { allowed, filtered };
}

export async function screenQuestionCandidates(context: ResumeSliceContext, candidates: QuestionCandidate[], stage: "preflight" | "review", sourceMaterials: unknown) {
  const initial = selectQuestionCandidates(context, candidates, candidates.length);
  if (!initial.allowed.length || (context.agentBindings.reviewer.mode ?? "live") !== "live") {
    const selected = selectQuestionCandidates(context, initial.allowed);
    return { allowed: selected.allowed, filtered: [...initial.filtered, ...selected.filtered] };
  }
  const sequence = stage === "preflight" ? context.state.preflightAttempts + 1 : context.state.actionHistory.length + 1;
  const response = await executeAgent(context, "reviewer", stage, `question-screening-${stage}-${sequence}`,
    wrapQuestionScreeningPrompt(toJsonText({ candidates: initial.allowed, questionRecords: context.state.questionRecords, sourceMaterials })),
    "screen question meaning, qualification intent and already supplied facts before publication");
  const payload = parseJsonObject(stripMarkdownFences(response), "Question screening");
  if (!Array.isArray(payload.classifications) || payload.classifications.length !== initial.allowed.length) throw new Error("Question screening must classify every candidate.");
  const seen = new Set<number>();
  const classified = new Map<number, QuestionCandidate>();
  const filtered = [...initial.filtered];
  for (const raw of payload.classifications) {
    const item = object(raw, "Question classification");
    const index = item.candidateIndex as number;
    if (!Number.isInteger(index) || index < 0 || index >= initial.allowed.length || seen.has(index)) throw new Error("Question screening index is unknown or duplicated.");
    seen.add(index);
    const candidate = parseQuestionCandidate({ ...initial.allowed[index], intent: item.intent, sourceAssessment: item.sourceAssessment, existingGapId: item.existingGapId });
    if (candidate.existingGapId && !context.state.questionRecords.some((record) => record.gapId === candidate.existingGapId)) throw new Error("Question screening references an unknown gap.");
    if (item.duplicateOf !== null) {
      if (!Number.isInteger(item.duplicateOf) || Number(item.duplicateOf) < 0 || Number(item.duplicateOf) >= index) throw new Error("Question duplicateOf must reference an earlier candidate.");
      filtered.push({ candidate, reason: "semantic-duplicate" });
    } else classified.set(index, candidate);
  }
  const selected = selectQuestionCandidates(context, [...classified.entries()].sort(([a], [b]) => a - b).map(([, candidate]) => candidate));
  const result = { allowed: selected.allowed, filtered: [...filtered, ...selected.filtered] };
  registerArtifact(context, { kind: "log", fileName: `${createArtifactBaseName(context.input.company)}.question-screening-${stage}-${sequence}.json`, generator: "rolepilot-engine", stage: "supporting" },
    toJsonText({ classifications: payload.classifications, ...result }));
  return result;
}

export function parseAnswerInterpretation(value: unknown, context: ResumeSliceContext, answer: string): AnswerInterpretation {
  const result = object(value, "Answer interpretation");
  if (result.schemaVersion !== 1 || Object.keys(result).some((key) => !["schemaVersion", "answers", "additionalFacts", "corrections", "resolvedRestrictions", "resolvedMissingEvidence", "scopeUpdates"].includes(key))) throw new Error("Answer interpretation requires schemaVersion 1 and the result arrays.");
  for (const key of ["answers", "additionalFacts", "corrections", "resolvedRestrictions"]) {
    if (!Array.isArray(result[key])) throw new Error(`Answer interpretation ${key} must be an array.`);
  }
  const quote = (item: Record<string, unknown>) => {
    const sourceQuote = text(item.sourceQuote, "sourceQuote");
    if (!answer.includes(sourceQuote)) throw new Error("Answer sourceQuote must occur in the submitted answer.");
  };
  const seen = new Set<string>();
  for (const raw of result.answers as unknown[]) {
    const item = object(raw, "Answer entry");
    const gapId = text(item.gapId, "gapId");
    if (seen.has(gapId) || !context.state.questionRecords.some((record) => record.gapId === gapId)) throw new Error("Answer gapId is unknown or duplicated.");
    seen.add(gapId);
    if (!["answered", "partial", "unavailable", "skipped", "off_topic"].includes(String(item.status)) || !Array.isArray(item.acceptedFacts)) throw new Error("Answer status or acceptedFacts is invalid.");
    const suppliesFacts = item.status === "answered" || item.status === "partial";
    if (suppliesFacts !== (item.acceptedFacts.length > 0)) throw new Error("Answer status must agree with acceptedFacts.");
    for (const rawFact of item.acceptedFacts) {
      const fact = object(rawFact, "Accepted fact");
      text(fact.fact, "fact");
      quote(fact);
    }
  }
  if (context.state.questionRecords.some((record) => record.status === "pending" && !seen.has(record.gapId))) throw new Error("Answer interpretation must cover every pending question.");
  for (const raw of result.additionalFacts as unknown[]) {
    const item = object(raw, "Additional fact");
    text(item.target, "target"); text(item.fact, "fact"); quote(item);
  }
  const correctionTargets = new Set<string>();
  for (const raw of result.corrections as unknown[]) {
    const item = object(raw, "Correction");
    for (const key of ["target", "field"]) text(item[key], key);
    for (const key of ["previousValue", "value"]) if (typeof item[key] !== "string") throw new Error(`Correction ${key} must be a string.`);
    const correctionKey = `${item.target}:${item.field}`;
    if (correctionTargets.has(correctionKey)) throw new Error("A source field may be corrected only once per submission.");
    correctionTargets.add(correctionKey);
    quote(item);
    const artifact = context.state.originalResumeArtifact;
    if (!artifact) throw new Error("Correction requires a frozen original resume.");
    const original = parseResumeContentV3(JSON.parse(fs.readFileSync(artifact.absolutePath, "utf8")));
    const target = item.target === "profile" ? original.profile : indexResumeNodes(original).get(String(item.target))?.node;
    if (!target || ["id", "type", "documentId", "schemaVersion"].includes(String(item.field)) || typeof Reflect.get(target, String(item.field)) !== "string") throw new Error("Correction target/field must identify an existing scalar source content field.");
    const previous = context.state.answerInterpretations.flatMap((entry) => entry.corrections).filter((entry) => entry.target === item.target && entry.field === item.field).at(-1);
    if (item.previousValue !== (previous?.value ?? Reflect.get(target, String(item.field)))) throw new Error("Correction previousValue does not match its corresponding source field.");
  }
  if ((result.corrections as unknown[]).length) {
    const original = parseResumeContentV3(JSON.parse(fs.readFileSync(context.state.originalResumeArtifact!.absolutePath, "utf8")));
    applySourceCorrections(original, [...context.state.answerInterpretations.flatMap((entry) => entry.corrections),
      ...result.corrections as AnswerInterpretation["corrections"]]);
  }
  const resolvedQuote = (item: Record<string, unknown>) => {
    quote(item);
    const entry = (result.answers as Array<Record<string, unknown>>).find((entry) => entry.gapId === item.gapId);
    const facts = item.gapId === null
      ? [...result.additionalFacts as Array<Record<string, unknown>>, ...result.corrections as Array<Record<string, unknown>>]
      : entry && ["answered", "partial"].includes(String(entry.status))
        ? entry.acceptedFacts as Array<Record<string, unknown>> : [];
    if (!facts.some((fact) => fact.sourceQuote === item.sourceQuote)) {
      throw new Error(`Resolved boundary requires an accepted fact or correction with the same factual quote. gapId=${JSON.stringify(item.gapId)}; received=${JSON.stringify(item.sourceQuote)}; copy one complete sourceQuote from ${JSON.stringify(facts.map((fact) => fact.sourceQuote))}, or omit this unresolved boundary.`);
    }
  };
  for (const raw of result.resolvedRestrictions as unknown[]) {
    const item = object(raw, "Resolved restriction");
    if (!context.state.preflightDecision?.unsupportedTargets.includes(text(item.restriction, "restriction"))) throw new Error("Resolved restriction is not a current restriction.");
    resolvedQuote(item);
  }
  if (result.resolvedMissingEvidence !== undefined || (context.agentBindings.reviewer.mode ?? "live") === "live") {
    if (!Array.isArray(result.resolvedMissingEvidence)) throw new Error("resolvedMissingEvidence must be an array.");
    for (const raw of result.resolvedMissingEvidence) {
      const item = object(raw, "Resolved missing evidence");
      if (!context.state.preflightDecision?.missingEvidence.includes(text(item.missingEvidence, "missingEvidence"))) throw new Error("Resolved missing evidence is not a current gap.");
      resolvedQuote(item);
    }
  }
  if (result.scopeUpdates !== undefined) {
    if (!Array.isArray(result.scopeUpdates)) throw new Error("scopeUpdates must be an array.");
    const seenScopes = new Set<string>();
    for (const raw of result.scopeUpdates) {
      const item = object(raw, "Scope update");
      const previousScope = text(item.previousScope, "previousScope");
      text(item.replacement, "replacement");
      if (seenScopes.has(previousScope) || !context.state.safeWritingScope.includes(previousScope)
        || !(result.resolvedRestrictions as Array<Record<string, unknown>>).some((entry) => entry.restriction === item.restriction)) throw new Error("Scope update requires an existing scope and a resolved restriction.");
      seenScopes.add(previousScope);
    }
  }
  return result as AnswerInterpretation;
}
