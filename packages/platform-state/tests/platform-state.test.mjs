import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CheckpointNotFoundError,
  PlanFingerprintMismatchError,
  StaleCheckpointError,
  UnsupportedCheckpointSchemaError,
  createCheckpointStore,
  createDurableMemoryStore,
  createFileStateRoot,
} from "../dist/index.js";
import {
  createCheckpointSnapshot,
  createTaskGraph,
  createWorkflowPlan,
} from "../../platform-runtime/dist/index.js";

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "platform-state-"));
}

function createSnapshot() {
  const plan = createWorkflowPlan([{ id: "draft-resume" }]);
  return createCheckpointSnapshot({
    plan,
    graph: createTaskGraph(plan),
    events: [],
    stopReason: null,
  });
}

test("memory separation: checkpoint state stays isolated by run id and thread id", () => {
  const root = createFileStateRoot({ rootDir: createTempRoot() });
  const checkpointStore = createCheckpointStore({ root });

  checkpointStore.save({
    checkpointId: "cp-run-1-thread-a",
    runId: "run-1",
    threadId: "thread-a",
    planFingerprint: "plan-v1",
    snapshot: createSnapshot(),
  });
  checkpointStore.save({
    checkpointId: "cp-run-1-thread-b",
    runId: "run-1",
    threadId: "thread-b",
    planFingerprint: "plan-v1",
    snapshot: createSnapshot(),
  });
  checkpointStore.save({
    checkpointId: "cp-run-2-thread-a",
    runId: "run-2",
    threadId: "thread-a",
    planFingerprint: "plan-v1",
    snapshot: createSnapshot(),
  });

  assert.equal(
    checkpointStore.readLatest({ runId: "run-1", threadId: "thread-a" })
      ?.checkpointId,
    "cp-run-1-thread-a",
  );
  assert.equal(
    checkpointStore.readLatest({ runId: "run-1", threadId: "thread-b" })
      ?.checkpointId,
    "cp-run-1-thread-b",
  );
  assert.equal(
    checkpointStore.readLatest({ runId: "run-2", threadId: "thread-a" })
      ?.checkpointId,
    "cp-run-2-thread-a",
  );
  assert.equal(
    checkpointStore.readLatest({ runId: "run-2", threadId: "thread-b" }),
    null,
  );
});

test("memory separation: durable memory persists across runs without becoming checkpoint state", () => {
  const root = createFileStateRoot({ rootDir: createTempRoot() });
  const checkpointStore = createCheckpointStore({ root });
  const durableMemoryStore = createDurableMemoryStore({ root });

  durableMemoryStore.put("candidate-profile", {
    preferredLocale: "en",
    focus: "platform",
  });
  checkpointStore.save({
    checkpointId: "cp-run-1-thread-a",
    runId: "run-1",
    threadId: "thread-a",
    planFingerprint: "plan-v1",
    snapshot: createSnapshot(),
  });

  assert.deepEqual(durableMemoryStore.get("candidate-profile")?.value, {
    preferredLocale: "en",
    focus: "platform",
  });
  assert.equal(
    checkpointStore.readLatest({ runId: "run-2", threadId: "thread-a" }),
    null,
  );
  assert.throws(
    () =>
      checkpointStore.resume({
        runId: "run-2",
        threadId: "thread-a",
        planFingerprint: "plan-v1",
      }),
    CheckpointNotFoundError,
  );
});

test("checkpoint resume: resumes the latest checkpoint for the same run and thread", () => {
  const root = createFileStateRoot({ rootDir: createTempRoot() });
  const checkpointStore = createCheckpointStore({ root });

  checkpointStore.save({
    checkpointId: "checkpoint-002",
    runId: "run-42",
    threadId: "thread-main",
    planFingerprint: "fingerprint-1",
    snapshot: createSnapshot(),
  });

  const resumed = checkpointStore.resume({
    runId: "run-42",
    threadId: "thread-main",
    planFingerprint: "fingerprint-1",
    expectedCheckpointId: "checkpoint-002",
  });

  assert.equal(resumed.checkpointId, "checkpoint-002");
  assert.equal(resumed.runId, "run-42");
  assert.equal(resumed.threadId, "thread-main");
  assert.equal(resumed.snapshot.schemaVersion, "v1");
});

test("checkpoint resume: rejects stale checkpoint when expected checkpoint id does not match", () => {
  const root = createFileStateRoot({ rootDir: createTempRoot() });
  const checkpointStore = createCheckpointStore({ root });

  checkpointStore.save({
    checkpointId: "checkpoint-new",
    runId: "run-42",
    threadId: "thread-main",
    planFingerprint: "fingerprint-1",
    snapshot: createSnapshot(),
  });

  assert.throws(
    () =>
      checkpointStore.resume({
        runId: "run-42",
        threadId: "thread-main",
        planFingerprint: "fingerprint-1",
        expectedCheckpointId: "checkpoint-old",
      }),
    StaleCheckpointError,
  );
});

test("checkpoint resume: rejects checkpoint replay when plan fingerprint does not match", () => {
  const root = createFileStateRoot({ rootDir: createTempRoot() });
  const checkpointStore = createCheckpointStore({ root });

  checkpointStore.save({
    checkpointId: "checkpoint-002",
    runId: "run-42",
    threadId: "thread-main",
    planFingerprint: "fingerprint-1",
    snapshot: createSnapshot(),
  });

  assert.throws(
    () =>
      checkpointStore.resume({
        runId: "run-42",
        threadId: "thread-main",
        planFingerprint: "fingerprint-2",
      }),
    PlanFingerprintMismatchError,
  );
});

test("checkpoint resume: rejects unsupported schema", () => {
  const rootDir = createTempRoot();
  const root = createFileStateRoot({ rootDir });
  const checkpointStore = createCheckpointStore({ root });
  const checkpointPath = path.join(
    root.stateDir,
    "checkpoints",
    "run-42",
    "thread-main.json",
  );

  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  fs.writeFileSync(
    checkpointPath,
    JSON.stringify({
      schemaVersion: "v1",
      checkpointId: "checkpoint-002",
      runId: "run-42",
      threadId: "thread-main",
      planFingerprint: "fingerprint-1",
      createdAt: "2026-03-14T08:00:00.000Z",
      snapshot: {
        schemaVersion: "v2",
      },
    }),
  );

  assert.throws(
    () =>
      checkpointStore.resume({
        runId: "run-42",
        threadId: "thread-main",
        planFingerprint: "fingerprint-1",
      }),
    UnsupportedCheckpointSchemaError,
  );
});

test("checkpoint save: rejects malformed v1 snapshots before writing them", () => {
  const root = createFileStateRoot({ rootDir: createTempRoot() });
  const checkpointStore = createCheckpointStore({ root });

  assert.throws(
    () =>
      checkpointStore.save({
        checkpointId: "checkpoint-bad",
        runId: "run-42",
        threadId: "thread-main",
        planFingerprint: "fingerprint-1",
        snapshot: {
          schemaVersion: "v1",
          graph: { taskOrder: [], tasks: {} },
          events: [],
          stopReason: null,
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
    UnsupportedCheckpointSchemaError,
  );
});

test("checkpoint readLatest: rejects malformed v1 snapshots with a schema error", () => {
  const rootDir = createTempRoot();
  const root = createFileStateRoot({ rootDir });
  const checkpointStore = createCheckpointStore({ root });
  const checkpointPath = path.join(
    root.stateDir,
    "checkpoints",
    "run-42",
    "thread-main.json",
  );

  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  fs.writeFileSync(
    checkpointPath,
    JSON.stringify({
      schemaVersion: "v1",
      checkpointId: "checkpoint-002",
      runId: "run-42",
      threadId: "thread-main",
      planFingerprint: "fingerprint-1",
      createdAt: "2026-03-14T08:00:00.000Z",
      snapshot: {
        schemaVersion: "v1",
        graph: { taskOrder: [], tasks: {} },
        events: "bad-events",
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
  );

  assert.throws(
    () => checkpointStore.readLatest({ runId: "run-42", threadId: "thread-main" }),
    UnsupportedCheckpointSchemaError,
  );
});
