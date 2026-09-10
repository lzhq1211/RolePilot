import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { CleanupFailureCode } from "web-contracts";
import type { CleanupObject, CleanupRepository, CleanupTarget } from "./cleanup-repository.js";
import type { ListableSourceObjectStore } from "./source-object-store.js";
import { MaintenanceBusyError, MaintenanceGate } from "./maintenance-gate.js";
import type { RunRepository } from "./run-repository.js";
import { retryRunDiagnostics } from "./run-diagnostics.js";

type CleanupStores = Record<CleanupObject["bucket"], ListableSourceObjectStore>;

export class CleanupService {
  readonly #repository: CleanupRepository;
  readonly #stores: CleanupStores;
  readonly #gate: MaintenanceGate;
  readonly #instance: string;
  readonly #workDir: string;
  readonly #now: () => Date;
  readonly #runs: RunRepository | undefined;
  #timer: ReturnType<typeof setInterval> | null = null;
  #scan: Promise<void> | null = null;
  #continuation: ReturnType<typeof setTimeout> | null = null;
  #more = false;
  #stopped = false;

  constructor({ repository, stores, gate, deploymentInstanceId, workDir, runs, now = () => new Date() }: {
    repository: CleanupRepository; stores: CleanupStores; gate: MaintenanceGate;
    deploymentInstanceId: string; workDir: string; now?: () => Date;
    runs?: RunRepository;
  }) {
    this.#repository = repository; this.#stores = stores; this.#gate = gate;
    this.#instance = deploymentInstanceId; this.#workDir = workDir; this.#now = now;
    this.#runs = runs;
  }

  async initialize(): Promise<void> {
    this.#gate.maintaining = (await this.#repository.status()).maintaining;
    await this.scan();
  }

  start(): void {
    this.#stopped = false;
    if (!this.#timer) this.#timer = setInterval(() => this.wake(), 10 * 60 * 1000);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#continuation) clearTimeout(this.#continuation);
    this.#timer = null;
    await this.#scan;
  }

  wake(): void {
    void this.scan().catch(() => {
      this.#gate.maintaining = true;
      process.stderr.write("CLEANUP_SCAN_FAILED\n");
    });
  }

  async status() {
    const state = await this.#repository.status();
    return { ...state, maintaining: state.maintaining || this.#gate.maintaining };
  }

  async clear(): Promise<void> {
    await this.#gate.exclusive(async () => {
      if (this.#gate.maintaining || this.#gate.busy || await this.#repository.hasActiveExecution()) throw new MaintenanceBusyError();
      this.#gate.maintaining = true;
      await this.#repository.beginClear();
    });
    this.wake();
  }

  async retry(): Promise<void> {
    await this.#gate.exclusive(async () => {
      await this.#repository.retry();
      this.#gate.maintaining = (await this.#repository.status()).maintaining;
    });
    this.wake();
  }

  scan(): Promise<void> {
    if (this.#scan) return this.#scan;
    this.#scan = this.#gate.exclusive(() => this.#sweep()).finally(() => {
      this.#scan = null;
      if (this.#more && !this.#stopped) this.#continuation = setTimeout(() => this.wake(), 0);
    });
    return this.#scan;
  }

  async #sweep(): Promise<void> {
    this.#more = false;
    // Gate excludes new writes/claims; execution leases also cover cancellation finalizers.
    if (this.#gate.busy) return;
    const at = this.#now().toISOString();
    try {
      const before = await this.#repository.status();
      if (before.errorCode) return;
      for (const target of await this.#repository.pending(100)) await this.#clean(target);
      await this.#repository.expire(at);
      const state = await this.#repository.status();
      if (state.maintaining && state.pending === 0 && state.failed === 0) {
        await this.#removeInstanceObjects();
        await this.#removeDirectories(true);
        await this.#repository.finishClear();
        this.#gate.maintaining = false;
      } else if (!state.maintaining) {
        await this.#sweepOrphans();
        await this.#removeDirectories(false);
      }
      await this.#repository.scan(at, null);
      this.#more = (await this.#repository.pending(1)).length > 0;
    } catch {
      await this.#repository.scan(at, "CLEANUP_SCAN_FAILED");
    }
  }

  async #clean(target: CleanupTarget): Promise<void> {
    let code: CleanupFailureCode = "CLEANUP_METADATA_FAILED";
    try {
      const objects = await this.#repository.objects(target);
      code = "CLEANUP_STORAGE_FAILED";
      for (const object of objects) {
        this.#assertKey(object.key);
        await this.#stores[object.bucket].remove([object.key]);
      }
      code = "CLEANUP_METADATA_FAILED";
      if (target.kind === "run") await rm(this.#runDirectory(target.id), { recursive: true, force: true });
      await this.#repository.finish(target);
    } catch {
      await this.#repository.fail(target, code);
    }
  }

  async #removeInstanceObjects(): Promise<void> {
    for (const store of Object.values(this.#stores)) {
      const rows = await store.list(`instances/${this.#instance}/`);
      for (let offset = 0; offset < rows.length; offset += 100) {
        const keys = rows.slice(offset, offset + 100).map((row) => { this.#assertKey(row.key); return row.key; });
        await store.remove(keys);
      }
    }
  }

  async #sweepOrphans(): Promise<void> {
    const cutoff = this.#now().getTime() - 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const [bucket, store] of Object.entries(this.#stores) as Array<[CleanupObject["bucket"], ListableSourceObjectStore]>) {
      for (const row of await store.list(`instances/${this.#instance}/`)) {
        if (removed >= 100) return;
        if (Date.parse(row.createdAt) >= cutoff || !Number.isFinite(Date.parse(row.createdAt))) continue;
        this.#assertKey(row.key);
        if (await this.#repository.canSweepObject({ bucket, key: row.key })) {
          await store.remove([row.key]);
          await this.#repository.finishSweptObject({ bucket, key: row.key });
          removed += 1;
        }
      }
    }
  }

  async #removeDirectories(all: boolean): Promise<void> {
    let entries;
    try { entries = await readdir(path.join(this.#workDir, "runs"), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      if (!entry.isDirectory() || (!all && !await this.#repository.canRemoveDirectory(entry.name))) continue;
      if (!all && this.#runs && !await retryRunDiagnostics(this.#runDirectory(entry.name), entry.name, this.#instance, this.#runs, this.#stores.artifacts)) {
        throw new Error("DIAGNOSTIC_PUBLICATION_FAILED");
      }
      await rm(this.#runDirectory(entry.name), { recursive: true, force: true });
    }
  }

  #assertKey(key: string): void {
    if (!key.startsWith(`instances/${this.#instance}/`) || key.split("/").some((part) => part === ".." || part === ".")) throw new Error("CLEANUP_METADATA_FAILED");
  }

  #runDirectory(id: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("CLEANUP_METADATA_FAILED");
    return path.join(this.#workDir, "runs", id);
  }
}
