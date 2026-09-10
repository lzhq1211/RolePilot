import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createBackendRegistry,
  createFallbackDecision,
} from "../../packages/platform-adapters/dist/index.js";
import { BACKEND_PROVIDERS } from "../../packages/platform-contracts/src/index.mjs";
import {
  createResumeGoalPlan,
  evaluatePolicyGate,
  selectFallbackPolicy,
  superviseStep,
} from "../../packages/platform-policy/dist/index.js";
import {
  createCheckpointStore,
  createDurableMemoryStore,
  createFileStateRoot,
} from "../../packages/platform-state/dist/index.js";
import {
  createWorkflowPlan,
  createWorkflowRuntime,
} from "../../packages/platform-runtime/dist/index.js";
import {
  cloneJsonFixture,
  loadIntegrationFixtureText,
} from "../../packages/platform-testkit/dist/index.js";
import {
  createResumeAgentBindings,
  runResumeVerticalSlice,
} from "../../apps/rolepilot-engine/dist/index.js";

function createTempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function scoreSuite(name, checks) {
  const passed = checks.filter((check) => check.pass);
  const failed = checks.filter((check) => !check.pass);
  const score = Math.round((passed.length / checks.length) * 100);

  assert.equal(
    failed.length,
    0,
    `${name} failed checks: ${failed.map((check) => check.label).join(", ")}`,
  );
  assert.equal(score, 100, `${name} expected a 100 score`);

  return { name, score, checks: checks.length };
}

function createAdapter(provider, outputText = provider) {
  return {
    provider,
    async execute(request) {
      return {
        requestId: request.requestId,
        provider: request.provider,
        mode: request.mode,
        status: "succeeded",
        outputText,
      };
    },
    async *stream() {},
    async health() {
      return { provider, ok: true, detail: "healthy" };
    },
    capabilities() {
      return {
        provider,
        executionModes: ["live", "stub", "replay"],
        supportsStreaming: true,
        supportsFallback: provider !== "codex",
      };
    },
  };
}

function createReplayBindings(overrides = {}) {
  return createResumeAgentBindings(
    {
      miner: { tool: "opencode" },
      writer: { tool: "claude", model: "claude-opus-4-6" },
      reviewer: { tool: "opencode" },
      interviewer: { tool: "opencode" },
    },
    overrides,
  );
}

function setReviewSignals(
  report,
  {
    average,
    pass = false,
    verdict,
    industryRolePassed = true,
    blockingIssue = "",
    globalTotal,
  },
) {
  report.overall.average = average;
  report.overall.pass = pass;
  report.overall.verdict =
    verdict ?? (pass ? "PASS" : industryRolePassed ? "REVISE" : "NEED_ROLE_INFO");
  report.industryRoleCheck.passed = industryRolePassed;
  report.industryRoleCheck.blockingIssue = blockingIssue;
  if (typeof globalTotal === "number") {
    report.globalFiveDimension.total = globalTotal;
  }
  return report;
}

function normalizeRunOutput(result, manifest, rootDir) {
  return {
    reviewLoop: {
      roundsUsed: manifest.reviewLoop.roundsUsed,
      stopReason: manifest.reviewLoop.stopReason,
      bestResumePath: manifest.reviewLoop.bestResumePath
        ? path
            .relative(rootDir, manifest.reviewLoop.bestResumePath)
            .replaceAll("\\", "/")
        : null,
      bestReviewPath: manifest.reviewLoop.bestReviewPath
        ? path
            .relative(rootDir, manifest.reviewLoop.bestReviewPath)
            .replaceAll("\\", "/")
        : null,
    },
    workflowManifest: manifest.workflowManifest,
    artifacts: manifest.artifactManifest.artifacts.map((artifact) => ({
      kind: artifact.kind,
      stage: artifact.stage,
      path: artifact.path,
    })),
    finalResume: path
      .relative(rootDir, result.finalResumePath)
      .replaceAll("\\", "/"),
    bestResume: path
      .relative(rootDir, result.bestResumePath)
      .replaceAll("\\", "/"),
    bestReview: path
      .relative(rootDir, result.bestReviewPath)
      .replaceAll("\\", "/"),
  };
}

test("provider registry offline evaluation harness scores deterministic routing and offline mode preservation", async () => {
  const registry = createBackendRegistry(
    BACKEND_PROVIDERS.map((provider) =>
      createAdapter(provider, `route:${provider}`),
    ),
  );

  const liveResult = await registry.execute({
    requestId: "provider-live",
    provider: "claude",
    mode: "live",
    input: "route me",
  });
  const replayResult = await registry.execute({
    requestId: "provider-replay",
    provider: "codex",
    mode: "replay",
    input: "offline only",
  });

  scoreSuite("provider registry", [
    {
      label: "stable provider list",
      pass:
        JSON.stringify(registry.list()) ===
        JSON.stringify(BACKEND_PROVIDERS),
    },
    {
      label: "resolved adapter identity",
      pass: registry.resolve({ provider: "opencode" }).provider === "opencode",
    },
    {
      label: "live route preserved",
      pass:
        liveResult.outputText === "route:claude" && liveResult.mode === "live",
    },
    {
      label: "offline mode preserved",
      pass: replayResult.provider === "codex" && replayResult.mode === "replay",
    },
  ]);
});

test("backend fallback offline evaluation harness scores retryable-live fallback decisions only", () => {
  const policyDecision = selectFallbackPolicy({
    provider: "claude",
    mode: "live",
    error: { code: "CLI_TIMEOUT", message: "timed out", retryable: true },
    config: { fallbackByProvider: { claude: "opencode" } },
  });
  const replayDecision = selectFallbackPolicy({
    provider: "claude",
    mode: "replay",
    error: { code: "CLI_TIMEOUT", message: "timed out", retryable: true },
    config: { fallbackByProvider: { claude: "opencode" } },
  });
  const normalizedDecision = createFallbackDecision({
    request: {
      requestId: "fallback-1",
      provider: "claude",
      mode: "live",
      input: "retry",
    },
    error: {
      requestId: "fallback-1",
      provider: "claude",
      mode: "live",
      code: "CLI_TIMEOUT",
      message: "timed out",
      retryable: true,
    },
    nextProvider: "opencode",
    reason: "retryable-primary-failure",
  });

  scoreSuite("backend fallback", [
    {
      label: "retryable live failure falls back",
      pass:
        policyDecision.shouldFallback === true &&
        policyDecision.toProvider === "opencode",
    },
    {
      label: "replay mode blocks fallback",
      pass: replayDecision.shouldFallback === false,
    },
    {
      label: "normalized decision keeps request id",
      pass:
        normalizedDecision.requestId === "fallback-1" &&
        normalizedDecision.toProvider === "opencode",
    },
  ]);
});

test("workflow runtime offline evaluation harness scores deterministic manifests and checkpoint restore parity", async () => {
  const plan = createWorkflowPlan([
    { id: "mine" },
    { id: "write", dependencies: ["mine"] },
    { id: "review", dependencies: ["write"] },
  ]);
  const executeTask = (task) => ({ finished: task.id });

  const firstRun = await createWorkflowRuntime({
    plan,
    executeTask,
    context: {},
  }).run();
  const secondRun = await createWorkflowRuntime({
    plan,
    executeTask,
    context: {},
  }).run();
  const stagedRun = await createWorkflowRuntime({
    plan,
    executeTask,
    context: {},
    shouldStopAfterTask: (task) => task.id === "write",
  }).run();
  const resumedRun = await createWorkflowRuntime({
    plan,
    executeTask,
    context: {},
    checkpoint: stagedRun.checkpoint,
  }).run();

  scoreSuite("workflow runtime", [
    {
      label: "execution order stays fixed",
      pass:
        JSON.stringify(plan.executionOrder) ===
        JSON.stringify(["mine", "write", "review"]),
    },
    {
      label: "uninterrupted manifests stay deterministic",
      pass:
        JSON.stringify(firstRun.manifest) ===
        JSON.stringify(secondRun.manifest),
    },
    {
      label: "checkpoint restore matches uninterrupted manifest",
      pass:
        JSON.stringify(firstRun.manifest) ===
        JSON.stringify(resumedRun.manifest),
    },
    {
      label: "checkpoint restore completes run",
      pass: resumedRun.stopReason === "completed",
    },
  ]);
});

test("memory separation offline evaluation harness scores checkpoint isolation and durable-memory boundaries", () => {
  const root = createFileStateRoot({
    rootDir: createTempRoot("platform-memory-eval-"),
  });
  const checkpointStore = createCheckpointStore({ root });
  const durableMemoryStore = createDurableMemoryStore({ root });

  checkpointStore.save({
    checkpointId: "cp-run-a-thread-1",
    runId: "run-a",
    threadId: "thread-1",
    planFingerprint: "plan-v1",
    snapshot: {
      schemaVersion: "v1",
      graph: { taskOrder: [], tasks: {} },
      events: [],
      stopReason: null,
      nextSequence: 1,
      manifest: {
        schemaVersion: "v1",
        taskOrder: [],
        completedTaskIds: [],
        failedTaskIds: [],
        stopReason: null,
        eventCount: 0,
      },
    },
  });
  checkpointStore.save({
    checkpointId: "cp-run-a-thread-2",
    runId: "run-a",
    threadId: "thread-2",
    planFingerprint: "plan-v1",
    snapshot: {
      schemaVersion: "v1",
      graph: { taskOrder: [], tasks: {} },
      events: [],
      stopReason: null,
      nextSequence: 1,
      manifest: {
        schemaVersion: "v1",
        taskOrder: [],
        completedTaskIds: [],
        failedTaskIds: [],
        stopReason: null,
        eventCount: 0,
      },
    },
  });
  durableMemoryStore.put("candidate-profile", {
    locale: "en",
    lane: "platform",
  });

  scoreSuite("memory separation", [
    {
      label: "checkpoint latest stays scoped to thread",
      pass:
        checkpointStore.readLatest({ runId: "run-a", threadId: "thread-1" })
          ?.checkpointId === "cp-run-a-thread-1",
    },
    {
      label: "other thread stays isolated",
      pass:
        checkpointStore.readLatest({ runId: "run-a", threadId: "thread-2" })
          ?.checkpointId === "cp-run-a-thread-2",
    },
    {
      label: "missing run thread stays empty",
      pass:
        checkpointStore.readLatest({ runId: "run-b", threadId: "thread-1" }) ===
        null,
    },
    {
      label: "durable memory does not become checkpoint state",
      pass:
        durableMemoryStore.get("candidate-profile")?.value?.lane ===
          "platform" &&
        checkpointStore.readLatest({ runId: "run-b", threadId: "thread-1" }) ===
          null,
    },
  ]);
});

test("policy gates offline evaluation harness scores bounded planning, forbidden-action blocks, and review-budget enforcement", () => {
  const plan = createResumeGoalPlan({
    goal: "Create a full workflow resume package with interview prep",
    hasTimelineContext: true,
  });
  const forbidden = evaluatePolicyGate({ action: "run-shell-command" });
  const approval = evaluatePolicyGate({ action: "share-resume-externally" });
  const supervisor = superviseStep({
    currentStep: "review",
    status: "failed",
    reviewPassed: false,
    reviewReplansUsed: 1,
    reviewReplanBudget: 1,
  });

  scoreSuite("policy gates", [
    {
      label: "goal plan stays bounded",
      pass: plan.ok === true && plan.value.maxSteps === 5,
    },
    {
      label: "forbidden shell action blocked",
      pass:
        forbidden.allowed === false &&
        forbidden.reasons[0]?.code === "FORBIDDEN_ACTION",
    },
    {
      label: "external sharing requires approval",
      pass:
        approval.allowed === false &&
        approval.reasons[0]?.code === "APPROVAL_REQUIRED",
    },
    {
      label: "review budget exhaustion escalates",
      pass:
        supervisor.decision === "escalate" &&
        supervisor.reasons[0]?.code === "REVIEW_BUDGET_EXHAUSTED",
    },
  ]);
});

test("resume vertical slice offline evaluation harness scores replay parity across repeated deterministic runs", async () => {
  const company = cloneJsonFixture("integration", "company");
  company.company = "Resume Vertical Slice Eval Co";
  company.title = "Platform Engineer";

  const baseResume = loadIntegrationFixtureText("resume");
  const revisedResume = baseResume.replace(
    "Deterministic CLI coverage baseline.",
    "First replay revision that should lose after early stop.",
  );
  const secondRevisedResume = baseResume.replace(
    "Deterministic CLI coverage baseline.",
    "Second replay revision selected from the retained Best candidate.",
  );
  const finalPolish = JSON.stringify({ entries: {
    "work:0": { bullets: ["Improved orchestrated CLI testing with deterministic stubs."] },
    "projects:0": { bullets: ["Built an offline integration harness for orchestration flows."] },
  } });
  const workSummary = (text) => {
    if (text.trim().startsWith("{")) {
      const parsed = JSON.parse(text);
      return parsed.sections?.find((section) => section.type === "experience")?.entries?.[0]?.bullets?.[0]?.content
        ?? parsed.content?.work?.[0]?.summary?.[0]?.text
        ?? parsed.content?.work?.[0]?.summary
        ?? null;
    }
    const contentWork = text.indexOf("  work:\n    - company");
    return text.slice(contentWork >= 0 ? contentWork : text.indexOf("  work:")).match(/summary:\s*(.+)/)?.[1]?.trim();
  };
  const firstReview = setReviewSignals(
    cloneJsonFixture("review", "revise"),
    {
      average: 7.8,
      globalTotal: 74,
    },
  );
  const secondReview = setReviewSignals(
    cloneJsonFixture("review", "revise"),
    {
      average: 8.3,
      industryRolePassed: false,
      blockingIssue:
        "Need verified target-role evidence before approving this revision.",
      verdict: "NEED_ROLE_INFO",
      globalTotal: 82,
    },
  );
  const optimizationDecision = {
    action: "REWRITE_SECTION",
    target: "content.basics.summary",
    reason: "Reorder the supported summary evidence for clarity.",
    evidenceRefs: ["timeline.content.work[0].summary"],
    expectedImprovement: "Improve clarity without adding facts.",
    risk: "medium",
  };
  const fallbackDecision = {
    action: "REORDER",
    target: "content.work",
    reason: "Put supported work evidence in a clearer order.",
    evidenceRefs: ["timeline.content.work[0].summary"],
    expectedImprovement: "Improve relevance without adding facts.",
    risk: "low",
  };

  const runOnce = async (rootDir, runId) =>
    runResumeVerticalSlice({
      rootDir,
      runId,
      company,
      importedResumeText: "Raw imported resume text for deterministic replay.",
      reviewReplanBudget: 2,
      maxReviewRounds: 3,
      agentBindings: createReplayBindings({
        miner: {
          mode: "replay",
          replayEntries: [{ text: loadIntegrationFixtureText("timeline") }],
        },
        writer: {
          mode: "replay",
          replayEntries: [
            {
              text: [
                "language: en",
                "title: Platform Engineer",
                "summary: Deterministic replay JD analysis.",
              ].join("\n"),
            },
            { text: baseResume },
            { text: revisedResume },
            { text: secondRevisedResume },
            { text: finalPolish },
          ],
        },
        reviewer: {
          mode: "replay",
          replayEntries: [
            { text: JSON.stringify(cloneJsonFixture("preflight", "proceed")) },
            { text: JSON.stringify(firstReview) },
            { text: JSON.stringify(optimizationDecision) },
            { text: JSON.stringify(secondReview) },
            { text: JSON.stringify(fallbackDecision) },
            { text: JSON.stringify(secondReview) },
          ],
        },
        interviewer: {
          mode: "replay",
          replayEntries: [
            { text: "# Interview\n\nDeterministic interview output." },
            { text: "# Cheatsheet\n\nDeterministic cheatsheet output." },
          ],
        },
      }),
    });

  const leftRoot = createTempRoot("resume-vertical-eval-left-");
  const rightRoot = createTempRoot("resume-vertical-eval-right-");
  const left = await runOnce(leftRoot, "resume-vertical-eval");
  const right = await runOnce(rightRoot, "resume-vertical-eval");
  const leftManifest = JSON.parse(fs.readFileSync(left.manifestPath, "utf8"));
  const rightManifest = JSON.parse(fs.readFileSync(right.manifestPath, "utf8"));
  const bestReview = JSON.parse(fs.readFileSync(left.bestReviewPath, "utf8"));

  scoreSuite("resume vertical slice", [
    {
      label: "early-stop requires two consecutive non-improving actions",
      pass:
        left.stopReason === "early-stop" &&
        left.reviewRoundsUsed === 3 &&
        left.optimizationActionsUsed === 2 &&
        left.actionHistory[1]?.sourceReviewPath ===
          left.actionHistory[0]?.sourceReviewPath,
    },
    {
      label: "best resume keeps first replay output",
      pass:
        workSummary(fs.readFileSync(left.finalResumePath, "utf8")) === workSummary(baseResume),
    },
    {
      label: "higher average role mismatch does not replace the best review",
      pass:
        bestReview.overall.verdict === "REVISE" &&
        bestReview.industryRoleCheck.passed === true,
    },
    {
      label: "repeated runs stay manifest-equivalent",
      pass:
        JSON.stringify(normalizeRunOutput(left, leftManifest, leftRoot)) ===
        JSON.stringify(normalizeRunOutput(right, rightManifest, rightRoot)),
    },
    {
      label: "artifacts and telemetry are emitted",
      pass:
        fs.existsSync(left.interviewPath) &&
        fs.existsSync(left.cheatsheetPath) &&
        fs.existsSync(left.telemetryPath),
    },
  ]);
});
