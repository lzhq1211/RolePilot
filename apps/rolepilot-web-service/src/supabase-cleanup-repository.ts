import type { CleanupFailureCode, CleanupStatusDto } from "web-contracts";
import type { CleanupObject, CleanupRepository, CleanupTarget } from "./cleanup-repository.js";
import type { ListableSourceObjectStore } from "./source-object-store.js";
import { SupabaseRestClient } from "./supabase.js";

const TABLES = { run: "runs", source: "source_documents", export: "exports" } as const;
type Row = { id: string; status: string; deleted_at: string | null; cleanup_status?: string; storage_object_key?: string | null; original_object_key?: string | null; extracted_text_object_key?: string | null; format?: string };

export class SupabaseCleanupRepository implements CleanupRepository {
  readonly #client: SupabaseRestClient;
  readonly #instance: string;
  readonly #filter: string;
  readonly #stores: Record<CleanupObject["bucket"], ListableSourceObjectStore>;

  constructor({ client, deploymentInstanceId, stores }: {
    client: SupabaseRestClient; deploymentInstanceId: string;
    stores: Record<CleanupObject["bucket"], ListableSourceObjectStore>;
  }) {
    this.#client = client; this.#instance = deploymentInstanceId;
    this.#filter = `deployment_instance_id=eq.${encodeURIComponent(deploymentInstanceId)}`;
    this.#stores = stores;
  }

  status(): Promise<CleanupStatusDto> { return this.#rpc("rolepilot_cleanup_status"); }
  beginClear(): Promise<void> { return this.#rpc("rolepilot_begin_instance_clear"); }
  finishClear(): Promise<void> { return this.#rpc("rolepilot_finish_instance_clear"); }
  pending(limit: number): Promise<CleanupTarget[]> { return this.#rpc("rolepilot_cleanup_pending", { p_limit: limit }); }
  finish(target: CleanupTarget): Promise<void> { return this.#rpc("rolepilot_cleanup_finish", { p_kind: target.kind, p_id: target.id }); }
  retry(): Promise<void> { return this.#rpc("rolepilot_cleanup_retry"); }

  async fail(target: CleanupTarget, code: CleanupFailureCode): Promise<void> {
    await this.#client.json(`/rest/v1/${TABLES[target.kind]}?${this.#filter}&id=eq.${encodeURIComponent(target.id)}`, {
      method: "PATCH", body: JSON.stringify({ cleanup_status: "FAILED", cleanup_error_code: code, updated_at: new Date().toISOString() }),
    });
  }

  async scan(at: string, errorCode: CleanupFailureCode | null): Promise<void> {
    await this.#rpc("rolepilot_cleanup_scan", { p_at: at, p_error_code: errorCode });
  }

  async expire(at: string): Promise<void> {
    await this.#client.json(`/rest/v1/idempotency_keys?${this.#filter}&expires_at=lte.${encodeURIComponent(at)}`, { method: "DELETE" });
  }

  async hasActiveExecution(): Promise<boolean> {
    const runs = await this.#rows("runs", "status=in.(QUEUED,RUNNING)&deleted_at=is.null", 1);
    const exports = await this.#rows("exports", "status=in.(QUEUED,GENERATING)&deleted_at=is.null", 1);
    return runs.length > 0 || exports.length > 0;
  }

  async recoverInterruptedExports(): Promise<number> {
    let count = 0;
    for (const status of ["QUEUED", "GENERATING"] as const) {
      for (;;) {
        const rows = await this.#rows("exports", `status=eq.${status}&deleted_at=is.null`, 1000);
        if (rows.length === 0) break;
        for (const row of rows) {
          await this.#client.json(`/rest/v1/${TABLES.export}?${this.#filter}&id=eq.${encodeURIComponent(row.id)}&status=eq.${status}`, {
            method: "PATCH",
            body: JSON.stringify({ status: "FAILED", failure_code: "EXPORT_WORKER_INTERRUPTED", cleanup_status: "PENDING", updated_at: new Date().toISOString() }),
          });
          count += 1;
        }
        if (rows.length < 1000) break;
      }
    }
    return count;
  }

  async objects(target: CleanupTarget): Promise<CleanupObject[]> {
    const result: CleanupObject[] = [];
    const add = (bucket: CleanupObject["bucket"], key: string | null | undefined) => { if (key) result.push({ bucket, key }); };
    if (target.kind === "source") {
      const [source] = await this.#rows("source_documents", `id=eq.${encodeURIComponent(target.id)}`, 1);
      if (!source) throw new Error("CLEANUP_METADATA_FAILED");
      add("sources", source.original_object_key); add("sources", source.extracted_text_object_key);
      for (const object of await this.#stores.sources.list(`instances/${this.#instance}/sources/${target.id}/`)) add("sources", object.key);
    } else if (target.kind === "run") {
      for (const artifact of await this.#rows("artifacts", `run_id=eq.${encodeURIComponent(target.id)}`)) add("artifacts", artifact.storage_object_key);
      for (const evidence of await this.#rows("run_evidence_submissions", `run_id=eq.${encodeURIComponent(target.id)}`)) add("artifacts", evidence.storage_object_key);
      for (const object of await this.#stores.artifacts.list(`instances/${this.#instance}/runs/${target.id}/`)) add("artifacts", object.key);
      for (const record of await this.#rows("exports", `run_id=eq.${encodeURIComponent(target.id)}`)) this.#exportKeys(record).forEach((key) => add("exports", key));
    } else {
      const [record] = await this.#rows("exports", `id=eq.${encodeURIComponent(target.id)}`, 1);
      if (!record) throw new Error("CLEANUP_METADATA_FAILED");
      this.#exportKeys(record).forEach((key) => add("exports", key));
    }
    return Array.from(new Map(result.map((object) => [`${object.bucket}:${object.key}`, object])).values());
  }

  async canRemoveDirectory(runId: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(runId)) return false;
    const [run] = await this.#rows("runs", `id=eq.${encodeURIComponent(runId)}`, 1);
    return !run || !["QUEUED", "RUNNING", "NEEDS_USER_INPUT"].includes(run.status);
  }

  async canSweepObject(object: CleanupObject): Promise<boolean> {
    const relative = object.key.slice(`instances/${this.#instance}/`.length);
    const id = relative.split("/")[1]?.split(".")[0];
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return false;
    if (object.bucket === "sources") {
      const [source] = await this.#rows("source_documents", `id=eq.${id}`, 1);
      if (!source) return true;
      if (["UPLOADING", "EXTRACTING"].includes(source.status)) return false;
      // Failed deletion retains every key until explicit retry, including temporary files.
      if (source.deleted_at || source.cleanup_status === "FAILED" || source.cleanup_status === "PENDING") return false;
      return relative.includes("/tmp/") || (source.status === "FAILED" && object.key !== source.original_object_key && object.key !== source.extracted_text_object_key);
    }
    if (object.bucket === "exports") {
      const [record] = await this.#rows("exports", `id=eq.${id}`, 1);
      if (!record) return true;
      return !record.deleted_at && record.status === "READY" && relative.endsWith(".tmp");
    }
    const [run] = await this.#rows("runs", `id=eq.${id}`, 1);
    if (!run) return true;
    if (run.deleted_at || ["QUEUED", "RUNNING"].includes(run.status)) return false;
    if (relative.includes("/tmp/")) return true;
    const keyFilter = `storage_object_key=eq.${encodeURIComponent(object.key)}`;
    const artifacts = await this.#rows("artifacts", keyFilter, 1);
    const evidence = await this.#rows("run_evidence_submissions", keyFilter, 1);
    if (artifacts.length) {
      if (!["STAGED", "CLEANUP_PENDING", "DELETED"].includes(artifacts[0]!.status)) return false;
      const artifactId = artifacts[0]!.id;
      const bindings = await this.#rows("runs", `or=(checkpoint_artifact_id.eq.${artifactId},final_resume_artifact_id.eq.${artifactId})`, 1);
      const exports = await this.#rows("exports", `source_artifact_id=eq.${artifactId}`, 1);
      return bindings.length === 0 && exports.length === 0;
    }
    return evidence.length === 0 || evidence[0]!.status === "ABANDONED";
  }

  finishSweptObject(object: CleanupObject): Promise<void> {
    return this.#rpc("rolepilot_cleanup_orphan_metadata", { p_bucket: object.bucket, p_key: object.key });
  }

  #exportKeys(row: Row): string[] {
    const base = `instances/${this.#instance}/exports/${row.id}`;
    return [row.storage_object_key, `${base}.tmp`, `${base}.${row.format?.toLowerCase()}`].filter((key): key is string => Boolean(key));
  }

  async #rows(table: string, filter: string, limit?: number): Promise<Row[]> {
    const result: Row[] = [];
    const pageSize = limit ?? 100;
    for (let offset = 0; ; offset += pageSize) {
      const rows = await this.#client.json<Row[]>(`/rest/v1/${table}?select=*&${this.#filter}&${filter}&order=id.asc&limit=${pageSize}&offset=${offset}`);
      result.push(...rows);
      if (limit || rows.length < pageSize) return result;
    }
  }

  #rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.#client.rpc<T>(name, { p_deployment_instance_id: this.#instance, ...args });
  }
}
