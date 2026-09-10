import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CleanupService, MaintenanceGate } from "../dist/index.js";

test("failed object deletion preserves metadata across service recreation until manual retry", async () => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "w6-cleanup-"));
  const target = { kind: "run", id: "00000000-0000-4000-8000-000000000001" };
  let pending = true, failed = false, failOnce = true, removed = false;
  const repository = {
    status: async () => ({ maintaining: false, pending: pending && !failed ? 1 : 0, failed: failed ? 1 : 0, failures: [], errorCode: null, lastScanAt: null }),
    pending: async () => pending && !failed ? [target] : [],
    objects: async () => [{ bucket: "artifacts", key: "instances/w6-unit/file" }],
    fail: async (_, code) => { assert.equal(code, "CLEANUP_STORAGE_FAILED"); failed = true; },
    finish: async () => { assert.ok(removed); pending = false; },
    retry: async () => { failed = false; },
    expire: async () => {}, scan: async () => {}, canRemoveDirectory: async () => false,
  };
  const store = { list: async () => [], remove: async () => { if (failOnce) { failOnce = false; throw new Error("storage failure"); } removed = true; } };
  const create = () => new CleanupService({ repository, stores: { sources: store, artifacts: store, exports: store }, gate: new MaintenanceGate(), deploymentInstanceId: "w6-unit", workDir });
  let service = create();
  try {
    await service.initialize(); assert.ok(pending); assert.ok(failed); assert.equal(removed, false);
    await service.stop(); service = create(); await service.initialize();
    assert.ok(failed); assert.equal(removed, false);
    await service.retry(); await service.scan();
    assert.equal(pending, false); assert.ok(removed);
  } finally { await service.stop(); await rm(workDir, { recursive: true, force: true }); }
});
