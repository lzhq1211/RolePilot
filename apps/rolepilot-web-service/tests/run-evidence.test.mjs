import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InMemoryRunEvidenceObjectStore, InMemoryRunRepository, InMemorySourceObjectStore, InMemorySourceRepository, InProcessRunQueue, InProcessRunWorker, RunEventHub, RunService, packRunCheckpoint, submitRunEvidence } from "../dist/index.js";

async function setup() {
  const store = new InMemorySourceObjectStore(); const runs = new InMemoryRunRepository(); const sources = new InMemorySourceRepository({ objectStore: store, referenceReader: runs });
  await sources.createPending({ id: "evidence-source", inputKind: "pasted-text", originalFileName: null, mediaType: "text/plain", sizeBytes: 1 });
  await store.put({ key: "sources/evidence-source/extracted.txt", bytes: new TextEncoder().encode("resume"), contentType: "text/plain" });
  await sources.markReady("evidence-source", { parsed: { mediaType: "text/plain", text: "resume", textLength: 6, pageCount: null, parserVersion: "test" }, originalObjectKey: "sources/evidence-source/original.txt", extractedTextObjectKey: "sources/evidence-source/extracted.txt" });
  const service = new RunService({ sourceRepository: sources, runRepository: runs, workDir: path.join(os.tmpdir(), `rolepilot-evidence-${Date.now()}`), idFactory: () => "run-evidence-1", eventIdFactory: () => "event-1" });
  await service.create({ resumeSourceId: "evidence-source", company: "RolePilot", title: "AI PM", jdText: "JD" }, "evidence-create");
  const running = await runs.claimNext("event-running");
  await runs.transition({ runId: running.id, expectedStatus: "RUNNING", nextStatus: "NEEDS_USER_INPUT", currentStep: "preflight", stepStatuses: running.stepStatuses.map((step) => step.id === "preflight" ? { ...step, status: "waiting" } : step), stopReason: "needs-user-input", failureCode: null, pendingUserQuestions: ["请补充结果"], completedAt: null, event: { id: "event-needs", runId: running.id, sequence: 3, type: "run.status", payload: { runId: running.id, status: "NEEDS_USER_INPUT", stopReason: "needs-user-input", failureCode: null }, createdAt: new Date().toISOString() } });
  return { runs, sources, store, service, runId: running.id, workDir: service, evidenceStore: new InMemoryRunEvidenceObjectStore() };
}

test("evidence submission stores metadata only and requeues the same Run", async (t) => {
  const h = await setup();
  const objectStore = new InMemoryRunEvidenceObjectStore();
  const evidence = await submitRunEvidence({ runService: h.service, runRepository: h.runs, objectStore, runId: h.runId, evidenceText: "项目结果：转化率提升 20%" });
  assert.equal(evidence.status, "PENDING");
  assert.equal((await h.runs.get(h.runId)).status, "QUEUED");
  assert.equal((await h.runs.get(h.runId)).pendingUserQuestions.length, 0);
  assert.equal("evidenceText" in evidence, false);
  assert.equal(await objectStore.read(evidence.storageObjectKey), "项目结果：转化率提升 20%");
  await assert.rejects(() => submitRunEvidence({ runService: h.service, runRepository: h.runs, objectStore, runId: h.runId, evidenceText: "重复" }), /RUN_NOT_RESUMABLE/);
});

test("worker consumes pending evidence and invokes checkpoint resume", async () => {
  const h = await setup(); const objectStore = new InMemoryRunEvidenceObjectStore();
  const workerWorkDir = path.join(os.tmpdir(), `rolepilot-evidence-worker-${Date.now()}`);
  const checkpointRoot = path.join(workerWorkDir, "runs", h.runId);
  await fs.mkdir(path.join(checkpointRoot, ".state", "checkpoints", h.runId), { recursive: true });
  await fs.writeFile(path.join(checkpointRoot, ".state", "checkpoints", h.runId, "resume-vertical-slice.json"), "{}");
  const checkpointBytes = await packRunCheckpoint(checkpointRoot, h.runId);
  await h.runs.createArtifact({ id: "checkpoint-evidence-1", runId: h.runId, artifactType: "checkpoint", stage: "supporting", status: "STAGED", storageObjectKey: "runs/checkpoint-evidence-1.json", relativePath: ".checkpoint-recovery.json", mimeType: "application/json", sizeBytes: checkpointBytes.byteLength });
  await h.store.put({ key: "runs/checkpoint-evidence-1.json", bytes: checkpointBytes, contentType: "application/json" });
  await h.runs.updateArtifactStatus("checkpoint-evidence-1", "PUBLISHED", new Date().toISOString());
  const waiting = await h.runs.get(h.runId);
  await h.runs.transition({ runId: h.runId, expectedStatus: "NEEDS_USER_INPUT", nextStatus: "NEEDS_USER_INPUT", currentStep: "preflight", stepStatuses: waiting.stepStatuses, stopReason: "needs-user-input", failureCode: null, pendingUserQuestions: ["请补充结果"], checkpointArtifactId: "checkpoint-evidence-1", completedAt: null, event: { id: "event-waiting", runId: h.runId, sequence: waiting.lastEventSequence + 1, type: "run.status", payload: { runId: h.runId, status: "NEEDS_USER_INPUT", stopReason: "needs-user-input", failureCode: null }, createdAt: new Date().toISOString() } });
  const firstSubmission = await submitRunEvidence({ runService: h.service, runRepository: h.runs, objectStore, runId: h.runId, evidenceText: "补充证据" });
  let resumed = false; let received = "";
  const { AnswerInterpretationError } = await import("../../rolepilot-engine/dist/index.js");
  let calls = 0;
  const runFn = async (input) => {
    resumed = input.resumeFromCheckpoint; received = input.userEvidenceText;
    if (calls++ === 0) throw new AnswerInterpretationError("preflight", ["请补充结果"], new Error("invalid answer JSON"));
    return { stopReason: "pass", artifactManifest: { artifacts: [] } };
  };
  const queue = new InProcessRunQueue(h.service); const worker = new InProcessRunWorker({ queue, runRepository: h.runs, sourceRepository: h.sources, workDir: workerWorkDir, artifactStore: h.store, evidenceStore: objectStore, agentBindings: { miner: { provider: "openai-chat", mode: "stub" }, writer: { provider: "openai-chat", mode: "stub" }, reviewer: { provider: "openai-chat", mode: "stub" }, interviewer: { provider: "openai-chat", mode: "stub" } }, runFn });
  await worker.processOne();
  assert.equal((await h.runs.get(h.runId)).status, "NEEDS_USER_INPUT");
  assert.deepEqual((await h.runs.get(h.runId)).pendingUserQuestions, ["请补充结果"]);
  assert.equal((await h.runs.getEvidence(firstSubmission.id)).status, "ABANDONED");
  const retrySubmission = await submitRunEvidence({ runService: h.service, runRepository: h.runs, objectStore, runId: h.runId, evidenceText: "补充证据" });
  await worker.processOne();
  assert.equal((await h.runs.getEvidence(retrySubmission.id)).status, "CONSUMED");
  assert.equal((await h.runs.get(h.runId)).status, "COMPLETED");
  assert.equal(resumed, true); assert.equal(received, "补充证据"); assert.equal((await h.runs.getEvidence((await h.runs.get(h.runId)).pendingEvidenceSubmissionId ?? "missing")), null);
});
