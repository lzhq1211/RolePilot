import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  PLATFORM_RUNTIME_BOUNDARY,
  createCheckpointSnapshot,
  createFileWorkspace,
  createTelemetryEvent,
  createWorkflowPlan,
  createWorkflowRuntime,
  defaultWorkspaceLayout,
  describePlatformRuntimeBoundary,
} from "../dist/index.js";

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "platform-runtime-"));
}

test("platform-runtime exports a local-first workspace boundary", () => {
  assert.equal(PLATFORM_RUNTIME_BOUNDARY.packageName, "platform-runtime");
  assert.equal(PLATFORM_RUNTIME_BOUNDARY.executionModel, "local-first");
  assert.equal(PLATFORM_RUNTIME_BOUNDARY.workspace, "file-backed");
  assert.equal(describePlatformRuntimeBoundary(), "platform-runtime:runtime");
});

test("artifact manifest stays deterministic for the same run inputs", () => {
  const rootDir = createTempRoot();
  const workspace = createFileWorkspace({
    rootDir,
    runId: "run-001",
    createdAt: "2026-03-14T08:00:00.000Z",
  });

  const jdAnalysis = workspace.registerArtifact({
    kind: "jd-analysis",
    fileName: "backend-jd-analysis.yml",
    generator: "writer",
    stage: "draft",
  });
  const draftResume = workspace.registerArtifact({
    kind: "resume",
    fileName: "backend-resume.yml",
    generator: "writer",
    stage: "draft",
  });
  const finalResume = workspace.registerArtifact({
    kind: "resume",
    fileName: "backend-resume.final.yml",
    generator: "writer",
    stage: "final",
  });
  const interview = workspace.registerArtifact({
    kind: "interview",
    fileName: "backend-interview.md",
    generator: "interviewer",
  });
  const cheatsheet = workspace.registerArtifact({
    kind: "cheatsheet",
    fileName: "backend-cheatsheet.md",
    generator: "interviewer",
  });

  const manifest = workspace.createArtifactManifest();

  assert.deepEqual(
    manifest.artifacts.map((artifact) => ({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      stage: artifact.stage,
      path: artifact.path,
    })),
    [
      {
        artifactId: "run-001:cheatsheet:backend-cheatsheet-md",
        kind: "cheatsheet",
        stage: "deliverable",
        path: "cheatsheets/run-001/backend-cheatsheet.md",
      },
      {
        artifactId: "run-001:interview:backend-interview-md",
        kind: "interview",
        stage: "deliverable",
        path: "interviews/gem/run-001/backend-interview.md",
      },
      {
        artifactId: "run-001:jd-analysis:backend-jd-analysis-yml",
        kind: "jd-analysis",
        stage: "draft",
        path: "resumes/drafts/run-001/backend-jd-analysis.yml",
      },
      {
        artifactId: "run-001:resume:backend-resume-yml",
        kind: "resume",
        stage: "draft",
        path: "resumes/drafts/run-001/backend-resume.yml",
      },
      {
        artifactId: "run-001:resume:backend-resume-final-yml",
        kind: "resume",
        stage: "final",
        path: "resumes/gem/run-001/backend-resume.final.yml",
      },
    ],
  );

  assert.equal(
    workspace.resolveArtifactPath({
      kind: "review-report",
      fileName: "backend-review.json",
      generator: "reviewer",
    }),
    path.join(rootDir, "resumes", "drafts", "run-001", "backend-review.json"),
  );

  assert.deepEqual(manifest.layout, defaultWorkspaceLayout);
  assert.ok(fs.existsSync(path.dirname(jdAnalysis.absolutePath)));
  assert.ok(fs.existsSync(path.dirname(draftResume.absolutePath)));
  assert.ok(fs.existsSync(path.dirname(finalResume.absolutePath)));
  assert.ok(fs.existsSync(path.dirname(interview.absolutePath)));
  assert.ok(fs.existsSync(path.dirname(cheatsheet.absolutePath)));
});

test("telemetry persists event streams and formatted log lines", () => {
  const rootDir = createTempRoot();
  const workspace = createFileWorkspace({
    rootDir,
    runId: "run-telemetry",
    createdAt: "2026-03-14T08:00:00.000Z",
  });

  const startEvent = createTelemetryEvent({
    runId: "run-telemetry",
    sequence: 1,
    elapsedMs: 0,
    agent: "writer",
    backend: "claude",
    action: "resume-gen",
    detail: "根据 JD 分析 + 经历库生成简历",
  });
  const endEvent = createTelemetryEvent({
    runId: "run-telemetry",
    sequence: 2,
    elapsedMs: 15200,
    agent: "writer",
    backend: "claude",
    action: "resume-gen done",
    detail: "→ resumes/gem/run-telemetry/backend-resume.yml",
  });

  const recordedStart = workspace.recordTelemetry(startEvent);
  const recordedEnd = workspace.recordTelemetry(endEvent);
  const snapshot = workspace.readTelemetry();

  assert.equal(recordedStart.sequence, 1);
  assert.equal(recordedEnd.sequence, 2);
  assert.deepEqual(
    snapshot.events.map((event) => event.eventId),
    ["run-telemetry:event:0001", "run-telemetry:event:0002"],
  );
  assert.equal(
    snapshot.lines[0],
    "[0.0s] [writer→claude] resume-gen: 根据 JD 分析 + 经历库生成简历",
  );
  assert.equal(
    snapshot.lines[1],
    "[15.2s] [writer→claude] resume-gen done: → resumes/gem/run-telemetry/backend-resume.yml",
  );

  const eventStream = fs
    .readFileSync(snapshot.streamPath, "utf8")
    .trim()
    .split("\n");
  assert.equal(eventStream.length, 2);
  assert.equal(JSON.parse(eventStream[0]).eventId, "run-telemetry:event:0001");
  assert.equal(JSON.parse(eventStream[1]).eventId, "run-telemetry:event:0002");

  const logLines = fs.readFileSync(snapshot.logPath, "utf8").trim().split("\n");
  assert.deepEqual(logLines, snapshot.lines);
});

test("workspace and telemetry default timestamps use current runtime time instead of the Unix epoch", () => {
  const workspace = createFileWorkspace({
    rootDir: createTempRoot(),
    runId: "runtime-default-timestamps",
  });
  const event = createTelemetryEvent({
    runId: "runtime-default-timestamps",
    sequence: 1,
    elapsedMs: 0,
    agent: "writer",
    action: "resume-gen",
    detail: "default timestamp check",
  });

  assert.notEqual(workspace.createdAt, "1970-01-01T00:00:00.000Z");
  assert.notEqual(event.occurredAt, "1970-01-01T00:00:00.000Z");
  assert.equal(Number.isFinite(Date.parse(workspace.createdAt)), true);
  assert.equal(Number.isFinite(Date.parse(event.occurredAt)), true);
});

test("telemetry rejects invalid workspace shape and malformed events", () => {
  assert.throws(
    () =>
      createFileWorkspace({
        rootDir: createTempRoot(),
        runId: "bad-run",
        layout: {
          ...defaultWorkspaceLayout,
          logsDir: "../logs",
        },
      }),
    /Workspace layout field "logsDir" must stay within the workspace root/,
  );

  const workspace = createFileWorkspace({
    rootDir: createTempRoot(),
    runId: "good-run",
  });

  assert.throws(
    () =>
      workspace.recordTelemetry({
        eventId: "bad",
        level: "verbose",
        agent: "writer",
        action: "resume-gen",
      }),
    /Invalid telemetry event: level must be one of: debug, info, warn, error/,
  );

  assert.throws(
    () =>
      workspace.resolveArtifactPath({
        kind: "resume",
        fileName: "../escape.yml",
        generator: "writer",
      }),
    /Artifact fileName must be a simple file name/,
  );
});

test("workflow plan produces a deterministic execution order for the same task graph", () => {
  const inputs = [
    { id: "publish", dependencies: ["review", "build"] },
    { id: "build", dependencies: ["compile"] },
    { id: "compile", dependencies: ["lint"] },
    { id: "review", dependencies: ["compile"] },
    { id: "lint" },
  ];

  const left = createWorkflowPlan(inputs);
  const right = createWorkflowPlan([...inputs].reverse());

  assert.deepEqual(left.executionOrder, [
    "lint",
    "compile",
    "build",
    "review",
    "publish",
  ]);
  assert.deepEqual(right.executionOrder, left.executionOrder);
});

test("workflow plan rejects cycles and unknown task dependencies", () => {
  assert.throws(
    () =>
      createWorkflowPlan([
        { id: "a", dependencies: ["b"] },
        { id: "b", dependencies: ["a"] },
      ]),
    /contains a cycle/,
  );

  assert.throws(
    () =>
      createWorkflowPlan([{ id: "a", dependencies: ["missing"] }, { id: "b" }]),
    /depends on unknown task "missing"/,
  );
});

test("checkpoint runtime resumes from a serialized task graph without replaying completed side effects", async () => {
  const plan = createWorkflowPlan([
    { id: "fetch" },
    { id: "write", dependencies: ["fetch"] },
    { id: "notify", dependencies: ["write"] },
  ]);
  const calls = [];
  const executeTask = (task) => {
    calls.push(task.id);
    return { taskId: task.id };
  };

  const firstRuntime = createWorkflowRuntime({
    plan,
    executeTask,
    context: {},
    shouldStopAfterTask: (task) => task.id === "fetch",
  });

  const firstState = await firstRuntime.run();
  const restoredRuntime = createWorkflowRuntime({
    plan,
    executeTask,
    context: {},
    checkpoint: firstState.checkpoint,
  });
  const restoredState = await restoredRuntime.run();

  assert.deepEqual(calls, ["fetch", "write", "notify"]);
  assert.equal(restoredState.graph.tasks.fetch.status, "completed");
  assert.equal(restoredState.graph.tasks.write.status, "completed");
  assert.equal(restoredState.graph.tasks.notify.status, "completed");
});

test("checkpoint runtime produces the same manifest and stop reason after restore as a single uninterrupted run", async () => {
  const plan = createWorkflowPlan([
    { id: "lint" },
    { id: "compile", dependencies: ["lint"] },
    { id: "package", dependencies: ["compile"] },
  ]);

  const executeTask = (task) => ({ finished: task.id });

  const uninterruptedRuntime = createWorkflowRuntime({
    plan,
    executeTask,
    context: {},
  });
  const uninterruptedState = await uninterruptedRuntime.run();

  const stagedRuntime = createWorkflowRuntime({
    plan,
    executeTask,
    context: {},
    shouldStopAfterTask: (task) => task.id === "compile",
  });
  const stagedState = await stagedRuntime.run();
  const restoredRuntime = createWorkflowRuntime({
    plan,
    executeTask,
    context: {},
    checkpoint: createCheckpointSnapshot({
      plan,
      graph: stagedState.graph,
      events: stagedState.events,
      stopReason: stagedState.stopReason,
    }),
  });
  const restoredState = await restoredRuntime.run();

  assert.equal(uninterruptedState.stopReason, "completed");
  assert.equal(restoredState.stopReason, uninterruptedState.stopReason);
  assert.deepEqual(restoredState.manifest, uninterruptedState.manifest);
});

test("workflow runtime marks aborted executions as cancelled instead of failed", async () => {
  const controller = new AbortController();
  const plan = createWorkflowPlan([{ id: "write" }, { id: "review", dependencies: ["write"] }]);

  const runtime = createWorkflowRuntime({
    plan,
    context: {},
    signal: controller.signal,
    executeTask: async (task) => {
      if (task.id === "write") {
        controller.abort(new Error("Run cancelled by user."));
        throw Object.assign(new Error("Run cancelled by user."), {
          name: "AbortError",
          code: "CLI_CANCELLED",
        });
      }
      return { ok: true };
    },
  });

  const state = await runtime.run();
  assert.equal(state.stopReason, "cancelled");
  assert.equal(state.graph.tasks.write.status, "failed");
  assert.equal(state.graph.tasks.review.status, "pending");
  assert.equal(state.manifest.stopReason, "cancelled");
});

test("checkpoint runtime rejects malformed v1 snapshots with a descriptive error", () => {
  const plan = createWorkflowPlan([{ id: "lint" }]);

  assert.throws(
    () =>
      createWorkflowRuntime({
        plan,
        executeTask: () => ({ ok: true }),
        context: {},
        checkpoint: {
          schemaVersion: "v1",
          graph: { taskOrder: [], tasks: {} },
          events: "not-an-array",
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
      }),
    /Checkpoint snapshot events must be an array\./,
  );
});
