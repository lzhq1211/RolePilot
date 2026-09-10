import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  AGENT_STUB_ENV_VAR,
  ARTIFACT_KINDS,
  BACKEND_CAPABILITY_VOCABULARY,
  BACKEND_EXECUTION_MODES,
  BACKEND_PROVIDERS,
  EXECUTION_STATUSES,
  FAILURE_POLICY_MODES,
  LOG_EVENT_LEVELS,
  REVIEW_STOP_REASONS,
  validateArtifactManifest,
  validateExecutionRequest,
  validateExecutionResult,
  validateLogEvent,
  validatePolicyDecision,
} from "../../packages/platform-contracts/src/index.mjs";

const FIXTURES_DIR = path.join(process.cwd(), "tests", "contracts", "fixtures");

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
}

test("contract drift: backend/provider vocabulary stays frozen around CLI and direct API providers", () => {
  const fixture = loadFixture("backend-vocabulary.json");

  assert.deepEqual(BACKEND_PROVIDERS, fixture.providers);
  assert.deepEqual(BACKEND_EXECUTION_MODES, fixture.executionModes);
  assert.equal(AGENT_STUB_ENV_VAR, fixture.stubEnvVar);
  assert.deepEqual(BACKEND_CAPABILITY_VOCABULARY.providers, BACKEND_PROVIDERS);
  assert.deepEqual(
    BACKEND_CAPABILITY_VOCABULARY.executionModes,
    BACKEND_EXECUTION_MODES,
  );
  assert.deepEqual(
    BACKEND_CAPABILITY_VOCABULARY.configFields,
    fixture.configFields,
  );
});

test("contract drift: failure-policy and review stop vocabularies reject string drift", () => {
  const fixture = loadFixture("backend-vocabulary.json");

  assert.deepEqual(FAILURE_POLICY_MODES, fixture.failurePolicyModes);
  assert.deepEqual(REVIEW_STOP_REASONS, fixture.reviewStopReasons);
});

test("contract drift: execution request/result contracts validate the frozen vocabulary", () => {
  const request = validateExecutionRequest({
    requestId: "req-1",
    agent: "writer",
    backend: { provider: "claude", mode: "stub" },
    steps: ["jd-analysis", "resume-gen"],
  });
  const badRequest = validateExecutionRequest({
    requestId: "req-2",
    agent: "reviewer",
    backend: { provider: "gpt", mode: "simulate" },
    steps: [],
  });
  const result = validateExecutionResult({
    requestId: "req-1",
    status: "succeeded",
    artifacts: [],
  });

  assert.equal(request.valid, true);
  assert.equal(result.valid, true);
  assert.equal(badRequest.valid, false);
  assert.match(
    badRequest.errors.join("\n"),
    /backend\.provider must be one of: claude, opencode, codex, openai-chat, anthropic-api/,
  );
  assert.match(
    badRequest.errors.join("\n"),
    /backend\.mode must be one of: live, stub, replay/,
  );
  assert.match(badRequest.errors.join("\n"), /steps must be a non-empty array/);
  assert.deepEqual(
    EXECUTION_STATUSES,
    loadFixture("backend-vocabulary.json").executionStatuses,
  );
});

test("contract drift: artifact manifest log event and policy decision contracts stay runnable and explicit", () => {
  const fixture = loadFixture("backend-vocabulary.json");

  assert.deepEqual(ARTIFACT_KINDS, fixture.artifactKinds);
  assert.deepEqual(LOG_EVENT_LEVELS, fixture.logEventLevels);

  assert.equal(
    validateArtifactManifest({
      artifactId: "a-1",
      kind: "review-report",
      path: "resumes/drafts/review-1.json",
    }).valid,
    true,
  );
  assert.equal(
    validateLogEvent({
      eventId: "e-1",
      level: "info",
      agent: "writer",
      action: "resume-gen",
    }).valid,
    true,
  );
  assert.equal(
    validatePolicyDecision({
      round: 2,
      average: 7.9,
      shouldStop: true,
      shouldRevise: false,
      stopReason: "early-stop",
    }).valid,
    true,
  );
  assert.equal(
    validatePolicyDecision({
      round: 0,
      average: 11,
      shouldStop: "yes",
      shouldRevise: false,
      stopReason: "halt",
    }).valid,
    false,
  );
});
