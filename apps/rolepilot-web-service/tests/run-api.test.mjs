import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createRunApi,
  InProcessRunQueue,
  InMemoryIdempotencyStore,
  InMemoryRunRepository,
  InMemorySourceObjectStore,
  InMemorySourceRepository,
  RunService,
  SupabaseRestError,
} from "../dist/index.js";

function createHarness() {
  const objectStore = new InMemorySourceObjectStore();
  let sourceSequence = 0;
  const runRepository = new InMemoryRunRepository({
    clock: () => "2026-09-05T00:00:00.000Z",
  });
  const sourceRepository = new InMemorySourceRepository({
    objectStore,
    referenceReader: runRepository,
    clock: () => "2026-09-05T00:00:00.000Z",
  });
  const sourceId = () => `00000000-0000-4000-8000-${String(++sourceSequence).padStart(12, "0")}`;
  const workDir = path.join(os.tmpdir(), `rolepilot-run-api-${process.pid}-${Date.now()}`);
  const service = new RunService({
    sourceRepository,
    runRepository,
    workDir,
    now: () => new Date("2026-09-05T00:00:00.000Z"),
    idFactory: () => "00000000-0000-4000-8000-000000000010",
    eventIdFactory: () => "00000000-0000-4000-8000-000000000011",
  });
  const api = createRunApi({
    runService: service,
    requestIdFactory: () => "req-run-test",
  });
  return { api, objectStore, sourceRepository, sourceId, runRepository, workDir };
}

async function readySource(harness) {
  const id = harness.sourceId();
  await harness.sourceRepository.createPending({
    id,
    inputKind: "pasted-text",
    originalFileName: null,
    mediaType: "text/plain",
    sizeBytes: 12,
  });
  await harness.objectStore.put({
    key: `sources/${id}/extracted.txt`,
    bytes: new TextEncoder().encode("Lin Yu"),
    contentType: "text/plain",
  });
  await harness.sourceRepository.markReady(id, {
    parsed: { mediaType: "text/plain", text: "Lin Yu", textLength: 6, pageCount: null, parserVersion: "test" },
    originalObjectKey: `sources/${id}/original.txt`,
    extractedTextObjectKey: `sources/${id}/extracted.txt`,
  });
  return id;
}

function request(body, key = "run-key") {
  return new Request("http://rolepilot.test/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
}

test("creates a queued Run with a safe DTO and stable server workspace", async (t) => {
  const harness = createHarness();
  t.after(async () => fs.rm(harness.workDir, { recursive: true, force: true }));
  const sourceId = await readySource(harness);
  const response = await harness.api.handle(
    request({ resumeSourceId: sourceId, company: "RolePilot", title: "AI PM", jdText: "负责产品。" }),
  );
  const run = await response.json();

  assert.equal(response.status, 202);
  assert.equal(response.headers.get("x-request-id"), "req-run-test");
  assert.equal(run.status, "QUEUED");
  assert.equal(run.resumeSourceId, sourceId);
  assert.equal("jdText" in run, false);
  assert.deepEqual(run.stepStatuses.map((step) => step.id), ["mine", "jd-analysis", "preflight", "write", "review"]);
  assert.ok(await fs.stat(path.join(harness.workDir, "runs", run.id)));
});

test("same idempotency key reuses one Run and a different fingerprint conflicts", async (t) => {
  const harness = createHarness();
  t.after(async () => fs.rm(harness.workDir, { recursive: true, force: true }));
  const sourceId = await readySource(harness);
  const body = { resumeSourceId: sourceId, company: "RolePilot", title: "AI PM", jdText: "负责产品。" };
  const first = await harness.api.handle(request(body, "same-key"));
  const second = await harness.api.handle(request(body, "same-key"));
  const conflict = await harness.api.handle(request({ ...body, title: "别的岗位" }, "same-key"));

  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.deepEqual(await second.json(), await first.clone().json());
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "IDEMPOTENCY_CONFLICT");
});

test("rejects non-ready sources, unknown fields, and missing idempotency key", async (t) => {
  const harness = createHarness();
  t.after(async () => fs.rm(harness.workDir, { recursive: true, force: true }));
  const sourceId = harness.sourceId();
  await harness.sourceRepository.createPending({
    id: sourceId,
    inputKind: "pasted-text",
    originalFileName: null,
    mediaType: "text/plain",
    sizeBytes: 1,
  });
  const notReady = await harness.api.handle(
    request({ resumeSourceId: sourceId, company: "RolePilot", title: "AI PM", jdText: "JD" }),
  );
  assert.equal(notReady.status, 409);
  assert.equal((await notReady.json()).error.code, "SOURCE_TEXT_UNAVAILABLE");

  const unknown = await harness.api.handle(
    request({ resumeSourceId: sourceId, company: "RolePilot", title: "AI PM", jdText: "JD", rootDir: "/tmp" }, "unknown"),
  );
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error.code, "REQUEST_INVALID");

  const missingKey = await harness.api.handle(
    new Request("http://rolepilot.test/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resumeSourceId: sourceId, company: "RolePilot", title: "AI PM", jdText: "JD" }),
    }),
  );
  assert.equal(missingKey.status, 400);
});

test("claimNext atomically moves the oldest queued Run to RUNNING", async (t) => {
  const harness = createHarness();
  t.after(async () => fs.rm(harness.workDir, { recursive: true, force: true }));
  const sourceId = await readySource(harness);
  const body = { resumeSourceId: sourceId, company: "RolePilot", title: "AI PM", jdText: "JD" };
  await harness.api.handle(request(body, "claim-key"));
  const claimed = await new RunService({
    sourceRepository: harness.sourceRepository,
    runRepository: harness.runRepository,
    workDir: harness.workDir,
    eventIdFactory: () => "00000000-0000-4000-8000-000000000012",
  }).claimNext();
  assert.equal(claimed?.status, "RUNNING");
  assert.equal((await harness.runRepository.claimNext("event-2")), null);
});

test("database failure does not create a workspace or notify the queue", async (t) => {
  const harness = createHarness();
  t.after(async () => fs.rm(harness.workDir, { recursive: true, force: true }));
  const sourceId = await readySource(harness);
  let notified = false;
  const failingService = new RunService({
    sourceRepository: harness.sourceRepository,
    runRepository: {
      ...harness.runRepository,
      async createIdempotent() {
        throw new Error("transaction failed");
      },
    },
    workDir: harness.workDir,
    onRunQueued: () => { notified = true; },
  });
  const response = await createRunApi({ runService: failingService }).handle(
    request({ resumeSourceId: sourceId, company: "RolePilot", title: "AI PM", jdText: "JD" }, "db-fail"),
  );
  assert.equal(response.status, 503);
  assert.equal(notified, false);
  await assert.rejects(fs.stat(path.join(harness.workDir, "runs")));
});

test("maps Supabase invalid IDs to a client error instead of a generic 503", async () => {
  const api = createRunApi({
    runService: {
      async get() {
        throw new SupabaseRestError("22P02");
      },
    },
    requestIdFactory: () => "req-invalid-id",
  });

  const response = await api.handle(
    new Request("http://rolepilot.test/api/runs/not-a-real-id"),
  );
  assert.equal(response.status, 400);
  assert.deepEqual((await response.json()).error, {
    code: "REQUEST_INVALID",
    message: "请求中的资源 ID 无效。",
    retryable: false,
    requestId: "req-invalid-id",
  });
});

test("queue wake signal releases a poller and delegates one claim", async (t) => {
  const harness = createHarness();
  t.after(async () => fs.rm(harness.workDir, { recursive: true, force: true }));
  const sourceId = await readySource(harness);
  const service = new RunService({
    sourceRepository: harness.sourceRepository,
    runRepository: harness.runRepository,
    workDir: harness.workDir,
  });
  const queue = new InProcessRunQueue(service);
  let released = false;
  const waiting = queue.waitForSignal({ timeoutMs: 5_000 }).then(() => { released = true; });
  queue.wake();
  await waiting;
  assert.equal(released, true);
  await service.create({ resumeSourceId: sourceId, company: "RolePilot", title: "AI PM", jdText: "JD" }, "queue-key");
  assert.equal((await queue.claimNext())?.status, "RUNNING");
});
