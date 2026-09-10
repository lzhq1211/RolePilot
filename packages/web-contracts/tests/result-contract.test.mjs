import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { API_ERROR_CODES, RESULT_LIMITS, validateResumeView, validateRunResultDto } from "../dist/index.js";

const fixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/fixtures/result-contract.json"), "utf8"));
const invalidFixture = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests/fixtures/result-contract-invalid.json"), "utf8"));

test("W4 result contract accepts the canonical fixture and exposes bounded limits", () => {
  assert.deepEqual(validateRunResultDto(fixture), { valid: true, errors: [] });
  assert.equal(RESULT_LIMITS.maxSections, 20);
  assert.equal(API_ERROR_CODES.includes("RESULT_NOT_READY"), true);
  assert.equal(API_ERROR_CODES.includes("RESULT_UNAVAILABLE"), true);
  assert.equal(API_ERROR_CODES.includes("RESULT_CONTRACT_INVALID"), true);
});

test("W4 result contract rejects unknown fields, missing required result data, and over-limit content", () => {
  assert.equal(validateRunResultDto(invalidFixture).valid, false);
  assert.equal(validateRunResultDto({ ...fixture, availability: "READY", resume: null }).valid, false);
  assert.equal(validateRunResultDto({ ...fixture, actionHistory: Array.from({ length: RESULT_LIMITS.maxActionHistory + 1 }, () => fixture.actionHistory[0]) }).valid, false);
  assert.equal(validateResumeView({ ...fixture.resume, sections: Array.from({ length: RESULT_LIMITS.maxSections + 1 }, () => fixture.resume.sections[0]) }).valid, false);
});
