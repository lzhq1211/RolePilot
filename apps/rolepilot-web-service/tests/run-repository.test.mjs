import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryIdempotencyStore,
  InMemoryRunRepository,
  IdempotencyKeyConflictError,
  RunRepositoryError,
  toRunDto,
} from "../dist/index.js";

const BASE_TIME = "2026-09-05T00:00:00.000Z";

function createRunInput(id = "run-1", eventId = `${id}-event-1`) {
  return {
    id,
    resumeSourceId: "source-1",
    company: "RolePilot",
    title: "AI 产品经理",
    jdText: "负责证据驱动的简历优化。",
    extractedTextObjectKey: "sources/source-1/extracted.txt",
    createdAt: BASE_TIME,
    eventId,
  };
}

function statusEvent(runId, sequence, status, createdAt, stopReason = null, failureCode = null, id = `event-${sequence}`) {
  return {
    id,
    runId,
    sequence,
    type: "run.status",
    payload: { runId, status, stopReason, failureCode },
    createdAt,
  };
}

test("Run Repository creates an immutable input snapshot and atomically advances event sequence", async () => {
  const repository = new InMemoryRunRepository({ clock: () => "2026-09-05T00:00:01.000Z" });
  const created = await repository.create(createRunInput());

  assert.equal(created.status, "QUEUED");
  assert.equal(created.lastEventSequence, 1);
  assert.equal((await repository.eventsAfter(created.id, 0))[0].sequence, 1);
  assert.equal(toRunDto(created).jdText, undefined);
  assert.equal(toRunDto(created).lastEventSequence, undefined);
  assert.equal(toRunDto(created).cleanupStatus, undefined);

  const claimed = await repository.claimNext("event-2");
  assert.equal(claimed.status, "RUNNING");
  assert.equal(claimed.lastEventSequence, 2);

  const runningSteps = claimed.stepStatuses.map((step) =>
    step.id === "mine" ? { ...step, status: "running" } : step,
  );
  const afterStep = await repository.transition({
    runId: claimed.id,
    expectedStatus: "RUNNING",
    nextStatus: "RUNNING",
    currentStep: "mine",
    stepStatuses: runningSteps,
    stopReason: null,
    failureCode: null,
    completedAt: null,
    event: {
      id: "event-3",
      runId: claimed.id,
      sequence: 3,
      type: "run.step",
      payload: { runId: claimed.id, stepId: "mine", status: "running", durationMs: null },
      createdAt: "2026-09-05T00:00:02.000Z",
    },
  });
  assert.equal(afterStep.currentStep, "mine");
  assert.equal(afterStep.stepStatuses[0].status, "running");

  const completedSteps = afterStep.stepStatuses.map((step) => ({ ...step, status: "completed" }));
  const completed = await repository.transition({
    runId: afterStep.id,
    expectedStatus: "RUNNING",
    nextStatus: "COMPLETED",
    currentStep: "review",
    stepStatuses: completedSteps,
    stopReason: "pass",
    failureCode: null,
    completedAt: "2026-09-05T00:00:03.000Z",
    event: {
      id: "event-4",
      runId: afterStep.id,
      sequence: 4,
      type: "run.completed",
      payload: { runId: afterStep.id, status: "COMPLETED", stopReason: "pass" },
      createdAt: "2026-09-05T00:00:03.000Z",
    },
  });

  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.failureCode, null);
  assert.equal(completed.lastEventSequence, 4);
  await assert.rejects(
    () =>
      repository.transition({
        runId: completed.id,
        expectedStatus: "COMPLETED",
        nextStatus: "COMPLETED",
        currentStep: "review",
        stepStatuses: completed.stepStatuses,
        stopReason: "pass",
        failureCode: null,
        completedAt: completed.completedAt,
        event: statusEvent(completed.id, 5, "COMPLETED", "2026-09-05T00:00:04.000Z", "pass"),
      }),
    (error) => error instanceof RunRepositoryError && error.code === "RUN_CONFLICT",
  );
  assert.deepEqual(
    (await repository.eventsAfter(created.id, 0)).map((event) => event.sequence),
    [1, 2, 3, 4],
  );
});

test("Run Repository supports NEEDS_USER_INPUT evidence metadata without storing evidence text", async () => {
  const repository = new InMemoryRunRepository();
  const created = await repository.create(createRunInput("run-needs", "needs-event-1"));
  const running = await repository.claimNext("needs-event-2");
  const waitingSteps = running.stepStatuses.map((step) =>
    step.id === "preflight" ? { ...step, status: "waiting" } : step,
  );
  const waiting = await repository.transition({
    runId: running.id,
    expectedStatus: "RUNNING",
    nextStatus: "NEEDS_USER_INPUT",
    currentStep: "preflight",
    stepStatuses: waitingSteps,
    stopReason: "needs-user-input",
    failureCode: null,
    pendingUserQuestions: ["请补充项目结果。"],
    completedAt: null,
    event: statusEvent(
      running.id,
      3,
      "NEEDS_USER_INPUT",
      "2026-09-05T00:00:03.000Z",
      "needs-user-input",
    ),
  });
  assert.equal(waiting.pendingUserQuestions.length, 1);

  const evidence = await repository.createEvidence({
    id: "evidence-1",
    runId: waiting.id,
    requestFingerprint: "sha256:evidence",
    storageObjectKey: "runs/run-needs/evidence/evidence-1.txt",
    byteLength: 24,
    characterLength: 10,
  });
  assert.equal(evidence.status, "PENDING");
  assert.equal("evidenceText" in evidence, false);
  assert.equal((await repository.get(waiting.id)).pendingEvidenceSubmissionId, evidence.id);

  const consumed = await repository.updateEvidenceStatus(
    evidence.id,
    "CONSUMED",
    "2026-09-05T00:00:04.000Z",
  );
  assert.equal(consumed.consumedAt, "2026-09-05T00:00:04.000Z");
  assert.equal((await repository.get(waiting.id)).pendingEvidenceSubmissionId, null);
  assert.equal(created.id, "run-needs");
});

test("startup recovery converts only active RUNNING runs and abandons pending evidence", async () => {
  const repository = new InMemoryRunRepository({ clock: () => "2026-09-05T00:00:10.000Z" });
  const created = await repository.create(createRunInput("run-recover", "recover-event-1"));
  const running = await repository.claimNext("recover-event-2");
  const runningSteps = running.stepStatuses.map((step) =>
    step.id === "mine" ? { ...step, status: "running" } : step,
  );
  await repository.transition({
    runId: running.id,
    expectedStatus: "RUNNING",
    nextStatus: "RUNNING",
    currentStep: "mine",
    stepStatuses: runningSteps,
    stopReason: null,
    failureCode: null,
    completedAt: null,
    event: {
      id: "recover-event-3",
      runId: running.id,
      sequence: 3,
      type: "run.step",
      payload: { runId: running.id, stepId: "mine", status: "running", durationMs: null },
      createdAt: "2026-09-05T00:00:03.000Z",
    },
  });
  const evidence = await repository.createEvidence({
    id: "recover-evidence",
    runId: running.id,
    requestFingerprint: "sha256:recover",
    storageObjectKey: "runs/run-recover/evidence/recover.txt",
    byteLength: 10,
    characterLength: 10,
  });

  assert.equal(await repository.startupRecoverRunning(), 1);
  const recovered = await repository.get(created.id);
  assert.equal(recovered.status, "FAILED");
  assert.equal(recovered.failureCode, "WORKER_INTERRUPTED");
  assert.equal(recovered.cleanupStatus, "PENDING");
  assert.equal(recovered.stepStatuses[0].status, "failed");
  assert.equal((await repository.getEvidence(evidence.id)).status, "ABANDONED");
  assert.equal((await repository.eventsAfter(created.id, 0)).at(-1).type, "run.failed");
});

test("Run create idempotency reuses one target and rejects different fingerprints", async () => {
  const repository = new InMemoryRunRepository();
  const first = await repository.createIdempotent({
    ...createRunInput("run-idempotent", "idempotent-event-1"),
    idempotencyKey: "key-1",
    requestFingerprint: "sha256:one",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  const repeated = await repository.createIdempotent({
    ...createRunInput("run-other", "idempotent-event-2"),
    idempotencyKey: "key-1",
    requestFingerprint: "sha256:one",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  assert.equal(first.reused, false);
  assert.equal(repeated.reused, true);
  assert.equal(repeated.run.id, first.run.id);
  await assert.rejects(
    () =>
      repository.createIdempotent({
        ...createRunInput("run-conflict", "idempotent-event-3"),
        idempotencyKey: "key-1",
        requestFingerprint: "sha256:two",
        expiresAt: "2030-01-01T00:00:00.000Z",
      }),
    (error) => error instanceof IdempotencyKeyConflictError,
  );
});

test("Source idempotency records retain the old source result shape after polymorphic expansion", async () => {
  const store = new InMemoryIdempotencyStore({ clock: () => BASE_TIME });
  const record = {
    requestFingerprint: "sha256:source",
    resultKind: "source",
    resultId: "source-1",
    sourceId: "source-1",
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
  await store.put("resume-sources.create", "legacy-key", record);
  assert.deepEqual(await store.get("resume-sources.create", "legacy-key"), record);
});

test("Run source references exclude soft-deleted runs", async () => {
  const repository = new InMemoryRunRepository();
  await repository.create(createRunInput("run-reference", "reference-event-1"));
  assert.equal(await repository.isReferencedByRun("source-1"), true);
  await repository.softDelete("run-reference");
  assert.equal(await repository.isReferencedByRun("source-1"), false);
  assert.equal((await repository.list()).length, 0);
});
