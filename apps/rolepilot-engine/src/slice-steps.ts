import fs from "node:fs";
import YAML from "yaml";
import { AnswerInterpretationError, MAX_QUESTIONS_PER_ROUND, parseAnswerInterpretation, screenQuestionCandidates, selectQuestionCandidates } from "./question-policy.js";
import { parseResumeContentV3, type ResumeContentV3 } from "web-contracts/resume-document";
import { originalFromProvidedTimeline, type OriginalResumeSourceKind } from "./resume-document.js";
import { applyResumeOperations, applySourceCorrections, materializeInitialCandidate, parseReviewBinding, indexResumeNodes, assertSourceBackedIdentity, assertSourceBackedBulletContent, normalizeIssueTargetNodeIds, type ReviewBinding } from "./resume-document-operations.js";

import {
  applyReviewPolicyRound,
  createReviewPolicyState,
} from "platform-contracts";
import {
  isForbiddenQualificationQuestion,
  isRoleInfoQuestion,
  routeOptimizationDecision,
} from "platform-policy";

import {
  assertNonEmptyString,
  createArtifactBaseName,
  isJsonSyntaxError,
  toJsonText,
  parseJsonObject,
} from "./shared.js";
import { isYamlSyntaxError } from "./slice-step-parsing.js";
import { executeAgent } from "./slice-agents.js";
import { convertLegacyYamlToResumeContentV3 } from "./slice-step-jade.js";
import {
  cleanAndValidateYaml,
  normalizeOptimizationTargetNode,
  normalizePreflightProposalLocation,
  normalizeReviewSectionValues,
  parseMineOutput,
  parsePreflightDecision,
  parseOptimizationDecision,
  parseReviewReport,
  validateOptimizationDecisionPayload,
  validatePreflightDecisionPayload,
  validateReviewReport,
  stripMarkdownFences,
} from "./slice-step-parsing.js";
import {
  wrapCheatsheetPrompt,
  wrapInterviewPrompt,
  wrapJdAnalysisPrompt,
  wrapPreflightPrompt,
  wrapMinePrompt,
  wrapOptimizationDecisionPrompt,
  wrapResumeWritePrompt,
  wrapReviewPrompt,
  wrapAnswerInterpretationPrompt,
} from "./slice-step-prompts.js";
import {
  executeOptimizationAction,
  recordOptimizationTelemetry,
} from "./optimization-actions.js";
import {
  persistMemory,
  questionAllowance,
  registerArtifact,
  requireFinalResume,
  requireResume,
  requireTimeline,
} from "./slice-artifacts.js";
import type { ResumeSliceContext } from "./vertical-slice-types.js";
import type {
  OptimizationDecision,
  OptimizationActionHistoryEntry,
  PreflightDecision,
  QuestionRecord,
  QuestionCandidate,
  QuestionStage,
  AnswerInterpretation,
  StructuredEvidenceFact,
} from "./types.js";

type ResumeWriteStepOptions = {
  revisionRound?: number;
  reviewReport?: Record<string, unknown>;
  optimizationDecision?: OptimizationDecision;
};

type ResumeWritePacket = {
  documentId: string;
  currentDocument: ResumeContentV3 | null;
  importedResumeText: string | null;
  originalResume: ResumeContentV3 | null;
  originalResumePath: string | null;
  originalResumeSource: Record<string, unknown> | null;
  sourceTextPath: string | null;
  sourceText: string | null;
  evidenceCatalog: Record<string, string>;
  structuredEvidenceFacts: StructuredEvidenceFact[];
  supplementalEvidencePath: string | null;
  supplementalEvidenceText: string | null;
  company: ResumeSliceContext["input"]["company"];
  timelinePath: string;
  timelineText: string;
  jdText: string | null;
  jdAnalysisPath: string;
  jdAnalysisText: string;
  preflightDecisionPath: string | null;
  safeWritingScope: string[];
  missingEvidence: string[];
  unsupportedTargets: string[];
  previousResumePath: string | null;
  previousResumeText: string | null;
  reviewReport: Record<string, unknown> | null;
  optimizationDecision: OptimizationDecision | null;
  revisionRound: number;
  writingMode: "role-tailored-rewrite" | "initial-draft";
};

function ensureStructuredProjectFacts(
  content: ResumeContentV3,
  facts: StructuredEvidenceFact[],
): number {
  const projectFacts = facts.filter((fact) => /项目|平台|project|research/iu.test(`${fact.target} ${fact.fact}`));
  if (!projectFacts.length) return 0;
  const serialized = JSON.stringify(content);
  const missing = projectFacts.filter((fact) => !serialized.includes(fact.fact));
  if (!missing.length) return 0;
  const title = missing
    .map((fact) => fact.fact.match(/([^，。；：:]{2,24}(?:项目|平台))/u)?.[1])
    .find((value): value is string => Boolean(value)) ?? "补充项目经历";
  const bullets = missing.map((fact, index) => ({
    id: `${content.documentId}:supplemental-project-bullet-${index + 1}`,
    content: fact.fact,
  }));
  const section = content.sections.find((item) => item.type === "projects");
  if (section?.type === "projects") {
    const existing = section.entries.find((entry) => entry.name === title);
    if (existing) existing.bullets.push(...bullets);
    else section.entries.push({ id: `${content.documentId}:supplemental-project`, name: title, role: "", date: "", location: "", bullets });
  } else {
    content.sections.push({
      id: `${content.documentId}:supplemental-projects`,
      type: "projects",
      title: "项目经历",
      entries: [{ id: `${content.documentId}:supplemental-project`, name: title, role: "", date: "", location: "", bullets }],
    });
  }
  return bullets.length;
}

type ResumeReviewEvaluation = {
  binding?: ReviewBinding;
  currentResume: ReturnType<typeof requireResume>;
  report: Record<string, unknown>;
  reviewArtifact: ReturnType<
    ResumeSliceContext["workspace"]["registerArtifact"]
  >;
};

export function seedTimelineIfProvided(context: ResumeSliceContext) {
  if (!context.input.timelineText) {
    return;
  }

  const baseName = createArtifactBaseName(context.input.company);
  context.state.timelineArtifact = registerArtifact(
    context,
    {
      kind: "timeline",
      fileName: `${baseName}.timeline.yml`,
      generator: "rolepilot-engine",
      stage: "supporting",
    },
    context.input.timelineText,
  );
  if (!context.input.importedResumeText?.trim()) {
    freezeOriginalResume(context, originalFromProvidedTimeline(context.input.timelineText, `${context.input.runId}:original`),
      context.input.timelineText, "provided-timeline", "deterministic");
  }
  persistMemory(context);
}

function freezeOriginalResume(
  context: ResumeSliceContext,
  originalResume: ResumeContentV3,
  sourceText: string,
  sourceKind: OriginalResumeSourceKind,
  structuring: "miner" | "deterministic",
) {
  if (context.state.originalResumeArtifact) return;
  const baseName = createArtifactBaseName(context.input.company);
  const source = registerArtifact(context, {
    kind: "log", fileName: `${baseName}.resume.source.txt`, generator: "rolepilot-engine", stage: "supporting",
  }, sourceText);
  const original = registerArtifact(context, {
    kind: "resume", fileName: `${baseName}.resume.original.json`, generator: "rolepilot-engine", stage: "supporting",
  }, toJsonText(parseResumeContentV3(originalResume)));
  const provenance = registerArtifact(context, {
    kind: "log", fileName: `${baseName}.resume.original-source.json`, generator: "rolepilot-engine", stage: "supporting",
  }, toJsonText({
    schemaVersion: 1, documentId: originalResume.documentId, sourceKind, structuring,
    sourceTextPath: source.path, originalResumePath: original.path,
    note: sourceKind === "provided-timeline" ? "原稿来源为用户提供经历，不是上传简历复刻。"
      : sourceKind === "legacy-offline-text" ? "旧离线 Mine 仅返回 timeline；原稿保留输入全文，未从 timeline 推测。"
        : "原稿忠实结构化提取文字；不恢复原文件版式，也不修正提取/OCR 错误。",
  }));
  context.state.sourceTextArtifact = source;
  context.state.originalResumeArtifact = original;
  context.state.originalResumeSourceArtifact = provenance;
}

export async function runMineStep(context: ResumeSliceContext) {
  if (context.state.timelineArtifact && context.state.originalResumeArtifact) {
    return context.state.timelineArtifact;
  }

  assertNonEmptyString(
    context.input.importedResumeText,
    "Resume mine requires importedResumeText when timeline context is missing.",
  );
  const importedResumeText = context.input.importedResumeText!;
  const baseName = createArtifactBaseName(context.input.company);
  const mineOutput = await executeAgent(
    context,
    "miner",
    "mine",
    "mine",
    wrapMinePrompt(importedResumeText),
    "faithfully structure original resume and auxiliary timeline from source text",
  );
  const parsed = parseMineOutput(mineOutput, {
    documentId: `${context.input.runId}:original`, importedResumeText,
    allowLegacy: ["stub", "replay"].includes(context.agentBindings.miner.mode ?? "live"),
  });
  freezeOriginalResume(context, parsed.originalResume, importedResumeText,
    parsed.legacy ? "legacy-offline-text" : "imported-text", parsed.legacy ? "deterministic" : "miner");
  const record = context.state.timelineArtifact ?? registerArtifact(
    context,
    {
      kind: "timeline",
      fileName: `${baseName}.timeline.yml`,
      generator: "miner",
      stage: "supporting",
    },
    parsed.timelineText,
  );
  context.state.timelineArtifact = record;
  persistMemory(context);
  return record;
}

export async function ensureJdAnalysis(context: ResumeSliceContext) {
  if (context.state.jdAnalysisArtifact) {
    return context.state.jdAnalysisArtifact;
  }

  const baseName = createArtifactBaseName(context.input.company);
  const jdAnalysisText = await executeAgent(
    context,
    "writer",
    "write",
    "jd-analysis",
    wrapJdAnalysisPrompt(
      toJsonText(context.input.company),
      context.input.jdText,
    ),
    "analyze target company and role",
  );
  const record = registerArtifact(
    context,
    {
      kind: "jd-analysis",
      fileName: `${baseName}.jd-analysis.yml`,
      generator: "writer",
      stage: "draft",
    },
    jdAnalysisText,
  );
  context.state.jdAnalysisArtifact = record;
  return record;
}

export async function runJdAnalysisStep(context: ResumeSliceContext) {
  requireTimeline(context);
  return ensureJdAnalysis(context);
}

function buildSourceMaterials(context: ResumeSliceContext) {
  const supplementalEvidence = context.state.supplementalEvidenceArtifact;
  const original = context.state.originalResumeArtifact;
  const provenance = context.state.originalResumeSourceArtifact;
  const source = context.state.sourceTextArtifact;
  const originalContent = original ? parseResumeContentV3(JSON.parse(fs.readFileSync(original.absolutePath, "utf8"))) : null;
  const effectiveSourceResume = originalContent ? applySourceCorrections(originalContent,
    context.state.answerInterpretations.flatMap((entry) => entry.corrections)) : null;
  const evidenceCatalog: Record<string, string> = {};
  if (effectiveSourceResume) {
    for (const [id, { node }] of indexResumeNodes(effectiveSourceResume)) evidenceCatalog[`original:${id}`] = JSON.stringify(node);
    for (const [field, value] of Object.entries(effectiveSourceResume.profile)) if (value) evidenceCatalog[`profile:${field}`] = typeof value === "string" ? value : JSON.stringify(value);
  }
  if (source) evidenceCatalog.sourceText = fs.readFileSync(source.absolutePath, "utf8");
  const acceptedAnswers = context.state.answerInterpretations.flatMap((interpretation) => [
    ...interpretation.answers.flatMap((answer) => answer.acceptedFacts.map((fact) => `${fact.fact}\n来源原话：${fact.sourceQuote}`)),
    ...interpretation.additionalFacts.map((fact) => `${fact.fact}\n来源原话：${fact.sourceQuote}`),
    ...interpretation.corrections.map((correction) => `${correction.target}.${correction.field}: ${correction.value}`),
  ]);
  const structuredEvidenceFacts: StructuredEvidenceFact[] = [];
  for (const interpretation of context.state.answerInterpretations) {
    for (const answer of interpretation.answers) {
      const question = context.state.questionRecords.find((record) => record.gapId === answer.gapId);
      for (const fact of answer.acceptedFacts) {
        structuredEvidenceFacts.push({
          kind: "accepted",
          gapId: answer.gapId,
          target: question?.target ?? "profile",
          fact: fact.fact,
          sourceQuote: fact.sourceQuote,
        });
      }
    }
    for (const fact of interpretation.additionalFacts) {
      structuredEvidenceFacts.push({
        kind: "additional",
        gapId: null,
        target: fact.target,
        fact: fact.fact,
        sourceQuote: fact.sourceQuote,
      });
    }
  }
  if (acceptedAnswers.length) evidenceCatalog.userAnswers = acceptedAnswers.join("\n\n");
  return {
    questionRecords: context.state.questionRecords,
    answerInterpretations: context.state.answerInterpretations,
    effectiveRestrictions: context.state.preflightDecision?.unsupportedTargets ?? [],
    importedResumeText: context.input.importedResumeText ?? null,
    originalResumePath: original?.absolutePath ?? null,
    originalResume: originalContent,
    effectiveSourceResume,
    evidenceCatalog,
    structuredEvidenceFacts,
    originalResumeSource: provenance ? parseJsonObject(fs.readFileSync(provenance.absolutePath, "utf8"), "Original resume provenance") : null,
    sourceTextPath: source?.absolutePath ?? null,
    sourceText: source ? fs.readFileSync(source.absolutePath, "utf8") : context.input.importedResumeText ?? context.input.timelineText ?? null,
    supplementalEvidencePath: supplementalEvidence?.absolutePath ?? null,
    supplementalEvidenceText: supplementalEvidence
      ? fs.readFileSync(supplementalEvidence.absolutePath, "utf8")
      : null,
  };
}

function buildPreflightPacket(context: ResumeSliceContext) {
  const timeline = requireTimeline(context);
  const jdAnalysis = context.state.jdAnalysisArtifact;
  if (!jdAnalysis) {
    throw new Error(
      "Resume preflight requires JD analysis context. Run JD analysis before preflight.",
    );
  }

  const originalDocument = context.state.originalResumeArtifact
    ? parseResumeContentV3(JSON.parse(fs.readFileSync(context.state.originalResumeArtifact.absolutePath, "utf8")))
    : null;
  const allowedTargets = [
    ...(originalDocument ? ["profile", ...indexResumeNodes(originalDocument).keys()] : []),
    ...Object.values(context.input.company).filter((value) => typeof value === "string"),
  ];

  return {
    evaluationAttempt: context.state.preflightAttempts + 1,
    ...questionAllowance(context),
    company: context.input.company,
    allowedTargets,
    timelinePath: timeline.absolutePath,
    timelineText: fs.readFileSync(timeline.absolutePath, "utf8"),
    jdText: context.input.jdText ?? null,
    jdAnalysisPath: jdAnalysis.absolutePath,
    jdAnalysisText: fs.readFileSync(jdAnalysis.absolutePath, "utf8"),
    ...buildSourceMaterials(context),
  };
}

export async function persistSupplementalEvidence(
  context: ResumeSliceContext,
  userEvidenceText: string,
) {
  const baseName = createArtifactBaseName(context.input.company);
  const attempt = context.state.userAnswerTexts.length + 1;
  const previousEvidence = buildSourceMaterials(context).supplementalEvidenceText;
  const answer = userEvidenceText.trim();
  const pendingRecords = context.state.questionRecords.filter(
    (record) => record.status === "pending",
  );
  const record = registerArtifact(
    context,
    {
      kind: "supplemental-evidence",
      fileName: `${baseName}.supplemental-evidence.attempt-${attempt}.md`,
      generator: "rolepilot-engine",
      stage: "supporting",
    },
    [
      previousEvidence ?? "# 补充材料（历史纯文本视为用户回答）",
      "",
      `## 第 ${attempt - 1} 次评估后的补充`,
      "### 系统问题（不作为已确认事实）",
      ...pendingRecords.map((question) => `- [${question.status}] ${question.question}`),
      "### 用户提交原文（待语义解析，不等于已确认事实）",
      answer,
      "",
    ].join("\n"),
  );
  context.state.supplementalEvidenceArtifact = record;
  context.state.userAnswerTexts.push(answer);
  persistMemory(context);
  const stage = context.state.pendingQuestionStage === "review" ? "review" : "preflight";
  const inputPacket = { ...buildSourceMaterials(context), submittedAnswer: answer, pendingQuestions: pendingRecords,
    safeWritingScope: context.state.safeWritingScope, missingEvidence: context.state.preflightDecision?.missingEvidence ?? [],
    unsupportedTargets: context.state.preflightDecision?.unsupportedTargets ?? [] };
  let interpretation: AnswerInterpretation | undefined = answer === "跳过" ? {
    schemaVersion: 1, answers: pendingRecords.map((question) => ({ gapId: question.gapId, status: "skipped", acceptedFacts: [] })),
    additionalFacts: [], corrections: [], resolvedRestrictions: [], resolvedMissingEvidence: [], scopeUpdates: [],
  } : undefined;
  let invalidResponse: string | undefined;
  let validationError: string | undefined;
  const maxAttempts = (context.agentBindings.reviewer.mode ?? "live") === "live" ? 2 : 1;
  for (let parseAttempt = 1; !interpretation && parseAttempt <= maxAttempts; parseAttempt += 1) {
    try {
      const response = await executeAgent(context, "reviewer", stage,
        parseAttempt === 1 ? "interpret-user-answers" : "interpret-user-answers-contract-retry-1",
        wrapAnswerInterpretationPrompt(toJsonText({ ...inputPacket, previousInvalidResponse: invalidResponse, previousValidationError: validationError })),
        parseAttempt === 1 ? "interpret submitted answers before recovery" : "explicit answer contract retry 1/1");
      invalidResponse = response;
      interpretation = parseAnswerInterpretation(parseJsonObject(stripMarkdownFences(response), "Answer interpretation"), context, answer);
      break;
    } catch (error) {
      if (context.input.signal?.aborted) throw error;
      validationError = error instanceof Error ? error.message : String(error);
      registerArtifact(context, { kind: "log", fileName: `${baseName}.answer-interpretation-${attempt}.failure-${parseAttempt}.json`, generator: "rolepilot-engine", stage: "supporting" },
        toJsonText({ policy: "answer-contract-retry-once-then-wait", parseAttempt, validationError, retryScheduled: parseAttempt < maxAttempts }));
      if (parseAttempt === maxAttempts) throw new AnswerInterpretationError(stage, pendingRecords.map((question) => question.question), error);
    }
  }
  if (!interpretation) throw new Error("Answer interpretation did not complete.");
  const priorFacts = new Set(context.state.answerInterpretations.flatMap((entry) => [
    ...entry.answers.flatMap((item) => item.acceptedFacts.map((fact) => `${item.gapId}:${fact.fact}`)),
    ...entry.additionalFacts.map((fact) => `${fact.target}:${fact.fact}`),
  ]));
  const hasFacts = interpretation.answers.some((item) => item.acceptedFacts.some((fact) => !priorFacts.has(`${item.gapId}:${fact.fact}`)))
    || interpretation.additionalFacts.some((fact) => !priorFacts.has(`${fact.target}:${fact.fact}`)) || interpretation.corrections.length > 0;
  if (hasFacts) {
    context.state.evidenceVersion += 1;
  }
  for (const item of interpretation.answers) {
    const question = context.state.questionRecords.find((entry) => entry.gapId === item.gapId)!;
    question.status = item.status;
    question.answer = answer;
    question.acceptedFacts = item.acceptedFacts.map((fact) => fact.fact);
    question.sourceQuote = item.acceptedFacts.map((fact) => fact.sourceQuote).join("\n") || null;
    if (item.acceptedFacts.length) question.evidenceVersion = context.state.evidenceVersion;
  }
  context.state.answerInterpretations.push(interpretation);
  if (context.state.preflightDecision) {
    const resolved = new Set(interpretation.resolvedRestrictions.map((item) => item.restriction));
    const resolvedMissing = new Set(interpretation.resolvedMissingEvidence?.map((item) => item.missingEvidence) ?? []);
    context.state.preflightDecision = {
      ...context.state.preflightDecision,
      unsupportedTargets: context.state.preflightDecision.unsupportedTargets.filter((item) => !resolved.has(item)),
      missingEvidence: context.state.preflightDecision.missingEvidence.filter((item) => !resolvedMissing.has(item)),
    };
    context.state.safeWritingScope = context.state.safeWritingScope.map((scope) => interpretation.scopeUpdates?.find((item) => item.previousScope === scope)?.replacement ?? scope);
    if (context.state.pendingQuestionStage === "review") {
      context.state.preflightDecision.safeWritingScope = [...context.state.safeWritingScope];
      context.state.preflightDecisionArtifact = registerArtifact(context, {
        kind: "preflight", fileName: `${baseName}.preflight.effective-answer-${attempt}.json`, generator: "rolepilot-engine", stage: "supporting",
      }, toJsonText(context.state.preflightDecision));
    }
  }
  registerArtifact(context, { kind: "log", fileName: `${baseName}.answer-interpretation-${attempt}.json`, generator: "rolepilot-engine", stage: "supporting" },
    toJsonText({ interpretation, policy: answer === "跳过" ? "explicit-skip-without-model" : "interpreted-answer", evidenceVersion: context.state.evidenceVersion, questionRecords: context.state.questionRecords, effectivePreflight: context.state.preflightDecision }));
  persistMemory(context);
  return record;
}

function renderQuestionsArtifact(questions: string[]) {
  return [
    "# 待确认的问题",
    "",
    ...questions.map((question) => `- ${question}`),
    "",
  ].join("\n");
}

function uniqueText(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function legacyQuestionCandidates(values: unknown[], fallbackExpectedImprovement = "改善目标岗位相关经历的表达") {
  const candidates = values
    .map((value): QuestionCandidate => typeof value === "string"
      ? { question: value, expectedImprovement: fallbackExpectedImprovement, intent: "content_fact" }
      : value && typeof value === "object" && !Array.isArray(value)
        ? value as QuestionCandidate
        : { question: "", expectedImprovement: fallbackExpectedImprovement, intent: "content_fact" })
    .filter((candidate) => typeof candidate.question === "string" && candidate.question.trim());
  const seen = new Set<string>();
  const allowed: QuestionCandidate[] = [];
  const filtered: Array<{ candidate: QuestionCandidate; reason: string }> = [];
  for (const candidate of candidates) {
    const key = candidate.gapId?.trim() || candidate.question.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    if (candidate.intent === "qualification" || candidate.sourceAssessment === "answered") {
      filtered.push({ candidate, reason: candidate.intent === "qualification" ? "qualification" : "already-answered" });
      continue;
    }
    allowed.push({ ...candidate, question: candidate.question.trim(), expectedImprovement: candidate.expectedImprovement?.trim() || fallbackExpectedImprovement });
  }
  return { allowed, filtered };
}

function formatQuestion(
  question: string,
  expectedImprovement: string,
) {
  const trimmed = question.trim();
  const suffix = `补充后会用于${expectedImprovement}`;
  return trimmed.includes("补充后会用于")
    ? trimmed
    : `${trimmed}${/[。！？!?]$/.test(trimmed) ? "" : "。"}${suffix}。`;
}

export function publishQuestionRecords(
  context: ResumeSliceContext,
  input: {
    stage: QuestionStage;
    questions: Array<string | QuestionCandidate>;
    target?: string | null;
    expectedImprovement: string;
  },
) {
  const target = input.target?.trim() || null;
  const existing = new Set(context.state.questionRecords.map((record) => record.gapId));
  const records: QuestionRecord[] = [];
  for (const rawQuestion of input.questions) {
    if (records.length >= MAX_QUESTIONS_PER_ROUND) break;
    const candidate = typeof rawQuestion === "string" ? null : rawQuestion;
    const question = (candidate ? candidate.question : rawQuestion as string).trim();
    if (!question) continue;
    const gapId = candidate?.existingGapId?.trim() || `gap-${context.state.questionRecords.length + records.length + 1}`;
    if (existing.has(gapId)) continue;
    existing.add(gapId);
    records.push({
      gapId,
      stage: input.stage,
      target: candidate?.target ?? target,
      intent: candidate?.intent,
      missingFact: candidate?.missingFact,
      question: candidate?.missingFact ? question : formatQuestion(question, candidate?.expectedImprovement || input.expectedImprovement),
      expectedImprovement: candidate?.expectedImprovement || input.expectedImprovement,
      status: "pending",
      answer: null,
      publishedRound: context.state.userQuestionRoundsUsed + 1,
      evidenceVersion: context.state.evidenceVersion,
    });
  }
  if (records.length === 0) return [];
  context.state.questionRecords.push(...records);
  context.state.pendingQuestionStage = input.stage;
  context.state.pendingUserQuestions = records.map((record) => record.question);
  return context.state.pendingUserQuestions;
}

function restrictToSourceFacts(decision: PreflightDecision): PreflightDecision {
  return {
    ...decision,
    decision: "PROCEED",
    blockingQuestions: [],
    eligibilityNotes: uniqueText(decision.eligibilityNotes ?? []),
    unsupportedTargets: ["禁止任何未获原始材料或用户回答支持的具体主张、角色升级、资格、数字和成果归属。"],
    safeWritingScope: [
      "只写可追溯到原始材料及用户陈述的事实；timeline 仅作整理，系统问题和模型生成文稿不构成新事实。",
      "未知或矛盾内容省略，不将目标职位当作既有资历；按真实教育、科研、课程、项目及工作背景组织内容。",
      "岗位差距只限制具体不支持的主张，不禁止有事实支持的相关经历或可迁移方法。",
    ],
  };
}

export async function runPreflightStep(
  context: ResumeSliceContext,
): Promise<PreflightDecision> {
  if (context.state.stopReason === "needs-user-input" && context.state.preflightDecision?.decision === "ASK_USER") {
    return context.state.preflightDecision;
  }
  const baseName = createArtifactBaseName(context.input.company);
  const attempt = context.state.preflightAttempts + 1;
  const buildPreflightCall = (
    action: string,
    retryContext: { parseError: string; invalidResponse: string } | undefined,
  ) => {
    const rawResponses: Array<{ path: string; absolutePath: string }> = [];
    const call = executeAgent(
      context,
      "reviewer",
      "preflight",
      action,
      wrapPreflightPrompt(toJsonText({
        ...buildPreflightPacket(context),
        previousParseError: retryContext?.parseError ?? null,
        previousInvalidResponse: retryContext?.invalidResponse ?? null,
      })),
      "run preflight gate",
      { onRawResponse: (record) => rawResponses.push(record) },
    );
    return { call, rawResponses };
  };
  const firstAction = "preflight";
  const first = buildPreflightCall(firstAction, undefined);
  let preflightText = "";
  let parsedProposal: ReturnType<typeof parsePreflightDecision>;
  let formatRetryAudit: Record<string, unknown> | undefined;
  let firstResponsePath: string | null = null;
  try {
    preflightText = await first.call;
    firstResponsePath = first.rawResponses[0]?.path ?? null;
    parsedProposal = parsePreflightDecision(preflightText);
  } catch (error) {
    const retryable = isJsonSyntaxError(error)
      && context.agentBindings.reviewer.mode === "live";
    if (!retryable) throw error;
    const parseError = error instanceof Error ? error.message : String(error);
    const retryAction = `${firstAction}-json-retry-1`;
    formatRetryAudit = {
      stage: "preflight",
      reason: "live-preflight-json-syntax-retry",
      attempt,
      parseError,
      invalidResponsePath: firstResponsePath,
      retryAction,
    };
    const retry = buildPreflightCall(retryAction, { parseError, invalidResponse: preflightText });
    try {
      preflightText = await retry.call;
      formatRetryAudit.retryResponsePath = retry.rawResponses[0]?.path ?? null;
      parsedProposal = parsePreflightDecision(preflightText);
    } catch (retryError) {
      registerArtifact(
        context,
        { kind: "log", fileName: `${baseName}.preflight.format-retry.attempt-${attempt}.json`, generator: "rolepilot-engine", stage: "supporting" },
        toJsonText({ ...formatRetryAudit, result: "failed", failureReason: retryError instanceof Error ? retryError.message : String(retryError) }),
      );
      throw retryError;
    }
    formatRetryAudit.result = "recovered";
    registerArtifact(
      context,
      { kind: "log", fileName: `${baseName}.preflight.format-retry.attempt-${attempt}.json`, generator: "rolepilot-engine", stage: "supporting" },
      toJsonText(formatRetryAudit),
    );
  }
  const normalized = normalizePreflightProposalLocation(parsedProposal);
  if (normalized.relocated) {
    // 位置归一化审计必须在完整合同校验之前登记，确保迁移后仍失败也有记录。
    registerArtifact(context, { kind: "log", fileName: `${baseName}.preflight.proposal-relocation-${attempt}.json`, generator: "rolepilot-engine", stage: "supporting" }, toJsonText({
      rule: "preflight-question-candidates-relocation",
      from: "writingBoundary.questionCandidates",
      to: "questionCandidates",
      normalizedProposal: normalized.proposal,
    }));
  }
  const modelDecision = validatePreflightDecisionPayload(
    normalized.proposal,
    context.input.env,
    { allowLegacy: ["stub", "replay"].includes(context.agentBindings.reviewer.mode ?? "live") },
  );
  const questionFilter = await screenQuestionCandidates(context, questionAllowance(context).canAskUser
    ? modelDecision.questionCandidates ?? legacyQuestionCandidates(modelDecision.blockingQuestions).allowed : [], "preflight", buildSourceMaterials(context));
  registerArtifact(context, { kind: "log", fileName: `${baseName}.preflight.proposal-${attempt}.json`, generator: "rolepilot-engine", stage: "supporting" }, toJsonText({ proposal: normalized.proposal, candidates: questionFilter, ...questionAllowance(context) }));
  const questionCandidates = questionFilter.allowed;
  const questions = questionCandidates.map((candidate) => candidate.question);
  const eligibilityNotes = uniqueText(modelDecision.eligibilityNotes ?? []);
  const decision: PreflightDecision = questions.length > 0 && questionAllowance(context).canAskUser
    ? { ...modelDecision, decision: "ASK_USER", blockingQuestions: questions, questionCandidates, eligibilityNotes }
    : modelDecision.decision === "PROCEED"
      ? { ...modelDecision, blockingQuestions: [], eligibilityNotes }
      : restrictToSourceFacts(modelDecision);
  if (decision.decision !== modelDecision.decision || questionFilter.filtered.length > 0) {
    registerArtifact(context, {
      kind: "log",
      fileName: `${baseName}.preflight.policy-${attempt}.json`,
      generator: "rolepilot-engine",
      stage: "supporting",
    }, toJsonText({ modelDecision, effectiveDecision: decision, filteredQuestionCandidates: questionFilter.filtered, ...questionAllowance(context), reason: "quality-candidates-filtered-by-intent-source-assessment-or-target-resolution" }));
    recordOptimizationTelemetry(context, "selected", `preflight policy: ${modelDecision.decision} -> ${decision.decision}; remaining question rounds ${questionAllowance(context).remainingQuestionRounds}`);
  }
  const userMessages = decision.decision === "ASK_USER"
    ? publishQuestionRecords(context, {
      stage: "preflight",
      questions: questionCandidates,
      target: context.input.company.title ?? context.input.company.role ?? null,
      expectedImprovement: questionCandidates.map((candidate) => candidate.expectedImprovement).filter(Boolean).join("；") || "确认可安全写入的目标岗位相关经历和事实边界",
    })
    : [];
  const effectiveDecision = decision.decision === "ASK_USER" && userMessages.length === 0
    ? restrictToSourceFacts(decision)
    : decision.decision === "ASK_USER"
      ? { ...decision, blockingQuestions: userMessages }
      : decision;
  const preflightRecord = registerArtifact(
    context,
    {
      kind: "preflight",
      fileName:
        attempt === 1
          ? `${baseName}.preflight.json`
          : `${baseName}.preflight.attempt-${attempt}.json`,
      generator: "reviewer",
      stage: "supporting",
    },
    toJsonText(effectiveDecision),
  );
  context.state.preflightDecisionArtifact = preflightRecord;
  context.state.preflightAttempts = attempt;
  context.state.preflightDecision = effectiveDecision;
  context.state.safeWritingScope =
    effectiveDecision.decision === "PROCEED" ? effectiveDecision.safeWritingScope : [];
  context.state.pendingUserQuestions =
    effectiveDecision.decision === "ASK_USER" || effectiveDecision.decision === "STOP_UNSUPPORTED"
      ? userMessages
      : [];

  if (effectiveDecision.decision === "ASK_USER") {
    context.state.userQuestionRoundsUsed += 1;
    context.state.stopReason = "needs-user-input";
    context.state.questionsArtifact = registerArtifact(
      context,
      {
        kind: "questions",
        fileName:
          attempt === 1
            ? `${baseName}.questions.md`
            : `${baseName}.questions.attempt-${attempt}.md`,
        generator: "reviewer",
        stage: "supporting",
      },
      renderQuestionsArtifact(userMessages),
    );
    persistMemory(context);
    return effectiveDecision;
  }

  context.state.pendingQuestionStage = null;
  context.state.stopReason = null;
  persistMemory(context);
  return effectiveDecision;
}

export function buildResumeWritePacket(
  context: ResumeSliceContext,
  options: ResumeWriteStepOptions = {},
): ResumeWritePacket {
  const timeline = requireTimeline(context);
  const jdAnalysis = context.state.jdAnalysisArtifact;
  const preflightDecision = context.state.preflightDecision;
  if (!jdAnalysis) {
    throw new Error(
      "Resume write requires JD analysis context. Run JD analysis before write.",
    );
  }
  if (!preflightDecision || preflightDecision.decision !== "PROCEED") {
    throw new Error(
      "Resume write requires a PROCEED preflight decision. Run preflight before write.",
    );
  }
  if (context.state.safeWritingScope.length === 0) {
    throw new Error(
      "Resume write requires a non-empty safe writing scope from preflight.",
    );
  }

  const revisionRound = options.revisionRound ?? 1;
  const previousResume = context.state.currentResumeArtifact;
  return {
    ...buildSourceMaterials(context),
    documentId: `${context.input.runId}:generated`,
    currentDocument: previousResume ? readV3Resume(previousResume.absolutePath) : null,
    company: context.input.company,
    timelinePath: timeline.absolutePath,
    timelineText: fs.readFileSync(timeline.absolutePath, "utf8"),
    jdText: context.input.jdText ?? null,
    jdAnalysisPath: jdAnalysis.absolutePath,
    jdAnalysisText: fs.readFileSync(jdAnalysis.absolutePath, "utf8"),
    preflightDecisionPath:
      context.state.preflightDecisionArtifact?.absolutePath ?? null,
    safeWritingScope: [...context.state.safeWritingScope],
    missingEvidence: [...preflightDecision.missingEvidence],
    unsupportedTargets: [...preflightDecision.unsupportedTargets],
    previousResumePath: previousResume?.absolutePath ?? null,
    previousResumeText: previousResume
      ? fs.readFileSync(previousResume.absolutePath, "utf8")
      : null,
    reviewReport: options.reviewReport ?? null,
    optimizationDecision: options.optimizationDecision ?? null,
    revisionRound,
    writingMode: options.reviewReport
      ? "role-tailored-rewrite"
      : revisionRound > 1
        ? "role-tailored-rewrite"
        : "initial-draft",
  };
}

function readV3Resume(filePath: string): ResumeContentV3 | null {
  if (!filePath) return null;
  const value = YAML.parse(fs.readFileSync(filePath, "utf8"));
  return value?.schemaVersion === 3 ? parseResumeContentV3(value) : null;
}

function artifactPathForDelivery(
  context: ResumeSliceContext,
  absolutePath: string,
): string {
  const artifact = context.workspace.createArtifactManifest().artifacts.find(
    (candidate) => candidate.absolutePath === absolutePath,
  );
  if (!artifact) {
    throw new Error(`Delivery index references an unregistered artifact: ${absolutePath}`);
  }
  return artifact.path;
}

function parseYamlDocument(text: string, label: string): Record<string, any> {
  const parsed = YAML.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a YAML object.`);
  }
  return parsed as Record<string, any>;
}

function resumeContent(document: Record<string, any>) {
  const content = readRecordField(document, "content");
  return content && typeof content === "object" && !Array.isArray(content)
    ? (content as Record<string, any>)
    : document;
}

function supportedKeywords(original: unknown, proposed: unknown) {
  const originalKeywords = Array.isArray(original)
    ? original.filter((item): item is string => typeof item === "string")
    : [];
  const proposedKeywords = Array.isArray(proposed)
    ? proposed.filter((item): item is string => typeof item === "string")
    : [];
  const filtered = proposedKeywords.filter((item) => originalKeywords.includes(item));
  return filtered.length > 0 || proposedKeywords.length === 0
    ? filtered
    : originalKeywords;
}

function mergeEditableResumeYaml(
  previousText: string,
  candidateText: string,
  optimizationAction?: string,
  target?: string | null,
) {
  const previous = parseYamlDocument(previousText, "Previous resume");
  const candidate = parseYamlDocument(candidateText, "Candidate resume");
  const previousContent = resumeContent(previous);
  const candidateContent = resumeContent(candidate);
  const merged = structuredClone(previous);
  const mergedContent = resumeContent(merged);
  const action = optimizationAction?.toUpperCase();
  const allowNarrative = action !== "KEYWORD_OPTIMIZE" && action !== "REORDER";
  const allowSkills = action === undefined || action === "REWRITE_SECTION" || action === "KEYWORD_OPTIMIZE";

  const previousBasics = readRecordField(previousContent, "basics");
  const candidateBasics = readRecordField(candidateContent, "basics");
  const mergedBasics = readRecordField(mergedContent, "basics");
  if (
    allowNarrative &&
    previousBasics && candidateBasics &&
    typeof previousBasics === "object" && !Array.isArray(previousBasics) &&
    typeof candidateBasics === "object" && !Array.isArray(candidateBasics) &&
    mergedBasics && typeof mergedBasics === "object" && !Array.isArray(mergedBasics)
  ) {
    for (const field of ["headline", "summary"]) {
      const value = Reflect.get(candidateBasics, field);
      if (typeof value === "string") Reflect.set(mergedBasics, field, value);
    }
  }

  for (const group of ["work", "projects"]) {
    const previousEntries = readRecordField(previousContent, group);
    const candidateEntries = readRecordField(candidateContent, group);
    const mergedEntries = readRecordField(mergedContent, group);
    if (!Array.isArray(previousEntries) || !Array.isArray(candidateEntries) || !Array.isArray(mergedEntries)) continue;
    const allowReorder = action === "REORDER" && (target ?? "").toLowerCase().includes(group);
    if (allowReorder && candidateEntries.length === previousEntries.length) {
      const indexByIdentity = new Map<string, number>();
      previousEntries.forEach((entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
        const identity = `${Reflect.get(entry, "company") ?? Reflect.get(entry, "name") ?? ""}|${Reflect.get(entry, "position") ?? ""}|${Reflect.get(entry, "startDate") ?? ""}`;
        indexByIdentity.set(identity, index);
      });
      const reordered = candidateEntries.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
        const identity = `${Reflect.get(entry, "company") ?? Reflect.get(entry, "name") ?? ""}|${Reflect.get(entry, "position") ?? ""}|${Reflect.get(entry, "startDate") ?? ""}`;
        const originalIndex = indexByIdentity.get(identity);
        return originalIndex === undefined ? null : structuredClone(previousEntries[originalIndex]);
      });
      if (reordered.every(Boolean)) Reflect.set(mergedContent, group, reordered);
    }
    if (allowReorder || !allowNarrative) continue;
    const targetEntries = readRecordField(mergedContent, group);
    if (!Array.isArray(targetEntries)) continue;
    targetEntries.forEach((entry, index) => {
      const candidateEntry = candidateEntries[index];
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || !candidateEntry || typeof candidateEntry !== "object" || Array.isArray(candidateEntry)) return;
      for (const field of ["summary", "description"]) {
        const value = Reflect.get(candidateEntry, field);
        if (typeof value === "string") Reflect.set(entry, field, value);
      }
    });
  }

  const previousSkills = readRecordField(previousContent, "skills");
  const candidateSkills = readRecordField(candidateContent, "skills");
  if (allowSkills && Array.isArray(previousSkills) && Array.isArray(candidateSkills) && candidateSkills.length > 0 && candidateSkills.length <= previousSkills.length) {
    const previousByName = new Map<string, Record<string, any>>();
    previousSkills.forEach((skill) => {
      if (skill && typeof skill === "object" && !Array.isArray(skill) && typeof Reflect.get(skill, "name") === "string") previousByName.set(Reflect.get(skill, "name"), skill);
    });
    const reorderedSkills = candidateSkills.map((skill) => {
      if (!skill || typeof skill !== "object" || Array.isArray(skill)) return null;
      const name = Reflect.get(skill, "name");
      const original = typeof name === "string" ? previousByName.get(name) : undefined;
      if (!original) return null;
      const mergedSkill = structuredClone(original);
      if (Array.isArray(Reflect.get(skill, "keywords"))) Reflect.set(mergedSkill, "keywords", supportedKeywords(Reflect.get(original, "keywords"), Reflect.get(skill, "keywords")));
      return mergedSkill;
    });
    const names = reorderedSkills.filter((skill): skill is Record<string, any> => Boolean(skill)).map((skill) => Reflect.get(skill, "name"));
    if (reorderedSkills.every(Boolean) && new Set(names).size === names.length) Reflect.set(mergedContent, "skills", reorderedSkills);
  }

  return YAML.stringify(merged);
}

export async function writeResumeDraft(
  context: ResumeSliceContext,
  packet: ResumeWritePacket,
) {
  const baseName = createArtifactBaseName(context.input.company);
  const isRevision = packet.revisionRound > 1;
  const structuredContent = Boolean(packet.originalResume);
  const legacyRevision = isRevision && !packet.currentDocument && ["stub", "replay"].includes(context.agentBindings.writer.mode ?? "live");
  if (structuredContent && !legacyRevision && (packet.writingMode !== (isRevision ? "role-tailored-rewrite" : "initial-draft")
    || (isRevision && (!packet.currentDocument || !packet.optimizationDecision || !packet.reviewReport))
    || (!isRevision && packet.optimizationDecision))) throw new Error("Writer mode conflicts with its draft/revision context.");
  context.state.lastWriteNoOp = false;
  const baseAction = isRevision ? `resume-revise-${packet.revisionRound}` : "resume-write";
  const buildWriterCall = (action: string, retryContext: { parseError: string; invalidResponse: string } | undefined) => {
    const rawResponses: Array<{ path: string; absolutePath: string }> = [];
    const call = executeAgent(
      context,
      "writer",
      "write",
      action,
      wrapResumeWritePrompt(
        toJsonText({
          ...packet,
          previousParseError: retryContext?.parseError ?? null,
          previousInvalidResponse: retryContext?.invalidResponse ?? null,
        }),
        isRevision,
        packet.optimizationDecision?.action,
        structuredContent,
        retryContext,
      ),
      isRevision
        ? "revise resume from review feedback"
        : "draft initial tailored resume",
      { onRawResponse: (record) => rawResponses.push(record) },
    );
    return { call, rawResponses };
  };

  const first = buildWriterCall(baseAction, undefined);
  let firstResponsePath: string | null = null;
  let resumeText = "";
  let validatedResume: string;
  try {
    resumeText = await first.call;
    firstResponsePath = first.rawResponses[0]?.path ?? null;
    validatedResume = cleanAndValidateYaml(resumeText, "Writer output");
  } catch (error) {
    // R 批次有限例外（Codex 裁定）：仅 live 模式 Writer 响应出现 YAML 语法错误时，
    // 同一次初稿/修订内允许一次显式、可审计的重试；合同/事实/越权校验失败不触发。
    const retryable = isYamlSyntaxError(error)
      && (context.agentBindings.writer.mode ?? "live") === "live";
    if (!retryable) throw error;
    const parseError = error instanceof Error ? error.message : String(error);
    const retryAction = isRevision ? `${baseAction}-yaml-retry-1` : "resume-write-yaml-retry-1";
    const responseSequence = firstResponsePath?.match(/raw-response-(\d+)\.txt$/)?.[1] ?? "unknown";
    const intent: Record<string, unknown> = {
      stage: "write",
      reason: "live-writer-yaml-syntax-retry",
      originalAction: baseAction,
      retryAction,
      revisionRound: packet.revisionRound,
      attempt: 1,
      maxAttempts: 2,
      parseError,
      invalidResponsePath: firstResponsePath,
      candidateVersion: context.state.currentResumeArtifact
        ? context.state.candidateVersions[context.state.currentResumeArtifact.absolutePath] ?? null
        : null,
      evidenceVersion: context.state.evidenceVersion,
      result: "pending",
    };
    const registerRetryAudit = (payload: Record<string, unknown>, suffix: string) => registerArtifact(
      context,
      { kind: "log", fileName: `${baseName}.writer.format-retry.${baseAction}.${responseSequence}${suffix}.json`, generator: "rolepilot-engine", stage: "supporting" },
      toJsonText(payload),
    );
    // 第二次调用前先登记重试意图。
    registerRetryAudit(intent, "");
    const retry = buildWriterCall(retryAction, { parseError, invalidResponse: resumeText });
    let retryText = "";
    try {
      retryText = await retry.call;
      intent.retryResponsePath = retry.rawResponses[0]?.path ?? null;
      validatedResume = cleanAndValidateYaml(retryText, "Writer output");
    } catch (retryError) {
      registerRetryAudit({ ...intent, result: "failed", failureReason: retryError instanceof Error ? retryError.message : String(retryError) }, ".result");
      throw retryError;
    }
    registerRetryAudit({ ...intent, result: "recovered" }, ".result");
  }
  const value = YAML.parse(validatedResume);
  if ((context.agentBindings.writer.mode ?? "live") === "live" || packet.currentDocument || value?.schemaVersion === 3 || Array.isArray(value?.operations)) {
    let content: ResumeContentV3;
    if (isRevision) {
      if (!packet.currentDocument || !packet.optimizationDecision) throw new Error("Structured revision requires a current document and Router-approved decision.");
      const result = applyResumeOperations(packet.currentDocument, value);
      if (packet.optimizationDecision.action === "REORDER" && value.operations.some((op: any) => !["reorder", "move"].includes(op.op))) throw new Error("REORDER cannot change content.");
      if (packet.optimizationDecision.action === "DROP_UNSUPPORTED_CLAIM" && value.operations.some((op: any) => !["delete", "update", "updateProfile"].includes(op.op))) throw new Error("DROP requires explicit deletion or narrowing updates.");
      registerArtifact(context, { kind: "log", fileName: `${baseName}.operations.proposal-${context.state.actionHistory.length + 1}.json`, generator: "writer", stage: "supporting" }, toJsonText({ proposal: value, changed: result.changed, localIds: result.localIds }));
      if (!result.changed) {
        context.state.lastWriteNoOp = true;
        return requireResume(context);
      }
      content = result.content;
    } else {
      if (!packet.originalResume) throw new Error("Structured initial draft requires a frozen original resume.");
      content = materializeInitialCandidate(value, packet.originalResume, packet.documentId);
    }
    if (!packet.originalResume) throw new Error("Candidate has no frozen source document.");
    const supplementedProjectFacts = ensureStructuredProjectFacts(content, packet.structuredEvidenceFacts);
    if (supplementedProjectFacts) {
      registerArtifact(context, {
        kind: "log",
        fileName: `${baseName}.writer.structured-facts-${context.state.candidateVersions[context.state.currentResumeArtifact?.absolutePath ?? ""] ?? 0}.json`,
        generator: "rolepilot-engine",
        stage: "supporting",
      }, toJsonText({ policy: "accepted-structured-facts-required", supplementedProjectFacts }));
    }
    assertSourceBackedIdentity(content, packet.originalResume, packet.currentDocument, packet.sourceText ?? "", packet.evidenceCatalog.userAnswers ?? "",
      context.state.answerInterpretations.flatMap((entry) => entry.corrections));
    const sourceCorpus = [
      packet.sourceText,
      packet.supplementalEvidenceText,
      packet.evidenceCatalog.userAnswers,
      ...packet.structuredEvidenceFacts.flatMap((fact) => [fact.fact, fact.sourceQuote]),
    ].filter((value): value is string => Boolean(value?.trim())).join("\n");
    assertSourceBackedBulletContent(content, sourceCorpus);
    const version = Math.max(0, ...Object.values(context.state.candidateVersions)) + 1;
    const record = registerArtifact(context, { kind: "resume", fileName: `${baseName}.resume.candidate-${version}.json`, generator: "writer", stage: "draft" }, toJsonText(content));
    context.state.candidateVersions[record.absolutePath] = version;
    context.state.currentResumeArtifact = record;
    persistMemory(context);
    return record;
  }
  // Historical offline recordings retain their original YAML contract only.
  const mergedResume = isRevision && packet.previousResumeText
    ? mergeEditableResumeYaml(
        packet.previousResumeText,
        validatedResume,
        packet.optimizationDecision?.action,
        packet.optimizationDecision?.target,
      )
    : validatedResume;
  const record = registerArtifact(
    context,
    {
      kind: "resume",
      fileName: isRevision
        ? `${baseName}.resume.round-${packet.revisionRound}.yml`
        : `${baseName}.resume.yml`,
      generator: "writer",
      stage: "draft",
    },
    mergedResume,
  );
  context.state.currentResumeArtifact = record;
  persistMemory(context);
  return record;
}

export async function reviseResumeFromReview(
  context: ResumeSliceContext,
  packet: ResumeWritePacket,
  reviewReport: Record<string, unknown>,
) {
  return writeResumeDraft(context, {
    ...packet,
    reviewReport,
  });
}

export async function runWriteStep(
  context: ResumeSliceContext,
  options: ResumeWriteStepOptions = {},
) {
  requireTimeline(context);
  const packet = buildResumeWritePacket(context, {
    revisionRound: options.revisionRound,
    reviewReport: options.reviewReport,
    optimizationDecision: options.optimizationDecision,
  });
  if (options.reviewReport) {
    return reviseResumeFromReview(context, packet, options.reviewReport);
  }
  return writeResumeDraft(context, packet);
}

export async function evaluateResumeOnce(
  context: ResumeSliceContext,
  input: {
    currentResume: ReturnType<typeof requireResume>;
    round: number;
  },
): Promise<ResumeReviewEvaluation> {
  const timeline = requireTimeline(context);
  const jdAnalysis = context.state.jdAnalysisArtifact;
  if (!jdAnalysis) {
    throw new Error(
      "Resume review requires JD analysis context. Run JD analysis before review.",
    );
  }

  const timelineText = fs.readFileSync(timeline.absolutePath, "utf8");
  const jdAnalysisText = fs.readFileSync(jdAnalysis.absolutePath, "utf8");
  const previousAction = context.state.actionHistory.at(-1)?.decision ?? null;
  const previousReview = context.state.reviewPolicyState.lastReviewReport ?? null;
  const candidateDocument = readV3Resume(input.currentResume.absolutePath);
  const candidateVersion = context.state.candidateVersions[input.currentResume.absolutePath] ?? null;
  const buildReviewCall = (
    action: string,
    retryContext: { parseError: string; invalidResponse: string } | undefined,
  ) => {
    const rawResponses: Array<{ path: string; absolutePath: string }> = [];
    const call = executeAgent(
      context,
      "reviewer",
      "review",
      action,
      wrapReviewPrompt(toJsonText({
        ...questionAllowance(context),
        ...buildSourceMaterials(context),
        safeWritingScope: context.state.safeWritingScope,
        preflightDecision: context.state.preflightDecision,
        company: context.input.company,
        resumePath: input.currentResume.absolutePath,
        resumeText: fs.readFileSync(input.currentResume.absolutePath, "utf8"),
        timelinePath: timeline.absolutePath,
        timelineText,
        jdText: context.input.jdText ?? null,
        jdAnalysisPath: jdAnalysis.absolutePath,
        jdAnalysisText,
        round: input.round,
        previousReview,
        previousAction,
        candidateVersion,
        documentId: candidateDocument?.documentId ?? null,
        candidateNodeIds: candidateDocument ? [...indexResumeNodes(candidateDocument).keys()] : [],
        evidenceVersion: context.state.evidenceVersion,
        previousBindings: Object.values(context.state.reviewBindings),
        previousParseError: retryContext?.parseError ?? null,
        previousInvalidResponse: retryContext?.invalidResponse ?? null,
      }), Boolean(candidateDocument), retryContext),
      `review resume round ${input.round}`,
      { onRawResponse: (record) => rawResponses.push(record) },
    );
    return { call, rawResponses };
  };

  const firstAction = `review-round-${input.round}`;
  const first = buildReviewCall(firstAction, undefined);
  let firstResponsePath: string | null = null;
  let reviewText = "";
  let response: ReturnType<typeof parseReviewReport>;
  let formatRetryAudit: Record<string, unknown> | undefined;
  try {
    reviewText = await first.call;
    firstResponsePath = first.rawResponses[0]?.path ?? null;
    response = parseReviewReport(reviewText);
  } catch (error) {
    // R1 有界例外（Codex 裁定）：仅 live 模式、v3 候选、且首次响应为 JSON 语法错误时，
    // 同一轮允许一次显式、可审计的重试；合同/绑定校验失败与 stub/replay 不触发。
    const retryable = isJsonSyntaxError(error)
      && context.agentBindings.reviewer.mode === "live"
      && Boolean(candidateDocument);
    if (!retryable) throw error;
    const parseError = error instanceof Error ? error.message : String(error);
    const retryAction = `${firstAction}-json-retry-1`;
    formatRetryAudit = {
      stage: "review",
      reason: "live-review-json-syntax-retry",
      round: input.round,
      attempt: 1,
      parseError,
      candidatePath: input.currentResume.absolutePath,
      candidateVersion,
      evidenceVersion: context.state.evidenceVersion,
      invalidResponsePath: firstResponsePath,
      retryAction,
    };
    const retry = buildReviewCall(retryAction, { parseError, invalidResponse: reviewText });
    try {
      reviewText = await retry.call;
      formatRetryAudit.retryResponsePath = retry.rawResponses[0]?.path ?? null;
      response = parseReviewReport(reviewText);
    } catch (retryError) {
      registerArtifact(
        context,
        { kind: "log", fileName: `${createArtifactBaseName(context.input.company)}.review.format-retry.round-${input.round}.json`, generator: "rolepilot-engine", stage: "supporting" },
        toJsonText({ ...formatRetryAudit, result: "failed", failureReason: retryError instanceof Error ? retryError.message : String(retryError) }),
      );
      throw retryError;
    }
    formatRetryAudit.result = "recovered";
    registerArtifact(
      context,
      { kind: "log", fileName: `${createArtifactBaseName(context.input.company)}.review.format-retry.round-${input.round}.json`, generator: "rolepilot-engine", stage: "supporting" },
      toJsonText(formatRetryAudit),
    );
  }
  if (candidateDocument && (!response.report || typeof response.report !== "object" || Array.isArray(response.report)
    || !Array.isArray(response.issueTargets) || Object.keys(response).some((key) => !["report", "issueTargets"].includes(key)))) {
    throw new Error("Review of a v3 candidate requires exactly report and issueTargets.");
  }
  let report = response.report && typeof response.report === "object" && !Array.isArray(response.report)
    ? response.report as Record<string, unknown> : response;
  const sectionNormalization = normalizeReviewSectionValues(report);
  if (sectionNormalization.changes.length > 0) {
    // 归一化审计必须在合同校验前登记，即使后续校验失败也留有记录。
    registerArtifact(context, { kind: "log", fileName: `${createArtifactBaseName(context.input.company)}.review.section-normalization.round-${input.round}.json`, generator: "rolepilot-engine", stage: "supporting" }, toJsonText({
      rule: "review-section-overall-normalization",
      round: input.round,
      changes: sectionNormalization.changes,
      report: sectionNormalization.report,
    }));
    report = sectionNormalization.report;
  }
  const isReplay = context.agentBindings.reviewer.mode === "replay";
  validateReviewReport(report, context.input.env, {
    allowLegacy: isReplay && !candidateDocument,
    strict: !isReplay || Boolean(candidateDocument),
  });
  const document = readV3Resume(input.currentResume.absolutePath);
  if (document && response !== report) {
    const nodeIndex = indexResumeNodes(document);
    const targetChanges: Array<{ issueRef: unknown; from: string; to: { nodeId: string } }> = [];
    for (const item of Array.isArray(response.issueTargets) ? response.issueTargets : []) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const normalized = normalizeOptimizationTargetNode({ targetNode: item.target }, nodeIndex);
      if (!normalized.change) continue;
      item.target = normalized.change.to;
      targetChanges.push({ issueRef: item.issueRef, ...normalized.change });
    }
    if (targetChanges.length > 0) {
      registerArtifact(context, { kind: "log", fileName: `${createArtifactBaseName(context.input.company)}.review.target-normalization.round-${input.round}.json`, generator: "rolepilot-engine", stage: "supporting" }, toJsonText({
        rule: "review-target-bare-string-wrapping",
        round: input.round,
        documentId: document.documentId,
        candidateVersion,
        evidenceVersion: context.state.evidenceVersion,
        changes: targetChanges,
      }));
    }
    // 绑定 ID 前缀纠正必须在严格绑定校验前登记审计。
    const bindingChanges = Array.isArray(response.issueTargets)
      ? normalizeIssueTargetNodeIds(response.issueTargets.filter((item) => item && typeof item === "object" && !Array.isArray(item)) as Array<Record<string, unknown>>, document)
      : [];
    if (bindingChanges.length > 0) {
      registerArtifact(context, { kind: "log", fileName: `${createArtifactBaseName(context.input.company)}.review.binding-normalization.round-${input.round}.json`, generator: "rolepilot-engine", stage: "supporting" }, toJsonText({
        rule: "review-binding-document-prefix-correction",
        round: input.round,
        documentId: document.documentId,
        candidateVersion,
        evidenceVersion: context.state.evidenceVersion,
        changes: bindingChanges,
      }));
    }
  }
  if (document) parseReviewBinding(response.issueTargets, document, report, {
    documentId: document.documentId, candidateVersion: context.state.candidateVersions[input.currentResume.absolutePath],
    evidenceVersion: context.state.evidenceVersion, reviewArtifactPath: "pending-validation",
  });
  const reviewArtifact = persistReviewReport(context, report, input.round);
  let binding: ReviewBinding | undefined;
  if (response !== report) {
    if (!document || Object.keys(response).some((key) => !["report", "issueTargets"].includes(key))) throw new Error("Review envelope requires a v3 candidate, report and issueTargets only.");
    binding = parseReviewBinding(response.issueTargets, document, report, {
      documentId: document.documentId, candidateVersion: context.state.candidateVersions[input.currentResume.absolutePath],
      evidenceVersion: context.state.evidenceVersion, reviewArtifactPath: reviewArtifact.path,
    });
    context.state.reviewBindings[reviewArtifact.absolutePath] = binding;
    const bindingArtifact = registerArtifact(context, { kind: "log", fileName: `${createArtifactBaseName(context.input.company)}.review-binding.round-${input.round}.json`, generator: "rolepilot-engine", stage: "supporting" }, toJsonText(binding));
    context.state.reviewBindingArtifactPaths[reviewArtifact.absolutePath] = bindingArtifact.absolutePath;
  } else if (document) {
    throw new Error("Review of a v3 candidate must return report and issueTargets in the same call.");
  }
  return {
    currentResume: input.currentResume,
    report,
    reviewArtifact,
    binding,
  };
}

export function persistReviewReport(
  context: ResumeSliceContext,
  report: Record<string, unknown>,
  round: number,
) {
  const baseName = createArtifactBaseName(context.input.company);
  return registerArtifact(
    context,
    {
      kind: "review-report",
      fileName: `${baseName}.review.round-${round}.json`,
      generator: "reviewer",
      stage: "draft",
    },
    toJsonText(report),
  );
}

export function selectBestResumeByReviewPolicy(
  context: ResumeSliceContext,
  policyRound: ReturnType<typeof applyReviewPolicyRound>,
  evaluation: ResumeReviewEvaluation,
) {
  context.state.reviewPolicyState = policyRound.state;
  context.state.reviewRoundsUsed = policyRound.decision.round;
  context.state.consecutiveNoProgressActions =
    policyRound.state.noProgressStreak;
  context.state.stopReason = policyRound.decision.stopReason;
  if (
    policyRound.decision.bestResumePath ===
    evaluation.currentResume.absolutePath
  ) {
    context.state.bestResumeArtifact = evaluation.currentResume;
  }
  if (
    policyRound.decision.bestReviewPath ===
    evaluation.reviewArtifact.absolutePath
  ) {
    context.state.bestReviewArtifact = evaluation.reviewArtifact;
    if (context.state.optimizationActionsUsed > 0) {
      context.state.bestOptimizationReviewArtifact =
        evaluation.reviewArtifact;
    }
  }
}

function readRecordField(
  value: unknown,
  field: string,
): unknown {
  return value && typeof value === "object" && !Array.isArray(value)
    ? Reflect.get(value, field)
    : undefined;
}

function getReviewVerdict(report: Record<string, unknown>) {
  if (report.schemaVersion === 2) {
    return typeof report.verdict === "string" ? report.verdict : null;
  }
  const verdict = readRecordField(report.overall, "verdict");
  return typeof verdict === "string" ? verdict : null;
}

function createNeedRoleInfoDecision(
  report: Record<string, unknown>,
): OptimizationDecision {
  const roleInfoQuestion = report.schemaVersion === 2
    ? report.roleInfoQuestion
    : readRecordField(report.industryRoleCheck, "blockingIssue");
  const rawQuestion = typeof roleInfoQuestion === "string" && roleInfoQuestion.trim()
    ? roleInfoQuestion.trim()
    : "补充目标岗位名称及 JD 中最重要的职责或要求。";
  const question = rawQuestion.startsWith("请确认") || rawQuestion.startsWith("请补充")
    ? rawQuestion
    : `请确认：${rawQuestion}`;

  if (isForbiddenQualificationQuestion(question)) {
    return {
      action: "STOP",
      target: null,
      reason: "Review produced a forbidden qualification question; continue only with existing role and source facts.",
      evidenceRefs: [],
      expectedImprovement: "Avoid publishing or spending question budget on qualification checks.",
      risk: "low",
    };
  }
  if (!isRoleInfoQuestion(question)) {
    return {
      action: "STOP",
      target: null,
      reason: "Review NEED_ROLE_INFO question is not about the target role or JD; continue only with existing role and source facts.",
      evidenceRefs: [],
      expectedImprovement: "Avoid asking for candidate facts through the role-information branch.",
      risk: "low",
    };
  }

  return {
    action: "ASK_USER",
    target: question,
    reason: "The review verdict is NEED_ROLE_INFO and writing must pause.",
    evidenceRefs: [],
    expectedImprovement:
      "Verified user evidence can establish a safe target-role writing boundary.",
    risk: "medium",
  };
}

export function persistOptimizationDecision(
  context: ResumeSliceContext,
  decision: OptimizationDecision,
  sequence: number,
) {
  const baseName = createArtifactBaseName(context.input.company);
  return registerArtifact(
    context,
    {
      kind: "optimization-decision",
      fileName: `${baseName}.optimization.decision-${sequence}.json`,
      generator: "reviewer",
      stage: "draft",
    },
    toJsonText(decision),
  );
}

export type ProposalRejectionContext = {
  reasonCodes: string[];
  rejectedAction: string;
  rejectedTarget: string | null;
  rejectedReason: string;
};

function projectRewriteIssue(
  context: ResumeSliceContext,
  evaluation: ResumeReviewEvaluation,
) {
  const issues = Array.isArray(evaluation.report.topIssues)
    ? evaluation.report.topIssues as Array<Record<string, unknown>>
    : [];
  const binding = evaluation.binding;
  if (!binding) return null;
  const alreadyHandled = new Set(context.state.actionHistory
    .filter((entry) => ["executed", "no-op"].includes(entry.status))
    .map((entry) => entry.decision.issueKey)
    .filter((key): key is string => Boolean(key)));
  for (const issue of issues) {
    const resolution = readRecordField(issue, "resolution");
    if (resolution !== "REWRITE_NOW") continue;
    const description = ["section", "problem", "recommendedAction", "whyItHurts"]
      .map((field) => readRecordField(issue, field))
      .filter((value): value is string => typeof value === "string")
      .join(" ");
    if (!/(项目|科研|project|research)/iu.test(description)) continue;
    const issueRef = readRecordField(issue, "issueRef");
    const issueBinding = binding.issueTargets.find((item) => item.issueRef === issueRef);
    if (!issueBinding || alreadyHandled.has(issueBinding.issueKey)) continue;
    const evidenceRefs = issueBinding.target && "nodeId" in issueBinding.target
      && buildSourceMaterials(context).evidenceCatalog[`original:${issueBinding.target.nodeId}`]
      ? [`original:${issueBinding.target.nodeId}`]
      : buildSourceMaterials(context).evidenceCatalog.userAnswers
        ? ["userAnswers"] : ["sourceText"];
    return {
      issue,
      issueBinding,
      decision: {
        action: "REWRITE_SECTION" as const,
        target: "项目经历",
        reason: `${String(issueRef)}：${String(readRecordField(issue, "recommendedAction") ?? readRecordField(issue, "problem") ?? "重组项目经历" )}`,
        evidenceRefs,
        expectedImprovement: String(readRecordField(issue, "whyItHurts") ?? "提升项目经历中的本人贡献、方法与产出表达。"),
        risk: "low" as const,
        issueRef: String(issueRef),
        issueKey: issueBinding.issueKey,
        targetNode: issueBinding.target,
        evidenceVersion: context.state.evidenceVersion,
        restrictionRefs: [],
      } satisfies OptimizationDecision,
    };
  }
  return null;
}

export async function decideOptimizationAction(
  context: ResumeSliceContext,
  input: {
    evaluation: ResumeReviewEvaluation;
    sequence: number;
    remainingBudget: number;
    rejection?: ProposalRejectionContext | null;
  },
) {
  let decision: OptimizationDecision;
  if (!input.evaluation.binding && ["stub", "replay"].includes(context.agentBindings.reviewer.mode ?? "live") && getReviewVerdict(input.evaluation.report) === "NEED_ROLE_INFO") {
    decision = createNeedRoleInfoDecision(input.evaluation.report);
  } else {
    const decisionText = await executeAgent(
      context,
      "reviewer",
      "review",
      `optimization-decision-${input.sequence}`,
      wrapOptimizationDecisionPrompt(
        toJsonText({
          ...buildSourceMaterials(context),
          ...questionAllowance(context),
          reviewReport: input.evaluation.report,
          reviewBinding: input.evaluation.binding ?? null,
          reviewEvidenceVersion: input.evaluation.binding?.evidenceVersion ?? null,
          currentDocument: readV3Resume(input.evaluation.currentResume.absolutePath),
          evidenceVersion: context.state.evidenceVersion,
          currentResumePath: input.evaluation.currentResume.absolutePath,
          currentReviewPath: input.evaluation.reviewArtifact.absolutePath,
          preflightDecision: context.state.preflightDecision,
          eligibilityNotes: context.state.preflightDecision?.eligibilityNotes ?? [],
          safeWritingScope: context.state.safeWritingScope,
          actionHistory: context.state.actionHistory.map((entry) => ({
            action: entry.decision.action,
            target: entry.decision.target,
            status: entry.status,
            issueKey: entry.decision.issueKey,
            targetNode: entry.decision.targetNode,
            evidenceVersion: entry.decision.evidenceVersion,
          })),
          remainingBudget: input.remainingBudget,
          previousProposalRejection: input.rejection ?? null,
        }),
      ),
      `select optimization action ${input.sequence}`,
    );
    const parsedDecision = parseOptimizationDecision(decisionText);
    const candidateDocumentForDecision = readV3Resume(input.evaluation.currentResume.absolutePath);
    const nodeIndexForDecision = candidateDocumentForDecision ? indexResumeNodes(candidateDocumentForDecision) : null;
    const normalizedDecision = normalizeOptimizationTargetNode(parsedDecision, nodeIndexForDecision);
    if (normalizedDecision.change) {
      // 封装审计必须在严格校验前登记，即使后续校验失败也留有记录。
      registerArtifact(context, { kind: "log", fileName: `${createArtifactBaseName(context.input.company)}.optimization.targetnode-normalization-${input.sequence}.json`, generator: "rolepilot-engine", stage: "supporting" }, toJsonText({
        rule: "optimization-targetnode-bare-string-wrapping",
        sequence: input.sequence,
        action: normalizedDecision.decision.action,
        issueRef: normalizedDecision.decision.issueRef ?? null,
        documentId: candidateDocumentForDecision?.documentId ?? null,
        ...normalizedDecision.change,
      }));
    }
    decision = validateOptimizationDecisionPayload(
      normalizedDecision.decision,
      { structuredContent: Boolean(input.evaluation.binding), allowLegacy: !input.evaluation.binding && ["stub", "replay"].includes(context.agentBindings.reviewer.mode ?? "live") },
    );
    const projectIssue = projectRewriteIssue(context, input.evaluation);
    if (projectIssue && (decision.action !== "REWRITE_SECTION" || decision.target !== "项目经历")) {
      const modelDecision = decision;
      decision = projectIssue.decision;
      registerArtifact(context, { kind: "log", fileName: `${createArtifactBaseName(context.input.company)}.optimization.project-priority-override-${input.sequence}.json`, generator: "rolepilot-engine", stage: "supporting" }, toJsonText({
        reason: "project-rewrite-is-independent-high-value-target",
        modelDecision,
        selectedDecision: decision,
      }));
    }
    const restrictions = context.state.preflightDecision?.unsupportedTargets ?? [];
    if (input.evaluation.binding && restrictions.length && !["ASK_USER", "PASS", "STOP"].includes(decision.action) && !decision.restrictionRefs) throw new Error("Optimization requires semantic restrictionRefs for the current restrictions.");
    if (decision.restrictionRefs?.some((reference) => !restrictions.includes(reference))) throw new Error("Optimization restrictionRefs must reference current restrictions.");
    if (decision.questionProposal && questionAllowance(context).canAskUser) {
      const screening = await screenQuestionCandidates(context, [decision.questionProposal], "review", buildSourceMaterials(context));
      if (screening.allowed[0]) decision.questionProposal = screening.allowed[0];
      else {
        // Keep the classified candidate so the Router rejects this proposal and
        // uses the existing bounded reselection path instead of publishing it.
        const rejected = screening.filtered[0]?.candidate;
        if (rejected) decision.questionProposal = rejected;
      }
    }
  }

  return {
    decision,
    decisionArtifact: persistOptimizationDecision(
      context,
      decision,
      input.sequence,
    ),
  };
}

function resolveOptimizationLimits(context: ResumeSliceContext) {
  const maxRounds = context.input.maxReviewRounds ?? 3;
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new Error("maxReviewRounds must be a positive integer.");
  }
  const maxActions =
    context.input.maxOptimizationActions ??
    context.input.reviewReplanBudget ??
    Math.max(0, maxRounds - 1);
  if (!Number.isInteger(maxActions) || maxActions < 0) {
    throw new Error("maxOptimizationActions must be a non-negative integer.");
  }
  return { maxRounds, maxActions };
}

function createActionHistoryEntry(input: {
  sequence: number;
  decision: OptimizationDecision;
  decisionPath: string;
  route: OptimizationActionHistoryEntry["route"];
  status: OptimizationActionHistoryEntry["status"];
  candidateResumePath?: string | null;
  sourceReviewPath: string;
  rejectedReason?: string | null;
}): OptimizationActionHistoryEntry {
  return {
    sequence: input.sequence,
    decision: input.decision,
    decisionPath: input.decisionPath,
    route: input.route,
    status: input.status,
    candidateResumePath: input.candidateResumePath ?? null,
    sourceReviewPath: input.sourceReviewPath,
    resultReviewPath: null,
    rejectedReason: input.rejectedReason ?? null,
  };
}

function linkReReviewToPreviousAction(
  context: ResumeSliceContext,
  evaluation: ResumeReviewEvaluation,
) {
  const previous = context.state.actionHistory.at(-1);
  if (
    previous?.status === "executed" &&
    previous.resultReviewPath === null &&
    previous.candidateResumePath === evaluation.currentResume.absolutePath
  ) {
    previous.resultReviewPath = evaluation.reviewArtifact.absolutePath;
  }
}

const MAX_PROPOSAL_ATTEMPTS_PER_REVIEW = 2;

function hasFactRisk(report: Record<string, unknown>) {
  return Array.isArray(report.topIssues) && report.topIssues.some((issue) => readRecordField(issue, "category") === "UNSUPPORTED_CLAIM");
}

function sanitizeBoundFactRisks(
  context: ResumeSliceContext,
  candidate: ResumeContentV3,
  report: Record<string, unknown>,
  reviewPath: string,
) {
  const binding = context.state.reviewBindings[reviewPath];
  if (!binding || !Array.isArray(report.topIssues)) return { content: candidate, repaired: [] as string[] };
  const nodes = indexResumeNodes(candidate);
  const repaired: string[] = [];
  for (const issue of report.topIssues as Array<Record<string, unknown>>) {
    if (readRecordField(issue, "category") !== "UNSUPPORTED_CLAIM") continue;
    const issueRef = readRecordField(issue, "issueRef");
    const target = binding.issueTargets.find((item) => item.issueRef === issueRef)?.target;
    if (!target) continue;
    if ("profileField" in target && target.profileField === "headline") {
      const headline = candidate.profile.headline;
      if (/本科生/iu.test(headline)) {
        candidate.profile.headline = headline.replaceAll("本科生", "本科背景");
        repaired.push(String(issueRef));
      }
      continue;
    }
    if ("nodeId" in target) {
      const ref = nodes.get(target.nodeId);
      if (!ref) continue;
      if (ref.node.type === "text" && typeof ref.node.content === "string" && /本科生/iu.test(ref.node.content)) {
        ref.node.content = ref.node.content.replaceAll("本科生", "本科背景");
        repaired.push(String(issueRef));
      }
    }
  }
  return { content: parseResumeContentV3(candidate), repaired };
}

function targetedCandidateImprovement(context: ResumeSliceContext, evaluation: ResumeReviewEvaluation): boolean | undefined {
  const best = context.state.reviewPolicyState.bestReviewReport as Record<string, unknown> | null;
  if (!best) return undefined;
  if (hasFactRisk(best) !== hasFactRisk(evaluation.report)) return !hasFactRisk(evaluation.report);
  const previous = context.state.actionHistory.at(-1);
  if (!previous?.decision.issueKey || !evaluation.binding) return undefined;
  const sourceBinding = context.state.reviewBindings[previous.sourceReviewPath];
  if (!sourceBinding || sourceBinding.evidenceVersion !== evaluation.binding.evidenceVersion) return undefined;
  const remained = evaluation.binding.issueTargets.some((issue) => issue.issueKey === previous.decision.issueKey
    && JSON.stringify(issue.target) === JSON.stringify(previous.decision.targetNode));
  const sourceReport = parseJsonObject(fs.readFileSync(previous.sourceReviewPath, "utf8"), "Source review");
  const riskKeys = (report: Record<string, unknown>, binding: ReviewBinding) => new Set(binding.issueTargets
    .filter((b) => (report.topIssues as Record<string, unknown>[]).some((issue) => issue.issueRef === b.issueRef && issue.category === "UNSUPPORTED_CLAIM"))
    .map((b) => JSON.stringify([b.issueKey, b.target])));
  const priorRisk = riskKeys(sourceReport, sourceBinding);
  const newRisk = [...riskKeys(evaluation.report, evaluation.binding)].some((key) => !priorRisk.has(key));
  if (newRisk) return false;
  if (!remained && Number(evaluation.report.overallScore) >= Number(best.overallScore)) return true;
  return undefined;
}

function validSelectedBinding(context: ResumeSliceContext, evaluation: ResumeReviewEvaluation, decision: OptimizationDecision) {
  if (!evaluation.binding || ["PASS", "STOP", "ASK_USER"].includes(decision.action)) return true;
  const binding = evaluation.binding.issueTargets.find((item) => item.issueRef === decision.issueRef);
  const catalog = buildSourceMaterials(context).evidenceCatalog;
  const validEvidence = !["REWRITE_SECTION", "KEYWORD_OPTIMIZE"].includes(decision.action)
    || (decision.evidenceRefs.length > 0 && decision.evidenceRefs.every((ref) => Boolean(catalog[ref]?.trim())));
  return Boolean(validEvidence && binding && binding.issueKey === decision.issueKey
    && JSON.stringify(binding.target) === JSON.stringify(decision.targetNode)
    && evaluation.binding.evidenceVersion === context.state.evidenceVersion
    && decision.evidenceVersion === context.state.evidenceVersion);
}

function getSelectionEvaluation(
  context: ResumeSliceContext,
  evaluation: ResumeReviewEvaluation,
  policyRound: ReturnType<typeof applyReviewPolicyRound>,
) {
  if (
    policyRound.decision.bestResumePath ===
    evaluation.currentResume.absolutePath
  ) {
    return evaluation;
  }

  const bestResume = context.state.bestResumeArtifact;
  const bestReview = context.state.bestReviewArtifact;
  const bestReport = context.state.reviewPolicyState.bestReviewReport;
  if (
    !bestResume ||
    !bestReview ||
    !bestReport ||
    typeof bestReport !== "object" ||
    Array.isArray(bestReport)
  ) {
    throw new Error(
      "Review policy retained a Best candidate without its resume and review artifacts.",
    );
  }

  context.state.reviewPolicyState = {
    ...context.state.reviewPolicyState,
    lastScore: context.state.reviewPolicyState.bestScore,
    lastSignal: context.state.reviewPolicyState.bestSignal,
    lastReviewReport: bestReport,
    lastReviewPath: bestReview.absolutePath,
  };
  context.state.currentResumeArtifact = bestResume;
  return {
    currentResume: bestResume,
    report: bestReport as Record<string, unknown>,
    reviewArtifact: bestReview,
    binding: context.state.reviewBindings[bestReview.absolutePath],
  };
}

function hasRejectedReason(
  context: ResumeSliceContext,
  reasonCode: OptimizationActionHistoryEntry["route"]["reasonCodes"][number],
) {
  return context.state.actionHistory.some((entry) =>
    entry.route.reasonCodes.includes(reasonCode),
  );
}

function stopAfterRouterRejection(
  context: ResumeSliceContext,
  reasonCodes: string[],
  reselectionExhausted: boolean,
) {
  context.state.stopReason = "optimization-router-rejected";
  context.state.optimizationStopReason =
    reasonCodes.includes("QUESTION_BUDGET_EXHAUSTED") ||
    hasRejectedReason(context, "QUESTION_BUDGET_EXHAUSTED")
      ? "question-budget-exhausted-source-facts"
      : reselectionExhausted
        ? "proposal-reselection-exhausted"
        : reasonCodes[0] ?? "router-rejected";
}

async function resumePendingReviewAction(
  context: ResumeSliceContext,
  maxActions: number,
) {
  const pending = context.state.pendingReviewAction;
  if (!pending) return { currentResume: requireResume(context), shouldReview: true };
  context.state.pendingReviewAction = null;

  const currentResume = requireResume(context);
  if (currentResume.absolutePath !== pending.sourceResumePath) {
    throw new Error("Pending review action source resume does not match restored Best candidate.");
  }
  if (context.state.optimizationActionsUsed >= maxActions) {
    context.state.optimizationStopReason = "action-budget-exhausted";
    context.state.stopReason = "action-budget-exhausted";
    persistMemory(context);
    return { currentResume, shouldReview: false };
  }

  const sourceReview = context.state.bestReviewArtifact;
  if (!sourceReview || sourceReview.absolutePath !== pending.sourceReviewPath) {
    throw new Error("Pending review action is missing its restored source review artifact.");
  }
  context.state.optimizationStopReason = null;
  context.state.stopReason = null;
  recordOptimizationTelemetry(context, "selected", "answer applied; retain pending proposal as history and reselect against unchanged Best and current evidence");
  persistMemory(context);
  return { currentResume, shouldReview: false };
}

export async function runReviewStep(context: ResumeSliceContext) {
  let currentResume = requireResume(context);
  requireTimeline(context);
  if (!context.state.jdAnalysisArtifact) {
    throw new Error(
      "Resume review requires JD analysis context. Run JD analysis before review.",
    );
  }
  context.state.finalResumeArtifact = null;
  context.state.workbenchDeliveryArtifact = null;
  context.state.deliveryStatus = null;
  context.state.finalReviewPath = null;
  context.state.interviewArtifact = null;
  context.state.cheatsheetArtifact = null;
  context.state.interviewSourceResumePath = null;
  context.state.cheatsheetSourceResumePath = null;
  const baseName = createArtifactBaseName(context.input.company);
  const { maxRounds, maxActions } = resolveOptimizationLimits(context);

  const isReviewResume = context.state.resumedFromCheckpoint && Boolean(context.state.pendingReviewAction);
  if (!isReviewResume) {
    context.state.reviewPolicyState = createReviewPolicyState({
      initialResumePath: currentResume.absolutePath,
      maxRounds,
    });
    context.state.consecutiveNoProgressActions = 0;
  }
  if (isReviewResume) {
    const resumed = await resumePendingReviewAction(context, maxActions);
    currentResume = resumed.currentResume;
    context.state.currentResumeArtifact = currentResume;
  }
  let cachedSelection: { evaluation: ResumeReviewEvaluation; policyRound: ReturnType<typeof applyReviewPolicyRound> } | null = null;
  if (isReviewResume && context.state.bestReviewArtifact
    && context.state.reviewBindings[context.state.bestReviewArtifact.absolutePath]?.evidenceVersion === context.state.evidenceVersion
    && context.state.reviewRoundsUsed < maxRounds && context.state.optimizationActionsUsed < maxActions) {
    const state = context.state.reviewPolicyState;
    const reviewArtifact = context.state.bestReviewArtifact;
    cachedSelection = {
      evaluation: { currentResume, reviewArtifact, report: parseJsonObject(fs.readFileSync(reviewArtifact.absolutePath, "utf8"), "Restored review"), binding: context.state.reviewBindings[reviewArtifact.absolutePath] },
      policyRound: { state, decision: {
        round: context.state.reviewRoundsUsed, average: state.bestScore, improved: false,
        shouldStop: false, shouldRevise: true, stopReason: null,
        bestScore: state.bestScore, bestResumePath: state.bestResumePath,
        bestReviewReport: state.bestReviewReport, bestReviewPath: state.bestReviewPath,
        lastReviewReport: state.lastReviewReport, lastReviewPath: state.lastReviewPath,
      } },
    };
  }

  for (
    let round = isReviewResume ? (cachedSelection ? context.state.reviewRoundsUsed : context.state.reviewRoundsUsed + 1) : 1;
    round <= maxRounds && context.state.stopReason !== "optimization-stop";
    round += 1
  ) {
    const cached = cachedSelection;
    cachedSelection = null;
    const evaluation: ResumeReviewEvaluation = cached?.evaluation ?? await evaluateResumeOnce(context, {
      currentResume,
      round,
    });
    if (!cached) linkReReviewToPreviousAction(context, evaluation);

    const bestBinding = context.state.bestReviewArtifact
      ? context.state.reviewBindings[context.state.bestReviewArtifact.absolutePath] : null;
    if (!cached && evaluation.binding && bestBinding
      && bestBinding.evidenceVersion !== evaluation.binding.evidenceVersion) {
      // The unchanged Best must be diagnosed against current evidence before
      // selecting any new action, including when a correction reveals a risk.
      context.state.reviewPolicyState = createReviewPolicyState({ initialResumePath: currentResume.absolutePath, maxRounds });
      recordOptimizationTelemetry(context, "selected", "new evidence baseline: current diagnosis replaces the obsolete factual assessment; prior reviews remain historical");
    }

    const policyRound: ReturnType<typeof applyReviewPolicyRound> = cached?.policyRound ?? applyReviewPolicyRound(
      context.state.reviewPolicyState,
      {
        round,
        resumePath: currentResume.absolutePath,
        reviewPath: evaluation.reviewArtifact.absolutePath,
        report: evaluation.report,
        targetedImprovement: targetedCandidateImprovement(context, evaluation),
      },
    );
    if (!cached) selectBestResumeByReviewPolicy(context, policyRound, evaluation);
    persistMemory(context);

    if (policyRound.decision.shouldStop) {
      context.state.optimizationStopReason =
        policyRound.decision.stopReason ?? "review-policy-stop";
      recordOptimizationTelemetry(
        context,
        "stopped",
        `review policy stopped after round ${round}: ${context.state.optimizationStopReason}`,
      );
      break;
    }

    if (context.state.optimizationActionsUsed >= maxActions) {
      context.state.stopReason = "action-budget-exhausted";
      context.state.optimizationStopReason = "action-budget-exhausted";
      recordOptimizationTelemetry(
        context,
        "stopped",
        `optimization action budget exhausted after ${context.state.optimizationActionsUsed} actions`,
      );
      break;
    }

    const selectionEvaluation = getSelectionEvaluation(
      context,
      evaluation,
      policyRound,
    );
    currentResume = selectionEvaluation.currentResume;
    context.state.currentResumeArtifact = currentResume;
    const selectionReviewPath = selectionEvaluation.reviewArtifact.absolutePath;
    const selectionContextKey = context.state.answerInterpretations.length
      ? `${selectionReviewPath}:answers-${context.state.answerInterpretations.length}` : selectionReviewPath;
    const attemptsUsed =
      context.state.proposalAttemptsByReview[selectionContextKey] ?? 0;
    if (attemptsUsed >= MAX_PROPOSAL_ATTEMPTS_PER_REVIEW) {
      context.state.stopReason = "proposal-reselection-exhausted";
      context.state.optimizationStopReason = hasRejectedReason(
        context,
        "QUESTION_BUDGET_EXHAUSTED",
      )
        ? "question-budget-exhausted-source-facts"
        : "proposal-reselection-exhausted";
      recordOptimizationTelemetry(
        context,
        "stopped",
        `proposal attempts exhausted for ${selectionReviewPath}`,
      );
      persistMemory(context);
      break;
    }

    let previousProposalRejection: ProposalRejectionContext | null = null;
    let selectedProposal: {
      sequence: number;
      decision: OptimizationDecision;
      decisionArtifact: ReturnType<typeof persistOptimizationDecision>;
      routedDecision: ReturnType<typeof routeOptimizationDecision>;
    } | null = null;

    for (
      let attempt = attemptsUsed + 1;
      attempt <= MAX_PROPOSAL_ATTEMPTS_PER_REVIEW;
      attempt += 1
    ) {
      const sequence = context.state.actionHistory.length + 1;
      const remainingBudget = maxActions - context.state.optimizationActionsUsed;
      const { decision, decisionArtifact } = await decideOptimizationAction(
        context,
        {
          evaluation: selectionEvaluation,
          sequence,
          remainingBudget,
          rejection: previousProposalRejection,
        },
      );
      context.state.proposalAttemptsByReview[selectionContextKey] = attempt;
      recordOptimizationTelemetry(
        context,
        "selected",
        `selected ${decision.action} for ${decision.target ?? "no target"}`,
      );

      const routedDecision = routeOptimizationDecision({
        strengthensRestrictedClaim: selectionEvaluation.binding ? Boolean(decision.restrictionRefs?.length) : undefined,
        questionProposalAllowed: decision.questionProposal ? selectQuestionCandidates(context, [decision.questionProposal]).allowed.length > 0 : undefined,
        reviewReport: selectionEvaluation.report,
        decision,
        issueBindingValid: validSelectedBinding(context, selectionEvaluation, decision),
        actionHistory: context.state.actionHistory.filter((entry) => !decision.issueKey || ["executed", "no-op"].includes(entry.status)).map((entry) => ({
          action: entry.decision.action,
          target: entry.decision.target,
          issueKey: entry.decision.issueKey,
          targetNode: entry.decision.targetNode,
          evidenceVersion: entry.decision.evidenceVersion,
        })),
        preflightDecision: context.state.preflightDecision!,
        remainingBudget,
        canAskUser: questionAllowance(context).canAskUser,
        currentArtifactPaths: {
          resumePath: selectionEvaluation.currentResume.absolutePath,
          reviewPath: selectionReviewPath,
        },
      });

      if (!routedDecision.allowed) {
        context.state.actionHistory.push(
          createActionHistoryEntry({
            sequence,
            decision,
            decisionPath: decisionArtifact.absolutePath,
            route: routedDecision,
            status: "rejected",
            sourceReviewPath: selectionReviewPath,
            rejectedReason: routedDecision.reasonCodes[0] ?? "router-rejected",
          }),
        );
        recordOptimizationTelemetry(
          context,
          "rejected",
          `router rejected ${decision.action}: ${routedDecision.reasonCodes.join(", ")}`,
        );
        persistMemory(context);

        if (
          !routedDecision.shouldStop &&
          attempt < MAX_PROPOSAL_ATTEMPTS_PER_REVIEW
        ) {
          previousProposalRejection = {
            reasonCodes: [...routedDecision.reasonCodes],
            rejectedAction: decision.action,
            rejectedTarget: decision.target,
            rejectedReason:
              routedDecision.reasonCodes[0] ?? "router-rejected",
          };
          continue;
        }

        stopAfterRouterRejection(
          context,
          routedDecision.reasonCodes,
          !routedDecision.shouldStop,
        );
        recordOptimizationTelemetry(
          context,
          "stopped",
          `optimization stopped after router rejection ${context.state.optimizationStopReason}`,
        );
        persistMemory(context);
        break;
      }

      selectedProposal = {
        sequence,
        decision,
        decisionArtifact,
        routedDecision,
      };
      persistMemory(context);
      break;
    }

    if (!selectedProposal) {
      break;
    }

    const {
      sequence,
      decision,
      decisionArtifact,
      routedDecision,
    } = selectedProposal;

    const execution = await executeOptimizationAction(context, {
      decision,
      routedDecision,
      reviewReport: selectionEvaluation.report,
      revisionRound: round + 1,
      decisionPath: decisionArtifact.absolutePath,
      sourceReviewPath: selectionReviewPath,
      sourceResumePath: selectionEvaluation.currentResume.absolutePath,
    });
    if (execution.outcome === "no-op") {
      context.state.actionHistory.push(createActionHistoryEntry({ sequence, decision, decisionPath: decisionArtifact.absolutePath,
        route: routedDecision, status: "no-op", sourceReviewPath: selectionReviewPath, rejectedReason: "no-content-change" }));
      cachedSelection = { evaluation: selectionEvaluation, policyRound };
      round -= 1;
      persistMemory(context);
      continue;
    }
    if (execution.outcome !== "candidate-created") {
      context.state.actionHistory.push(
        createActionHistoryEntry({
          sequence,
          decision,
          decisionPath: decisionArtifact.absolutePath,
          route: routedDecision,
          status: "stopped",
          sourceReviewPath: selectionReviewPath,
        }),
      );
      if (execution.outcome === "stopped") {
        context.state.stopReason = "optimization-stop";
        if (hasRejectedReason(context, "QUESTION_BUDGET_EXHAUSTED")) {
          context.state.optimizationStopReason =
            "question-budget-exhausted-source-facts";
        }
      }
      recordOptimizationTelemetry(
        context,
        "stopped",
        `optimization stopped with ${routedDecision.action}`,
      );
      persistMemory(context);
      break;
    }

    context.state.optimizationActionsUsed += 1;
    context.state.actionHistory.push(
      createActionHistoryEntry({
        sequence,
        decision,
        decisionPath: decisionArtifact.absolutePath,
        route: routedDecision,
        status: "executed",
        candidateResumePath: execution.candidateResume.absolutePath,
        sourceReviewPath: selectionReviewPath,
      }),
    );
    recordOptimizationTelemetry(
      context,
      "executed",
      `executed ${routedDecision.action}, candidate ${execution.candidateResume.absolutePath}`,
    );
    currentResume = execution.candidateResume;
    persistMemory(context);
  }

  if (context.state.stopReason === "needs-user-input") {
    return context.state.questionsArtifact;
  }

  const finalBestBinding = context.state.bestReviewArtifact
    ? context.state.reviewBindings[context.state.bestReviewArtifact.absolutePath] : null;
  if (finalBestBinding && finalBestBinding.evidenceVersion !== context.state.evidenceVersion
    && context.state.bestResumeArtifact && context.state.reviewRoundsUsed < maxRounds) {
    // STOP/rejected proposals can leave the unchanged Best with an obsolete
    // factual diagnosis. Refresh it within the remaining review budget.
    const evaluation = await evaluateResumeOnce(context, {
      currentResume: context.state.bestResumeArtifact,
      round: context.state.reviewRoundsUsed + 1,
    });
    const refreshed = applyReviewPolicyRound(createReviewPolicyState({ initialResumePath: evaluation.currentResume.absolutePath, maxRounds }), {
      round: context.state.reviewRoundsUsed + 1,
      resumePath: evaluation.currentResume.absolutePath,
      reviewPath: evaluation.reviewArtifact.absolutePath,
      report: evaluation.report,
    });
    const stopReason = context.state.stopReason;
    selectBestResumeByReviewPolicy(context, refreshed, evaluation);
    context.state.stopReason = stopReason;
    recordOptimizationTelemetry(context, "selected", "final Best review refreshed against current evidence before delivery");
    persistMemory(context);
  }

  const bestResume =
    context.state.bestResumeArtifact ?? context.state.currentResumeArtifact;
  const bestReview = context.state.bestReviewArtifact;
  if (!bestResume || !bestReview) {
    throw new Error(
      "Review loop did not produce a best resume and review artifact.",
    );
  }

  const report = parseJsonObject(fs.readFileSync(bestReview.absolutePath, "utf8"), "Best review report");
  let sourceOnly = hasFactRisk(report) || (report.schemaVersion !== 2 && context.state.optimizationStopReason === "question-budget-exhausted-source-facts");
  let finalSource = sourceOnly ? context.state.originalResumeArtifact : bestResume;
  if (sourceOnly && bestResume) {
    const candidate = readV3Resume(bestResume.absolutePath);
    const riskCount = Array.isArray(report.topIssues)
      ? report.topIssues.filter((issue) => readRecordField(issue, "category") === "UNSUPPORTED_CLAIM").length
      : 0;
    if (candidate && riskCount > 0) {
      const sanitized = sanitizeBoundFactRisks(context, candidate, report, bestReview.absolutePath);
      if (sanitized.repaired.length === riskCount) {
        finalSource = registerArtifact(context, {
          kind: "resume",
          fileName: `${baseName}.resume.sanitized.json`,
          generator: "rolepilot-engine",
          stage: "supporting",
        }, toJsonText(sanitized.content));
        sourceOnly = false;
        registerArtifact(context, {
          kind: "log",
          fileName: `${baseName}.final.fact-risk-sanitization.json`,
          generator: "rolepilot-engine",
          stage: "supporting",
        }, toJsonText({ repairedIssueRefs: sanitized.repaired, policy: "bound-local-fact-risk-sanitization" }));
      }
    }
  }
  if (!finalSource) throw new Error("No readable frozen source is available for source-only delivery.");
  const sourceDocument = readV3Resume(finalSource.absolutePath)
    ?? convertLegacyYamlToResumeContentV3(
      fs.readFileSync(finalSource.absolutePath, "utf8"),
      `${context.input.runId}:generated`,
    );
  const v3 = sourceOnly ? applySourceCorrections(sourceDocument,
    context.state.answerInterpretations.flatMap((entry) => entry.corrections)) : sourceDocument;
  const readableSource = v3 && (Object.values(v3.profile).some((value) => typeof value === "string" && value.trim())
    || [...indexResumeNodes(v3).values()].some(({ node }) => ["content", "name", "role", "date", "location"].some((key) => typeof node[key] === "string" && node[key].trim())));
  if (sourceOnly && !readableSource) throw new Error("Frozen source has no readable resume content.");
  context.state.deliveryStatus = sourceOnly ? "SOURCE_ONLY" : "OPTIMIZED";
  context.state.finalReviewPath = sourceOnly ? null : bestReview.absolutePath;
  if (sourceOnly) {
    context.state.optimizationStopReason = "source-only-delivery";
    context.state.stopReason = "source-only-delivery";
  }
  const finalRecord = registerArtifact(
    context,
    {
      kind: "resume",
      fileName: `${baseName}.resume.final.json`,
      generator: "rolepilot-engine",
      stage: "final",
    },
    toJsonText(v3),
  );
  context.state.finalResumeArtifact = finalRecord;
  const original = readV3Resume(context.state.originalResumeArtifact?.absolutePath ?? "");
  const preflight = context.state.preflightDecisionArtifact;
  if (!original || !preflight) {
    throw new Error("Final delivery requires frozen v3 original and preflight artifacts.");
  }
  const bindingArtifactPath = context.state.reviewBindingArtifactPaths[bestReview.absolutePath] ?? null;
  const finalReviewBound = !sourceOnly
    && Boolean(bindingArtifactPath)
    && Boolean(context.state.reviewBindings[bestReview.absolutePath])
    && readV3Resume(bestResume.absolutePath)?.documentId === v3.documentId;
  context.state.workbenchDeliveryArtifact = registerArtifact(
    context,
    {
      kind: "log",
      fileName: "workbench-delivery.json",
      generator: "rolepilot-engine",
      stage: "supporting",
    },
    toJsonText({
      schemaVersion: 1,
      format: "workbench-delivery",
      deliveryStatus: context.state.deliveryStatus,
      original: { documentId: original.documentId, path: context.state.originalResumeArtifact!.path },
      final: {
        documentId: v3.documentId,
        path: finalRecord.path,
        candidateVersion: sourceOnly ? null : context.state.candidateVersions[bestResume.absolutePath] ?? null,
      },
      candidate: {
        documentId: readV3Resume(bestResume.absolutePath)?.documentId ?? null,
        path: bestResume.path,
        version: context.state.candidateVersions[bestResume.absolutePath] ?? null,
      },
      review: {
        kind: finalReviewBound ? "final-bound" : "historical-suggestion",
        reportPath: bestReview.path,
        bindingPath: finalReviewBound && bindingArtifactPath
          ? artifactPathForDelivery(context, bindingArtifactPath)
          : null,
        binding: finalReviewBound ? context.state.reviewBindings[bestReview.absolutePath] : null,
      },
      preflight: {
        path: preflight.path,
        decision: context.state.preflightDecision?.decision,
      },
      actionHistory: context.state.actionHistory.map((entry) => ({
        ...entry,
        decisionPath: artifactPathForDelivery(context, entry.decisionPath),
        candidateResumePath: entry.candidateResumePath
          ? artifactPathForDelivery(context, entry.candidateResumePath)
          : null,
        sourceReviewPath: artifactPathForDelivery(context, entry.sourceReviewPath),
        resultReviewPath: entry.resultReviewPath
          ? artifactPathForDelivery(context, entry.resultReviewPath)
          : null,
      })),
    }),
  );

  persistMemory(context);
  return finalRecord;
}

export async function generateInterviewArtifacts(context: ResumeSliceContext) {
  if (
    context.state.stopReason === "needs-user-input" ||
    context.state.stopReason === "unsupported-input"
  ) {
    throw new Error(
      "Interview preparation is blocked until the resume workflow has a final resume.",
    );
  }
  const finalResume = requireFinalResume(context);
  const timeline = requireTimeline(context);
  const baseName = createArtifactBaseName(context.input.company);

  const interviewText = await executeAgent(
    context,
    "interviewer",
    "interview",
    "interview-simulation",
    wrapInterviewPrompt(toJsonText({
      ...buildSourceMaterials(context),
      company: context.input.company,
      jdText: context.input.jdText ?? null,
      jdAnalysisText: context.state.jdAnalysisArtifact ? fs.readFileSync(context.state.jdAnalysisArtifact.absolutePath, "utf8") : null,
      questionRecords: context.state.questionRecords,
      evidenceVersion: context.state.evidenceVersion,
      safeWritingScope: context.state.safeWritingScope,
      resumePath: finalResume.absolutePath,
      resumeText: fs.readFileSync(finalResume.absolutePath, "utf8"),
      timelinePath: timeline.absolutePath,
      timelineText: fs.readFileSync(timeline.absolutePath, "utf8"),
    })),
    "generate interview simulation",
  );
  const cheatsheetText = await executeAgent(
    context,
    "interviewer",
    "interview",
    "interview-cheatsheet",
    wrapCheatsheetPrompt(toJsonText({
      ...buildSourceMaterials(context),
      company: context.input.company,
      jdText: context.input.jdText ?? null,
      jdAnalysisText: context.state.jdAnalysisArtifact ? fs.readFileSync(context.state.jdAnalysisArtifact.absolutePath, "utf8") : null,
      questionRecords: context.state.questionRecords,
      evidenceVersion: context.state.evidenceVersion,
      safeWritingScope: context.state.safeWritingScope,
      resumePath: finalResume.absolutePath,
      resumeText: fs.readFileSync(finalResume.absolutePath, "utf8"),
      timelinePath: timeline.absolutePath,
      timelineText: fs.readFileSync(timeline.absolutePath, "utf8"),
      mode: "cheatsheet",
    })),
    "generate interview cheatsheet",
  );

  context.state.interviewArtifact = registerArtifact(
    context,
    {
      kind: "interview",
      fileName: `${baseName}.interview.md`,
      generator: "interviewer",
      stage: "deliverable",
    },
    interviewText,
  );
  context.state.cheatsheetArtifact = registerArtifact(
    context,
    {
      kind: "cheatsheet",
      fileName: `${baseName}.cheatsheet.md`,
      generator: "interviewer",
      stage: "deliverable",
    },
    cheatsheetText,
  );
  context.state.interviewSourceResumePath = finalResume.absolutePath;
  context.state.cheatsheetSourceResumePath = finalResume.absolutePath;
  persistMemory(context);
  return {
    interview: context.state.interviewArtifact,
    cheatsheet: context.state.cheatsheetArtifact,
  };
}

export async function runInterviewStep(context: ResumeSliceContext) {
  return generateInterviewArtifacts(context);
}
