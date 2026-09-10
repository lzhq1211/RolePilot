import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  API_ERROR_CODES,
  buildCreateRunInput,
  NewRunInputValidationError,
  RESUME_SOURCE_STATUSES,
  RUN_CLEANUP_STATUSES,
  RUN_ARTIFACT_STATUSES,
  RUN_ARTIFACT_TYPES,
  RUN_EVENT_TYPES,
  RUN_EVIDENCE_STATUSES,
  RUN_FAILURE_CODES,
  RUN_LIMITS,
  RUN_STATUSES,
  RUN_STEP_IDS,
  RUN_STEP_STATUSES,
  RUN_STOP_REASONS,
  SOURCE_ERROR_CODES,
  SOURCE_LIMITS,
  validateRunDto,
  validateRunEvidenceInput,
  validateRunEvent,
  validateNewRunInput,
} from "../dist/index.js";

const runFixture = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", "run-contract.json"), "utf8"),
);

const readySource = {
  id: "source-1",
  status: "READY",
  inputKind: "file",
  originalFileName: "resume.txt",
  mediaType: "text/plain",
  sizeBytes: 10,
  textLength: 10,
  pageCount: null,
  previewText: "Evidence-backed resume.",
  parserVersion: "document-ingest/txt-v1",
  error: null,
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
};

const validInput = {
  source: readySource,
  sourceBusy: false,
  input: {
    resumeSourceId: "source-1",
    company: "RolePilot",
    title: "AI 产品经理",
    jdText: "负责证据驱动的简历优化。",
  },
  hasDraftConflict: false,
};

test("W2 source contract keeps source and run vocabularies separate", () => {
  assert.deepEqual(RESUME_SOURCE_STATUSES, ["UPLOADING", "EXTRACTING", "READY", "FAILED"]);
  assert.equal(RESUME_SOURCE_STATUSES.includes("RUNNING"), false);
  assert.equal(SOURCE_ERROR_CODES.includes("PDF_ENCRYPTED"), true);
  assert.equal(SOURCE_ERROR_CODES.includes("DOCX_INVALID"), true);
});

test("W2 limits remain shared and explicit", () => {
  assert.equal(SOURCE_LIMITS.maxFileBytes, 10 * 1024 * 1024);
  assert.equal(SOURCE_LIMITS.maxTextCodePoints, 200_000);
  assert.equal(SOURCE_LIMITS.draftDebounceMs, 240);
  assert.equal(SOURCE_LIMITS.maxDocxEntries, 2_000);
  assert.equal(SOURCE_LIMITS.maxDocxUncompressedBytes, 50 * 1024 * 1024);
  assert.equal(SOURCE_LIMITS.maxDocxPathDepth, 32);
});

test("new-run validation requires a ready source and complete target input", () => {
  assert.deepEqual(
    validateNewRunInput({
      ...validInput,
      source: null,
      input: { ...validInput.input, company: " ", title: "", jdText: "\r\n" },
    }).map(({ field, code }) => ({ field, code })),
    [
      { field: "resume", code: "REQUIRED" },
      { field: "company", code: "REQUIRED" },
      { field: "title", code: "REQUIRED" },
      { field: "jd", code: "REQUIRED" },
    ],
  );
  assert.equal(
    validateNewRunInput({ ...validInput, sourceBusy: true })[0].code,
    "PROCESSING",
  );
  assert.equal(
    validateNewRunInput({ ...validInput, source: { ...readySource, status: "FAILED" } })[0].code,
    "NOT_READY",
  );
  assert.equal(
    validateNewRunInput({ ...validInput, hasDraftConflict: true })[0].code,
    "DRAFT_CONFLICT",
  );
  assert.deepEqual(
    validateNewRunInput({
      ...validInput,
      input: {
        ...validInput.input,
        company: "x".repeat(201),
        title: "x".repeat(201),
        jdText: "x".repeat(50_001),
      },
    }).map(({ field, code }) => ({ field, code })),
    [
      { field: "company", code: "TOO_LONG" },
      { field: "title", code: "TOO_LONG" },
      { field: "jd", code: "TOO_LONG" },
    ],
  );
});

test("buildCreateRunInput returns only a normalized immutable whitelist DTO", () => {
  const input = buildCreateRunInput({
    ...validInput,
    input: { ...validInput.input, jdText: "line 1\r\nline 2" },
  });
  assert.deepEqual(input, {
    resumeSourceId: "source-1",
    company: "RolePilot",
    title: "AI 产品经理",
    jdText: "line 1\nline 2",
  });
  assert.deepEqual(Object.keys(input).sort(), ["company", "jdText", "resumeSourceId", "title"]);
  assert.equal(Object.isFrozen(input), true);
  assert.throws(
    () => buildCreateRunInput({ ...validInput, source: { ...readySource, status: "FAILED" } }),
    (error) => error instanceof NewRunInputValidationError && error.fieldErrors[0].code === "NOT_READY",
  );
});

test("W3 Run vocabulary and limits stay frozen in the shared contract", () => {
  assert.deepEqual(RUN_STATUSES, runFixture.runStatuses);
  assert.deepEqual(RUN_STEP_IDS, runFixture.runStepIds);
  assert.deepEqual(RUN_STEP_STATUSES, runFixture.runStepStatuses);
  assert.deepEqual(RUN_FAILURE_CODES, runFixture.runFailureCodes);
  assert.deepEqual(RUN_STOP_REASONS, runFixture.runStopReasons);
  assert.deepEqual(RUN_EVENT_TYPES, runFixture.runEventTypes);
  assert.deepEqual(RUN_EVIDENCE_STATUSES, runFixture.runEvidenceStatuses);
  assert.deepEqual(RUN_CLEANUP_STATUSES, runFixture.runCleanupStatuses);
  assert.deepEqual(RUN_ARTIFACT_TYPES, runFixture.runArtifactTypes);
  assert.deepEqual(RUN_ARTIFACT_STATUSES, runFixture.runArtifactStatuses);
  assert.deepEqual(RUN_LIMITS, runFixture.runLimits);
  for (const code of [
    "RUN_CONFLICT",
    "RUN_NOT_FOUND",
    "RUN_NOT_CANCELLABLE",
    "RUN_NOT_RESUMABLE",
    "EVENT_CURSOR_INVALID",
    "DELETE_CONFIRMATION_REQUIRED",
  ]) {
    assert.equal(API_ERROR_CODES.includes(code), true, `${code} must be an API error code`);
  }
});

test("RunDto requires the exact five-step projection and controlled terminal fields", () => {
  assert.deepEqual(validateRunDto(runFixture.run), { valid: true, errors: [] });
  assert.equal(
    validateRunDto({ ...runFixture.run, interview: { questions: [] } }).valid,
    false,
  );
  assert.equal(
    validateRunDto({
      ...runFixture.run,
      status: "FAILED",
      stopReason: null,
      failureCode: null,
    }).valid,
    false,
  );
  assert.equal(
    validateRunDto({
      ...runFixture.run,
      stepStatuses: [...runFixture.run.stepStatuses.slice(0, 4), { id: "interview", status: "pending" }],
    }).valid,
    false,
  );
  assert.equal(
    validateRunDto({
      ...runFixture.run,
      status: "CANCELLED",
      stopReason: "cancelled",
      completedAt: "2026-09-05T00:01:00.000Z",
    }).valid,
    true,
  );
});

test("Run evidence contract bounds input and Run events reject unsafe payload fields", () => {
  assert.deepEqual(validateRunEvidenceInput({ evidenceText: "补充了项目结果。" }), {
    valid: true,
    errors: [],
  });
  assert.equal(validateRunEvidenceInput({ evidenceText: "x".repeat(20_001) }).valid, false);
  assert.equal(validateRunEvidenceInput({ evidenceText: "ok", rootDir: "/tmp/run" }).valid, false);
  assert.equal(validateRunEvidenceInput({ evidenceText: "  " }).valid, false);

  for (const event of runFixture.events) {
    assert.deepEqual(validateRunEvent(event), { valid: true, errors: [] });
  }
  assert.equal(
    validateRunEvent({
      ...runFixture.events[0],
      payload: { ...runFixture.events[0].payload, detail: "provider output" },
    }).valid,
    false,
  );
  assert.equal(
    validateRunEvent({
      ...runFixture.events[0],
      payload: { ...runFixture.events[0].payload, path: "/private/run" },
    }).valid,
    false,
  );
});
