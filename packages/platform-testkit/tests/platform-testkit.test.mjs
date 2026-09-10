import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  INTEGRATION_FIXTURE_NAMES,
  OPTIMIZATION_FIXTURE_NAMES,
  REVIEW_FIXTURE_NAMES,
  REVIEW_FIXTURE_SEMANTICS,
  RUN_FIXTURE_NAMES,
  cloneJsonFixture,
  createStubPlayback,
  getFixturePath,
  loadAgentStubStateFromEnv,
  loadAgentStubStateFromFile,
  loadFixtureText,
  loadIntegrationCompanyFixture,
  loadOptimizationFixtureJson,
  loadReviewFixtureJson,
  loadRunFixtureJson,
} from "../dist/index.js";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "platform-testkit-"));
}

test("fixture parity preserves canonical offline review/run/integration fixtures", () => {
  assert.deepEqual(REVIEW_FIXTURE_NAMES, [
    "canonical-pass",
    "pass",
    "revise",
    "need-role-info",
    "malformed",
    "semantic-invalid",
    "invalid-semantic",
    "legacy-real-artifact",
  ]);
  assert.deepEqual(RUN_FIXTURE_NAMES, ["loop-score-sequence"]);
  assert.deepEqual(INTEGRATION_FIXTURE_NAMES, [
    "company",
    "resume",
    "timeline",
  ]);
  assert.deepEqual(OPTIMIZATION_FIXTURE_NAMES, [
    "valid-actions",
    "invalid-actions",
  ]);

  assert.equal(REVIEW_FIXTURE_SEMANTICS.pass, "pass");
  assert.equal(REVIEW_FIXTURE_SEMANTICS.revise, "revise");
  assert.equal(REVIEW_FIXTURE_SEMANTICS.malformed, "malformed");
  assert.equal(
    REVIEW_FIXTURE_SEMANTICS["semantic-invalid"],
    "semantic-invalid",
  );
  assert.equal(
    REVIEW_FIXTURE_SEMANTICS["invalid-semantic"],
    "semantic-invalid",
  );
  assert.equal(
    REVIEW_FIXTURE_SEMANTICS["legacy-real-artifact"],
    "legacy-real-artifact",
  );

  const passFixture = loadReviewFixtureJson("pass");
  const reviseFixture = loadReviewFixtureJson("revise");
  const needRoleInfoFixture = loadReviewFixtureJson("need-role-info");
  const semanticInvalidFixture = loadReviewFixtureJson("semantic-invalid");
  const invalidSemanticFixture = loadReviewFixtureJson("invalid-semantic");
  const legacyFixture = loadReviewFixtureJson("legacy-real-artifact");
  const runFixture = loadRunFixtureJson("loop-score-sequence");
  const companyFixture = loadIntegrationCompanyFixture();
  const resumeFixture = loadFixtureText("integration", "resume");
  const timelineFixture = loadFixtureText("integration", "timeline");
  const malformedText = loadFixtureText("review", "malformed");
  const validOptimization = loadOptimizationFixtureJson("valid-actions");
  const invalidOptimization = loadOptimizationFixtureJson("invalid-actions");

  assert.equal(passFixture.overall.verdict, "PASS");
  assert.equal(passFixture.overall.pass, true);
  assert.equal(reviseFixture.overall.verdict, "REVISE");
  assert.equal(reviseFixture.overall.pass, false);
  assert.equal(needRoleInfoFixture.overall.verdict, "NEED_ROLE_INFO");
  assert.equal(semanticInvalidFixture.overall.verdict, "PASS");
  assert.equal(semanticInvalidFixture.overall.pass, false);
  assert.deepEqual(semanticInvalidFixture, invalidSemanticFixture);
  assert.match(
    legacyFixture.moduleReviews[0].ruthlessDissection.fatalFlaw,
    /差异化/,
  );
  assert.match(legacyFixture.globalFiveDimension.eliminationWarning, /淘汰/);
  assert.equal(runFixture.cases.length, 3);
  assert.equal(companyFixture.company, "Integration Fixture Co");
  assert.match(resumeFixture, /Deterministic CLI coverage baseline\./);
  assert.match(timelineFixture, /offline regression coverage/i);
  assert.match(malformedText, /故意缺少 JSON 结尾/);
  assert.equal(validOptimization.cases.length, 7);
  assert.equal(invalidOptimization.cases.length, 8);
  assert.throws(
    () => loadReviewFixtureJson("malformed"),
    /Failed to parse review fixture "malformed"/,
  );

  const runClone = cloneJsonFixture("run", "loop-score-sequence");
  runClone.cases[0].name = "mutated";
  assert.equal(
    loadRunFixtureJson("loop-score-sequence").cases[0].name,
    "improving-then-pass",
  );

  assert.equal(
    fs.existsSync(getFixturePath("review", "legacy-real-artifact")),
    true,
  );
});

test("stub playback preserves queue order, relative file resolution, and env loading", () => {
  const tempDir = makeTempDir();

  try {
    const responsePath = path.join(tempDir, "review-pass.json");
    fs.writeFileSync(responsePath, loadFixtureText("review", "pass"), "utf8");

    const stubFilePath = path.join(tempDir, "agent-stubs.json");
    fs.writeFileSync(
      stubFilePath,
      JSON.stringify(
        {
          reviewer: [
            { file: "review-pass.json" },
            { text: "inline follow-up" },
          ],
          writer: "writer output",
        },
        null,
        2,
      ),
      "utf8",
    );

    const state = loadAgentStubStateFromFile(stubFilePath);
    const fromEnv = loadAgentStubStateFromEnv({
      ORCHESTRATE_AGENT_STUB_FILE: stubFilePath,
    });
    const playback = createStubPlayback(state);

    assert.equal(fromEnv?.stubPath, stubFilePath);
    assert.match(playback.take("reviewer"), /"verdict": "PASS"/);
    assert.equal(playback.remaining("reviewer"), 1);
    assert.equal(playback.take("reviewer"), "inline follow-up");
    assert.equal(playback.take("writer"), "writer output");
    assert.equal(playback.remaining("writer"), 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("stub playback keeps file-backed and inline text byte-equivalent", () => {
  const tempDir = makeTempDir();

  try {
    const responsePath = path.join(tempDir, "raw-response.txt");
    fs.writeFileSync(responsePath, "  hello from file  \n", "utf8");

    const stubFilePath = path.join(tempDir, "byte-equivalent-stubs.json");
    fs.writeFileSync(
      stubFilePath,
      JSON.stringify(
        {
          reviewer: [
            { file: "raw-response.txt" },
            { text: "  hello from file  \n" },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const state = loadAgentStubStateFromFile(stubFilePath);
    const playback = createStubPlayback(state);

    assert.equal(playback.take("reviewer"), "  hello from file  \n");
    assert.equal(playback.take("reviewer"), "  hello from file  \n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("stub playback rejects malformed queues and missing agent entries", () => {
  const tempDir = makeTempDir();

  try {
    const invalidStubFilePath = path.join(tempDir, "invalid-agent-stubs.json");
    fs.writeFileSync(
      invalidStubFilePath,
      JSON.stringify(
        {
          reviewer: [{ nope: true }],
        },
        null,
        2,
      ),
      "utf8",
    );

    const invalidState = loadAgentStubStateFromFile(invalidStubFilePath);
    const invalidPlayback = createStubPlayback(invalidState);

    assert.throws(
      () => invalidPlayback.take("reviewer"),
      /Stub response is missing text or file/,
    );
    assert.throws(
      () => invalidPlayback.take("writer"),
      /No stub response configured for agent "writer"/,
    );
    assert.equal(loadAgentStubStateFromEnv({}), null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
