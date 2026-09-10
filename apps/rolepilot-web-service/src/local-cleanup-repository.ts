import type { CleanupFailureCode, CleanupStatusDto } from "web-contracts";
import type { CleanupObject, CleanupRepository, CleanupTarget } from "./cleanup-repository.js";
import type { ListableSourceObjectStore } from "./source-object-store.js";
import type { LocalState } from "./local-storage.js";

export class LocalCleanupRepository implements CleanupRepository {
  constructor(readonly state: LocalState, readonly stores: Record<CleanupObject["bucket"], ListableSourceObjectStore>, readonly instance: string) {}
  #referenced(id: string): boolean {
    return [...this.state.records.values()].some((run) => run.resumeSourceId === id)
      || [...this.state.drafts.values()].some((draft) => draft.resumeSourceId === id);
  }
  #targets(): CleanupTarget[] {
    return [
      ...[...this.state.records.values()].filter((run) => run.deletedAt).map((run) => ({ kind: "run" as const, id: run.id })),
      ...[...this.state.sources.values()].filter((source) => (source.deletedAt || source.cleanupRequestedAt) && !this.#referenced(source.id)).map((source) => ({ kind: "source" as const, id: source.id })),
    ];
  }
  async status(): Promise<CleanupStatusDto> {
    const failures = [...this.state.cleanupFailures].map(([key, code]) => {
      const [kind, id] = key.split(":");
      return { kind: kind as CleanupTarget["kind"], id, code };
    });
    return { ...this.state.cleanup.get("status")!, pending: (await this.pending(Number.MAX_SAFE_INTEGER)).length, failed: failures.length, failures };
  }
  async beginClear(): Promise<void> {
    if (await this.hasActiveExecution()) throw new Error("MAINTENANCE_BUSY");
    this.state.cleanup.get("status")!.maintaining = true;
    this.state.drafts.clear();
    const at = new Date().toISOString();
    for (const run of this.state.records.values()) { run.deletedAt = at; run.cleanupStatus = "PENDING"; }
    for (const source of this.state.sources.values()) source.deletedAt = at;
  }
  async finishClear(): Promise<void> {
    if (this.#targets().length || this.state.cleanupFailures.size) throw new Error("CLEANUP_PENDING");
    for (const [name, values] of Object.entries(this.state)) if (name !== "cleanup") values.clear();
    this.state.cleanup.set("status", { maintaining: false, lastScanAt: new Date().toISOString(), errorCode: null });
  }
  async pending(limit: number): Promise<CleanupTarget[]> {
    return this.#targets().filter((target) => !this.state.cleanupFailures.has(`${target.kind}:${target.id}`)).slice(0, limit);
  }
  async objects(target: CleanupTarget): Promise<CleanupObject[]> {
    if (target.kind === "export") return [];
    const bucket = target.kind === "source" ? "sources" : "artifacts";
    const keys = new Set((await this.stores[bucket].list(`instances/${this.instance}/${target.kind === "source" ? "sources" : "runs"}/${target.id}/`)).map((entry) => entry.key));
    if (target.kind === "source") {
      const source = this.state.sources.get(target.id);
      if (source?.originalObjectKey) keys.add(source.originalObjectKey);
      if (source?.extractedTextObjectKey) keys.add(source.extractedTextObjectKey);
    } else {
      for (const record of [...this.state.artifacts.values(), ...this.state.evidence.values()]) if (record.runId === target.id) keys.add(record.storageObjectKey);
    }
    return [...keys].map((key) => ({ bucket, key }));
  }
  async finish(target: CleanupTarget): Promise<void> {
    if (target.kind === "source") {
      if (this.#referenced(target.id)) throw new Error("CLEANUP_METADATA_FAILED");
      this.state.sources.delete(target.id);
    } else if (target.kind === "run") {
      const run = this.state.records.get(target.id);
      if (!run?.deletedAt) throw new Error("CLEANUP_METADATA_FAILED");
      for (const records of [this.state.artifacts, this.state.evidence, this.state.documents]) {
        for (const [id, record] of records) if (record.runId === target.id) records.delete(id);
      }
      for (const [key, id] of this.state.runVariants) if (!this.state.documents.has(id)) this.state.runVariants.delete(key);
      this.state.events.delete(target.id);
      this.state.records.delete(target.id);
      const source = this.state.sources.get(run.resumeSourceId);
      if (source && !this.#referenced(source.id)) source.cleanupRequestedAt = new Date().toISOString();
    }
    for (const records of [this.state.idempotency, this.state.sourceIdempotency]) {
      for (const [key, record] of records) if (record.resultId === target.id || record.sourceId === target.id) records.delete(key);
    }
    this.state.cleanupFailures.delete(`${target.kind}:${target.id}`);
  }
  async fail(target: CleanupTarget, code: CleanupFailureCode): Promise<void> { this.state.cleanupFailures.set(`${target.kind}:${target.id}`, code); }
  async retry(): Promise<void> { this.state.cleanupFailures.clear(); this.state.cleanup.get("status")!.errorCode = null; }
  async scan(at: string, errorCode: CleanupFailureCode | null): Promise<void> { Object.assign(this.state.cleanup.get("status")!, { lastScanAt: at, errorCode }); }
  async expire(at: string): Promise<void> {
    for (const records of [this.state.idempotency, this.state.sourceIdempotency]) for (const [key, record] of records) if (record.expiresAt <= at) records.delete(key);
  }
  async hasActiveExecution(): Promise<boolean> { return [...this.state.records.values()].some((run) => !run.deletedAt && ["QUEUED", "RUNNING"].includes(run.status)); }
  async recoverInterruptedExports(): Promise<number> { return 0; }
  async canRemoveDirectory(runId: string): Promise<boolean> {
    const run = this.state.records.get(runId);
    return !run || !["QUEUED", "RUNNING", "NEEDS_USER_INPUT"].includes(run.status);
  }
  async canSweepObject(object: CleanupObject): Promise<boolean> {
    const prefix = `instances/${this.instance}/`;
    if (!object.key.startsWith(prefix)) return false;
    const id = object.key.slice(prefix.length).split("/")[1];
    if (object.bucket === "sources") return !this.state.sources.has(id);
    if (object.bucket === "exports") return true;
    // Keep all artifacts and checkpoints belonging to an existing run.
    return !this.state.records.has(id);
  }
  async finishSweptObject(): Promise<void> {}
}
