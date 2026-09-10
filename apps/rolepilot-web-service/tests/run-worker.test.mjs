import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  InMemoryRunRepository,
  InMemorySourceObjectStore,
  InMemorySourceRepository,
  InProcessRunQueue,
  InProcessRunWorker,
  RunService,
} from "../dist/index.js";

function harness(runFn) {
  const store = new InMemorySourceObjectStore();
  const artifactStore = new InMemorySourceObjectStore();
  const runs = new InMemoryRunRepository({ clock: () => "2026-09-05T00:00:00.000Z" });
  const sources = new InMemorySourceRepository({ objectStore: store, referenceReader: runs, clock: () => "2026-09-05T00:00:00.000Z" });
  const workDir = path.join(os.tmpdir(), `rolepilot-worker-${process.pid}-${Date.now()}`);
  const service = new RunService({ sourceRepository: sources, runRepository: runs, workDir, now: () => new Date("2026-09-05T00:00:00.000Z"), idFactory: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`; })(), eventIdFactory: () => "00000000-0000-4000-8000-000000000099" });
  const queue = new InProcessRunQueue(service);
  const worker = new InProcessRunWorker({ queue, runRepository: runs, sourceRepository: sources, workDir, artifactStore, agentBindings: { miner: { provider: "openai-chat", mode: "stub" }, writer: { provider: "openai-chat", mode: "stub" }, reviewer: { provider: "openai-chat", mode: "stub" }, interviewer: { provider: "openai-chat", mode: "stub" } }, runFn });
  return { store, artifactStore, runs, sources, service, worker, workDir };
}

async function readySource(h) {
  const id = "source-worker";
  await h.sources.createPending({ id, inputKind: "pasted-text", originalFileName: null, mediaType: "text/plain", sizeBytes: 12 });
  await h.store.put({ key: `sources/${id}/extracted.txt`, bytes: new TextEncoder().encode("Resume text"), contentType: "text/plain" });
  await h.sources.markReady(id, { parsed: { mediaType: "text/plain", text: "Resume text", textLength: 11, pageCount: null, parserVersion: "test" }, originalObjectKey: `sources/${id}/original.txt`, extractedTextObjectKey: `sources/${id}/extracted.txt` });
  return id;
}

function fakeRun() {
  return async (input) => {
    for (const stepId of ["mine", "jd-analysis", "preflight", "write", "review"]) {
      input.onStatus?.({ type: "task-started", runId: input.runId, stepId, agent: "writer", detail: "started" });
      input.onStatus?.({ type: "task-completed", runId: input.runId, stepId, agent: "writer", detail: "completed" });
    }
    const artifactPath = path.join(input.rootDir, "resumes", "gem", "resume.final.json");
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    const originalPath = path.join(path.dirname(artifactPath), "resume.original.json");
    const preflightPath = path.join(input.rootDir, "logs", "gem", "preflight.json");
    const deliveryPath = path.join(input.rootDir, "logs", "gem", "workbench-delivery.json");
    const original = { schemaVersion: 3, documentId: `${input.runId}:original`, resumeName: "原始简历", profile: { name: "", headline: "", location: "", phone: "", email: "", website: "", portfolio: "", github: "" }, sections: [] };
    const final = { ...original, documentId: `${input.runId}:final`, resumeName: "最终简历" };
    const relative = (target) => path.relative(input.rootDir, target).replaceAll("\\", "/");
    await fs.writeFile(artifactPath, JSON.stringify(final), "utf8");
    await fs.writeFile(originalPath, JSON.stringify(original), "utf8");
    await fs.mkdir(path.dirname(preflightPath), { recursive: true });
    await fs.writeFile(preflightPath, JSON.stringify({ decision: "PROCEED", safeWritingScope: [] }), "utf8");
    await fs.writeFile(deliveryPath, JSON.stringify({
      schemaVersion: 1,
      format: "workbench-delivery",
      deliveryStatus: "OPTIMIZED",
      original: { documentId: original.documentId, path: relative(originalPath) },
      final: { documentId: final.documentId, path: relative(artifactPath), candidateVersion: 1 },
      candidate: { documentId: final.documentId, path: relative(artifactPath), version: 1 },
      review: null,
      preflight: { path: relative(preflightPath), decision: "PROCEED" },
      actionHistory: [],
    }), "utf8");
    return { runId: input.runId, stopReason: "pass", originalResumePath: originalPath, finalResumePath: artifactPath, artifactManifest: { artifacts: [
      { kind: "resume", stage: "supporting", fileName: "resume.original.json", absolutePath: originalPath },
      { kind: "preflight", stage: "supporting", fileName: "preflight.json", absolutePath: preflightPath },
      { kind: "resume", stage: "final", fileName: "resume.final.json", absolutePath: artifactPath },
      { kind: "log", stage: "supporting", fileName: "workbench-delivery.json", absolutePath: deliveryPath },
    ] } };
  };
}

function fakeUnsupportedRun() {
  return async (input) => {
    const artifactPath = path.join(input.rootDir, "unsupported", "preflight.json");
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, "{\"decision\":\"STOP_UNSUPPORTED\"}\n", "utf8");
    return {
      runId: input.runId,
      stopReason: "unsupported-input",
      pendingUserQuestions: [
        "感谢你补充信息。现有材料仍不足以支持该目标岗位。",
        "这次暂不继续生成。",
      ],
      finalResumePath: null,
      artifactManifest: {
        artifacts: [
          {
            kind: "unsupported",
            stage: "supporting",
            fileName: "preflight.json",
            absolutePath: artifactPath,
          },
        ],
      },
    };
  };
}

test("worker bridges a queued run to COMPLETED without interview", async (t) => {
  const h = harness(fakeRun());
  t.after(() => fs.rm(h.workDir, { recursive: true, force: true }));
  const sourceId = await readySource(h);
  await h.service.create({ resumeSourceId: sourceId, company: "RolePilot", title: "AI PM", jdText: "JD" }, "worker-key");
  const processed = await h.worker.processOne();
  assert.equal(processed?.status, "COMPLETED");
  assert.equal(processed?.stopReason, "pass");
  assert.equal(processed?.interviewPath, undefined);
  assert.equal(processed?.artifactIds.length, 4);
  assert.ok(processed?.finalResumeArtifactId);
  const artifact = await h.runs.getArtifact(processed.finalResumeArtifactId);
  assert.equal(artifact?.status, "PUBLISHED");
  assert.equal(artifact?.role, "final-resume");
  assert.equal(h.artifactStore.has(artifact.storageObjectKey), true);
  const records = await Promise.all(processed.artifactIds.map((id) => h.runs.getArtifact(id)));
  const original = records.find((record) => record?.relativePath.endsWith("resume.original.json"));
  assert.equal(original.role, "supporting");
  assert.equal(original.stage, "supporting");
  assert.equal(original.status, "PUBLISHED");
  assert.equal(original.artifactType, "resume");
  assert.equal(JSON.parse(new TextDecoder().decode(await h.artifactStore.read(original.storageObjectKey))).documentId, `${processed.id}:original`);
  const delivery = records.find((record) => record?.relativePath.endsWith("workbench-delivery.json"));
  assert.equal(delivery?.artifactType, "log");
  assert.equal(delivery?.role, "supporting");
  const artifactEvents = (await h.runs.eventsAfter(processed.id, 0)).filter((event) => event.type === "run.artifact");
  assert.equal(artifactEvents.at(-1).payload.artifactId, delivery?.id);
  assert.equal(await fs.stat(path.join(h.workDir, "runs", processed.id)).catch(() => null), null);
  assert.equal((await h.runs.eventsAfter(processed.id, 0)).at(-1).type, "run.completed");
});

test("worker does not complete when delivery index storage fails", async (t) => {
  const h = harness(fakeRun());
  t.after(() => fs.rm(h.workDir, { recursive: true, force: true }));
  const put = h.artifactStore.put.bind(h.artifactStore);
  let putCalls = 0;
  h.artifactStore.put = async (input) => {
    putCalls += 1;
    if (putCalls === 7) throw new Error("delivery storage unavailable");
    return put(input);
  };
  const sourceId = await readySource(h);
  await h.service.create({ resumeSourceId: sourceId, company: "RolePilot", title: "AI PM", jdText: "JD" }, "worker-delivery-fail");
  const processed = await h.worker.processOne();
  assert.equal(processed?.status, "FAILED");
  assert.equal(processed?.failureCode, "RUN_EXECUTION_FAILED");
  assert.equal((await h.runs.eventsAfter(processed.id, 0)).some((event) => event.type === "run.completed"), false);
});

test("worker persists user-facing guidance for an unsupported run", async (t) => {
  const h = harness(fakeUnsupportedRun());
  t.after(() => fs.rm(h.workDir, { recursive: true, force: true }));
  const sourceId = await readySource(h);
  await h.service.create({ resumeSourceId: sourceId, company: "RolePilot", title: "AI PM", jdText: "JD" }, "worker-unsupported");
  const processed = await h.worker.processOne();
  assert.equal(processed?.status, "UNSUPPORTED");
  assert.deepEqual(processed?.pendingUserQuestions, [
    "感谢你补充信息。现有材料仍不足以支持该目标岗位。",
    "这次暂不继续生成。",
  ]);
});

test("worker maps execution failures to controlled RUN_EXECUTION_FAILED", async (t) => {
  const h = harness(async () => { throw new Error("provider detail"); });
  t.after(() => fs.rm(h.workDir, { recursive: true, force: true }));
  const sourceId = await readySource(h);
  await h.service.create({ resumeSourceId: sourceId, company: "RolePilot", title: "AI PM", jdText: "JD" }, "worker-fail");
  const processed = await h.worker.processOne();
  assert.equal(processed?.status, "FAILED");
  assert.equal(processed?.failureCode, "RUN_EXECUTION_FAILED");
  assert.equal((await h.runs.eventsAfter(processed.id, 0)).at(-1).payload.failureCode, "RUN_EXECUTION_FAILED");
  assert.ok(processed.artifactIds.length > 0);
  const diagnostic = await h.runs.getArtifact(processed.artifactIds.at(-1));
  assert.equal(diagnostic.status, "PUBLISHED");
  assert.equal(diagnostic.role, "supporting");
  assert.match(new TextDecoder().decode(await h.artifactStore.read(diagnostic.storageObjectKey)), /provider detail/);
  assert.equal(processed.finalResumeArtifactId, null);
});
