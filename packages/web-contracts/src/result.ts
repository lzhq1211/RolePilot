export const RESULT_LIMITS = Object.freeze({
  maxSections: 20,
  maxEntries: 100,
  maxBulletsPerEntry: 20,
  maxContactFields: 10,
  maxSafeWritingScope: 20,
  maxDiffBlocks: 500,
  maxActionHistory: 50,
  maxEvidenceRefs: 20,
  maxReviewIssues: 8,
  maxReviewCoverageItems: 50,
  maxReviewStrengths: 20,
  maxStringCodePoints: 2_000,
} as const);

export type ResultAvailability = "READY" | "NOT_READY" | "UNAVAILABLE";
export type DiffKind = "added" | "removed" | "changed" | "unchanged" | "unaligned";
export type DiffStatus = "READY" | "UNAVAILABLE";
export type ResumeFieldDto = { label: string; value: string };
export type ResumeEntryDto = { id: string; title: string | null; date: string | null; location: string | null; bullets: string[] };
export type ResumeSectionDto = { id: string; title: string; entries: ResumeEntryDto[] };
export type ResumeViewDto = { schemaVersion: "v1"; name: string | null; contact: ResumeFieldDto[]; summary: string | null; sections: ResumeSectionDto[] };
export type DiffBlockDto = { id: string; sectionId: string | null; kind: DiffKind; before: string | null; after: string | null };
export type ResultActionAuditDto = {
  sequence: number;
  action: "PASS" | "STOP" | "REWRITE_SECTION" | "KEYWORD_OPTIMIZE" | "DROP_UNSUPPORTED_CLAIM" | "REORDER" | "ASK_USER";
  target: string | null;
  reason: string;
  evidenceRefs: string[];
  risk: "low" | "medium" | "high";
  routerResult: "allowed" | "rejected" | "stopped";
  reviewImproved: boolean | null;
};
export type ReviewIssueDto = {
  issueRef: string;
  priority: "P0" | "P1" | "P2" | "P3";
  category: "UNSUPPORTED_CLAIM" | "POSITIONING" | "JD_COVERAGE" | "EVIDENCE_PRESENTATION" | "CONTENT_PRIORITY" | "WORDING";
  resolution: "REWRITE_NOW" | "NEEDS_CONFIRMATION" | "CAPABILITY_GAP";
  section: string;
  resumeEvidence: string;
  jdEvidence: string;
  sourceEvidence: string;
  problem: string;
  whyItHurts: string;
  recommendedAction: string;
};
export type ReviewCoverageItemDto = { requirement: string; evidence: string };
export type ReviewSummaryDto = {
  schemaVersion: 2;
  verdict: "PASS" | "REVISE" | "NEED_ROLE_INFO";
  roleInfoQuestion: string | null;
  overallScore: number;
  positioningDiagnosis: { currentPositioning: string; targetPositioning: string; biggestGap: string };
  topIssues: ReviewIssueDto[];
  jdCoverage: { strong: ReviewCoverageItemDto[]; weak: ReviewCoverageItemDto[]; unsupported: ReviewCoverageItemDto[] };
  strengths: string[];
};
export type RunResultDto = {
  runId: string;
  availability: ResultAvailability;
  resume: ResumeViewDto | null;
  originalResume: ResumeViewDto | null;
  diffStatus: DiffStatus;
  diff: DiffBlockDto[];
  preflight: { decision: "PROCEED" | "ASK_USER" | "STOP_UNSUPPORTED"; safeWritingScope: string[] } | null;
  review?: ReviewSummaryDto | null;
  actionHistory: ResultActionAuditDto[];
  stopReason: "needs-user-input" | "unsupported-input" | "pass" | "early-stop" | "max-rounds" | "cancelled" | null;
};

export type ResultContractValidationResult = { valid: true; errors: [] } | { valid: false; errors: string[] };

export function validateResumeView(value: unknown): ResultContractValidationResult {
  const errors: string[] = [];
  if (!isRecord(value) || !hasOnlyKeys(value, ["schemaVersion", "name", "contact", "summary", "sections"])) return invalid("ResumeViewDto contains unknown fields or is not an object");
  if (value.schemaVersion !== "v1") errors.push("schemaVersion must be v1");
  nullableString(value.name, "name", errors); nullableString(value.summary, "summary", errors);
  if (!Array.isArray(value.contact) || value.contact.length > RESULT_LIMITS.maxContactFields) errors.push("contact exceeds the configured limit");
  else value.contact.forEach((item, index) => {
    if (!isRecord(item) || !hasOnlyKeys(item, ["label", "value"])) { errors.push(`contact[${index}] is invalid`); return; }
    stringValue(item.label, `contact[${index}].label`, errors); stringValue(item.value, `contact[${index}].value`, errors);
  });
  if (!Array.isArray(value.sections) || value.sections.length > RESULT_LIMITS.maxSections) errors.push("sections exceed the configured limit");
  else {
    let entries = 0;
    value.sections.forEach((section, index) => {
      if (!isRecord(section) || !hasOnlyKeys(section, ["id", "title", "entries"])) { errors.push(`sections[${index}] is invalid`); return; }
      stringValue(section.id, `sections[${index}].id`, errors); stringValue(section.title, `sections[${index}].title`, errors);
      if (!Array.isArray(section.entries)) { errors.push(`sections[${index}].entries must be an array`); return; }
      entries += section.entries.length;
      section.entries.forEach((entry, entryIndex) => {
        const p = `sections[${index}].entries[${entryIndex}]`;
        if (!isRecord(entry) || !hasOnlyKeys(entry, ["id", "title", "date", "location", "bullets"])) { errors.push(`${p} is invalid`); return; }
        stringValue(entry.id, `${p}.id`, errors); nullableString(entry.title, `${p}.title`, errors); nullableString(entry.date, `${p}.date`, errors); nullableString(entry.location, `${p}.location`, errors);
        boundedStringArray(entry.bullets, RESULT_LIMITS.maxBulletsPerEntry, `${p}.bullets`, errors);
      });
    });
    if (entries > RESULT_LIMITS.maxEntries) errors.push("entries exceed the configured limit");
  }
  return errors.length ? invalid(...errors) : valid();
}

export function validateRunResultDto(value: unknown): ResultContractValidationResult {
  const errors: string[] = [];
  if (!isRecord(value) || !hasOnlyKeys(value, ["runId", "availability", "resume", "originalResume", "diffStatus", "diff", "preflight", "review", "actionHistory", "stopReason"])) return invalid("RunResultDto contains unknown fields or is not an object");
  stringValue(value.runId, "runId", errors);
  if (!oneOf(value.availability, ["READY", "NOT_READY", "UNAVAILABLE"])) errors.push("availability is invalid");
  if (!oneOf(value.diffStatus, ["READY", "UNAVAILABLE"])) errors.push("diffStatus is invalid");
  if (value.resume !== null) { const result = validateResumeView(value.resume); if (!result.valid) errors.push(...result.errors.map((error) => `resume.${error}`)); }
  if (value.originalResume !== null) { const result = validateResumeView(value.originalResume); if (!result.valid) errors.push(...result.errors.map((error) => `originalResume.${error}`)); }
  if (!Array.isArray(value.diff) || value.diff.length > RESULT_LIMITS.maxDiffBlocks) errors.push("diff exceeds the configured limit"); else value.diff.forEach((block, index) => validateDiff(block, index, errors));
  if (value.preflight !== null) {
    if (!isRecord(value.preflight) || !hasOnlyKeys(value.preflight, ["decision", "safeWritingScope"])) errors.push("preflight is invalid");
    else { if (!oneOf(value.preflight.decision, ["PROCEED", "ASK_USER", "STOP_UNSUPPORTED"])) errors.push("preflight.decision is invalid"); boundedStringArray(value.preflight.safeWritingScope, RESULT_LIMITS.maxSafeWritingScope, "preflight.safeWritingScope", errors); }
  }
  if (value.review !== undefined && value.review !== null) {
    const result = validateReviewSummary(value.review);
    if (!result.valid) errors.push(...result.errors.map((error) => `review.${error}`));
  }
  if (!Array.isArray(value.actionHistory) || value.actionHistory.length > RESULT_LIMITS.maxActionHistory) errors.push("actionHistory exceeds the configured limit"); else value.actionHistory.forEach((item, index) => validateAction(item, index, errors));
  if (value.stopReason !== null && !oneOf(value.stopReason, ["needs-user-input", "unsupported-input", "pass", "early-stop", "max-rounds", "cancelled"])) errors.push("stopReason is invalid");
  if (value.availability === "READY" && (value.resume === null || value.preflight === null)) errors.push("READY results require resume and preflight");
  if (value.availability !== "READY" && value.resume !== null) errors.push("non-ready results must not include resume");
  if (value.diffStatus === "READY" && value.originalResume === null) errors.push("READY diff requires originalResume");
  if (value.diffStatus === "UNAVAILABLE" && Array.isArray(value.diff) && value.diff.length > 0) errors.push("UNAVAILABLE diff must be empty");
  return errors.length ? invalid(...errors) : valid();
}

export function validateReviewSummary(value: unknown): ResultContractValidationResult {
  const errors: string[] = [];
  if (!isRecord(value) || !hasOnlyKeys(value, ["schemaVersion", "verdict", "roleInfoQuestion", "overallScore", "positioningDiagnosis", "topIssues", "jdCoverage", "strengths"])) return invalid("review summary contains unknown fields or is not an object");
  if (value.schemaVersion !== 2) errors.push("schemaVersion must be 2");
  if (!oneOf(value.verdict, ["PASS", "REVISE", "NEED_ROLE_INFO"])) errors.push("verdict is invalid");
  if (value.roleInfoQuestion !== null && (typeof value.roleInfoQuestion !== "string" || value.roleInfoQuestion.length === 0 || [...value.roleInfoQuestion].length > RESULT_LIMITS.maxStringCodePoints)) errors.push("roleInfoQuestion must be a bounded string or null");
  if (value.verdict === "NEED_ROLE_INFO" && (typeof value.roleInfoQuestion !== "string" || value.roleInfoQuestion.length === 0)) errors.push("roleInfoQuestion is required for NEED_ROLE_INFO");
  if (value.verdict !== "NEED_ROLE_INFO" && value.roleInfoQuestion !== null) errors.push("roleInfoQuestion must be null unless verdict is NEED_ROLE_INFO");
  if (!Number.isInteger(value.overallScore) || value.overallScore < 0 || value.overallScore > 100) errors.push("overallScore is invalid");
  if (!isRecord(value.positioningDiagnosis) || !hasOnlyKeys(value.positioningDiagnosis, ["currentPositioning", "targetPositioning", "biggestGap"])) errors.push("positioningDiagnosis is invalid");
  else {
    stringValue(value.positioningDiagnosis.currentPositioning, "positioningDiagnosis.currentPositioning", errors);
    stringValue(value.positioningDiagnosis.targetPositioning, "positioningDiagnosis.targetPositioning", errors);
    if (typeof value.positioningDiagnosis.biggestGap !== "string") errors.push("positioningDiagnosis.biggestGap is invalid");
  }
  if (!Array.isArray(value.topIssues) || value.topIssues.length > RESULT_LIMITS.maxReviewIssues) errors.push("topIssues exceeds the configured limit");
  else value.topIssues.forEach((issue, index) => validateReviewIssue(issue, index, errors));
  if (!isRecord(value.jdCoverage) || !hasOnlyKeys(value.jdCoverage, ["strong", "weak", "unsupported"])) errors.push("jdCoverage is invalid");
  else {
    let coverageCount = 0;
    for (const group of ["strong", "weak", "unsupported"]) {
      const items = value.jdCoverage[group];
      if (!Array.isArray(items)) { errors.push(`jdCoverage.${group} must be an array`); continue; }
      coverageCount += items.length;
      items.forEach((item, index) => {
        const p = `jdCoverage.${group}[${index}]`;
        if (!isRecord(item) || !hasOnlyKeys(item, ["requirement", "evidence"])) { errors.push(`${p} is invalid`); return; }
        stringValue(item.requirement, `${p}.requirement`, errors);
        if (typeof item.evidence !== "string") errors.push(`${p}.evidence is invalid`);
      });
    }
    if (coverageCount > RESULT_LIMITS.maxReviewCoverageItems) errors.push("jdCoverage exceeds the configured limit");
  }
  if (!boundedStringArray(value.strengths, RESULT_LIMITS.maxReviewStrengths, "strengths", errors)) return invalid(...errors);
  return errors.length ? invalid(...errors) : valid();
}

function validateReviewIssue(value: unknown, index: number, errors: string[]): void {
  const p = `topIssues[${index}]`;
  const fields = ["issueRef", "priority", "category", "resolution", "section", "resumeEvidence", "jdEvidence", "sourceEvidence", "problem", "whyItHurts", "recommendedAction"];
  if (!isRecord(value) || !hasOnlyKeys(value, fields)) { errors.push(`${p} is invalid`); return; }
  stringValue(value.issueRef, `${p}.issueRef`, errors);
  if (!oneOf(value.priority, ["P0", "P1", "P2", "P3"])) errors.push(`${p}.priority is invalid`);
  if (!oneOf(value.category, ["UNSUPPORTED_CLAIM", "POSITIONING", "JD_COVERAGE", "EVIDENCE_PRESENTATION", "CONTENT_PRIORITY", "WORDING"])) errors.push(`${p}.category is invalid`);
  if (!oneOf(value.resolution, ["REWRITE_NOW", "NEEDS_CONFIRMATION", "CAPABILITY_GAP"])) errors.push(`${p}.resolution is invalid`);
  for (const field of ["section", "problem", "whyItHurts", "recommendedAction"]) stringValue(value[field], `${p}.${field}`, errors);
  for (const field of ["resumeEvidence", "jdEvidence", "sourceEvidence"]) if (typeof value[field] !== "string") errors.push(`${p}.${field} is invalid`);
}

function validateDiff(value: unknown, index: number, errors: string[]): void {
  const p = `diff[${index}]`;
  if (!isRecord(value) || !hasOnlyKeys(value, ["id", "sectionId", "kind", "before", "after"])) { errors.push(`${p} is invalid`); return; }
  stringValue(value.id, `${p}.id`, errors); nullableString(value.sectionId, `${p}.sectionId`, errors); if (!oneOf(value.kind, ["added", "removed", "changed", "unchanged", "unaligned"])) errors.push(`${p}.kind is invalid`); nullableString(value.before, `${p}.before`, errors); nullableString(value.after, `${p}.after`, errors);
}

function validateAction(value: unknown, index: number, errors: string[]): void {
  const p = `actionHistory[${index}]`;
  if (!isRecord(value) || !hasOnlyKeys(value, ["sequence", "action", "target", "reason", "evidenceRefs", "risk", "routerResult", "reviewImproved"])) { errors.push(`${p} is invalid`); return; }
  if (!Number.isSafeInteger(value.sequence) || value.sequence <= 0) errors.push(`${p}.sequence is invalid`);
  if (!oneOf(value.action, ["PASS", "STOP", "REWRITE_SECTION", "KEYWORD_OPTIMIZE", "DROP_UNSUPPORTED_CLAIM", "REORDER", "ASK_USER"])) errors.push(`${p}.action is invalid`);
  nullableString(value.target, `${p}.target`, errors); stringValue(value.reason, `${p}.reason`, errors); boundedStringArray(value.evidenceRefs, RESULT_LIMITS.maxEvidenceRefs, `${p}.evidenceRefs`, errors);
  if (!oneOf(value.risk, ["low", "medium", "high"])) errors.push(`${p}.risk is invalid`); if (!oneOf(value.routerResult, ["allowed", "rejected", "stopped"])) errors.push(`${p}.routerResult is invalid`); if (value.reviewImproved !== null && typeof value.reviewImproved !== "boolean") errors.push(`${p}.reviewImproved is invalid`);
}

function boundedStringArray(value: unknown, max: number, path: string, errors: string[]): value is string[] {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string" || [...item].length > RESULT_LIMITS.maxStringCodePoints)) { errors.push(`${path} must be a bounded string array`); return false; }
  return true;
}
function stringValue(value: unknown, path: string, errors: string[]): void { if (typeof value !== "string" || value.length === 0 || [...value].length > RESULT_LIMITS.maxStringCodePoints) errors.push(`${path} must be a non-empty bounded string`); }
function nullableString(value: unknown, path: string, errors: string[]): void { if (value !== null && (typeof value !== "string" || [...value].length > RESULT_LIMITS.maxStringCodePoints)) errors.push(`${path} must be a bounded string or null`); }
function isRecord(value: unknown): value is Record<string, any> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).every((key) => keys.includes(key)); }
function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T { return typeof value === "string" && values.includes(value as T); }
function valid(): ResultContractValidationResult { return { valid: true, errors: [] }; }
function invalid(...errors: string[]): ResultContractValidationResult { return { valid: false, errors }; }
