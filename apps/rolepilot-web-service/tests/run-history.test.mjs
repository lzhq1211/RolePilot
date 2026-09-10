import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRunApi, InMemoryRunRepository, InMemorySourceObjectStore, InMemorySourceRepository, RunEventHub, RunService } from "../dist/index.js";

function setup() {
  const store = new InMemorySourceObjectStore();
  const runs = new InMemoryRunRepository({ clock: () => "2026-09-05T00:00:00.000Z" });
  const sources = new InMemorySourceRepository({ objectStore: store, referenceReader: runs, clock: () => "2026-09-05T00:00:00.000Z" });
  const service = new RunService({ sourceRepository: sources, runRepository: runs, workDir: path.join(os.tmpdir(), `rolepilot-history-${Date.now()}`), now: () => new Date("2026-09-05T00:00:00.000Z"), idFactory: () => "00000000-0000-4000-8000-000000000010", eventIdFactory: () => "00000000-0000-4000-8000-000000000011" });
  const hub = new RunEventHub();
  return { runs, sources, store, service, api: createRunApi({ runService: service, eventHub: hub }), hub };
}

async function source(h) {
  await h.sources.createPending({ id: "history-source", inputKind: "pasted-text", originalFileName: null, mediaType: "text/plain", sizeBytes: 1 });
  await h.store.put({ key: "sources/history-source/extracted.txt", bytes: new TextEncoder().encode("resume"), contentType: "text/plain" });
  await h.sources.markReady("history-source", { parsed: { mediaType: "text/plain", text: "resume", textLength: 6, pageCount: null, parserVersion: "test" }, originalObjectKey: "sources/history-source/original.txt", extractedTextObjectKey: "sources/history-source/extracted.txt" });
}

const req = (url, init = {}) => new Request(`http://rolepilot.test${url}`, init);

test("Run history/detail/delete APIs and opaque cursors", async () => {
  const h = setup();
  await source(h);
  const created = await h.api.handle(req("/api/runs", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "history-key" }, body: JSON.stringify({ resumeSourceId: "history-source", company: "RolePilot", title: "AI PM", jdText: "JD" }) }));
  const run = await created.json();
  const list = await h.api.handle(req("/api/runs"));
  assert.equal((await list.json()).items[0].id, run.id);
  const detail = await h.api.handle(req(`/api/runs/${run.id}`));
  assert.equal((await detail.json()).jdText, undefined);
  const missingConfirm = await h.api.handle(req(`/api/runs/${run.id}`, { method: "DELETE" }));
  assert.equal(missingConfirm.status, 428);
  const cancelled = await h.api.handle(req(`/api/runs/${run.id}/cancel`, { method: "POST" }));
  assert.equal(cancelled.status, 200);
  const deleted = await h.api.handle(req(`/api/runs/${run.id}`, { method: "DELETE", headers: { "x-rolepilot-confirm": "DELETE_RUN" } }));
  assert.equal(deleted.status, 204);
  assert.equal((await h.api.handle(req(`/api/runs/${run.id}`))).status, 404);
});

test("SSE backfills events from an opaque cursor and closes on terminal event", async () => {
  const h = setup();
  await source(h);
  await h.service.create({ resumeSourceId: "history-source", company: "RolePilot", title: "AI PM", jdText: "JD" }, "sse-key");
  const running = await h.runs.claimNext("event-running");
  const steps = running.stepStatuses.map((step) => ({ ...step, status: "completed" }));
  await h.runs.transition({ runId: running.id, expectedStatus: "RUNNING", nextStatus: "COMPLETED", currentStep: "review", stepStatuses: steps, stopReason: "pass", failureCode: null, completedAt: "2026-09-05T00:00:01.000Z", event: { id: "event-completed", runId: running.id, sequence: 3, type: "run.completed", payload: { runId: running.id, status: "COMPLETED", stopReason: "pass" }, createdAt: "2026-09-05T00:00:01.000Z" } });
  const response = await h.api.handle(req(`/api/runs/${running.id}/events?cursor=1`));
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const text = await response.text();
  assert.match(text, /id: 3/);
  assert.match(text, /run.completed/);
  const invalid = await h.api.handle(req(`/api/runs/${running.id}/events?cursor=bad`));
  assert.equal(invalid.status, 400);
});

test("cancel endpoint moves queued run to CANCELLED and rejects a second cancel", async () => {
  const h = setup();
  await source(h);
  const created = await h.api.handle(req("/api/runs", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "cancel-key" }, body: JSON.stringify({ resumeSourceId: "history-source", company: "RolePilot", title: "AI PM", jdText: "JD" }) }));
  const run = await created.json();
  const cancelled = await h.api.handle(req(`/api/runs/${run.id}/cancel`, { method: "POST" }));
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).status, "CANCELLED");
  const second = await h.api.handle(req(`/api/runs/${run.id}/cancel`, { method: "POST" }));
  assert.equal(second.status, 409);
});
