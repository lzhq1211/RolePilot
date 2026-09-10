import { IdempotencyKeyConflictError, SourceRepositoryError } from "./errors.js";
import type { ListableSourceObjectStore, SourceObjectStore, StoredObjectInfo } from "./source-object-store.js";
import type { IdempotencyStore, SourceReferenceReader, SourceRepository } from "./source-repository.js";
import type { DraftRepository, DraftUpdateResult } from "./draft-repository.js";
import type { InputDraftDto, InputDraftInput } from "web-contracts";
import type {
  CreateSourceRecord,
  DeleteSourceResult,
  IdempotencyRecord,
  IdempotencyResultKind,
  ReadySourceRecord,
  SourceObject,
  SourceRecord,
} from "./types.js";
import type { SourceError, SourceErrorCode } from "web-contracts";
import { DEFAULT_DEPLOYMENT_INSTANCE_ID } from "./deployment.js";

type FetchImplementation = typeof fetch;

type SourceDocumentRow = {
  id: string;
  deployment_instance_id?: string;
  status: SourceRecord["status"];
  input_kind: SourceRecord["inputKind"];
  original_file_name: string | null;
  media_type: SourceRecord["mediaType"];
  size_bytes: number;
  text_length: number | null;
  page_count: number | null;
  parser_version: string | null;
  error_code: SourceErrorCode | null;
  error_message: string | null;
  error_retryable: boolean | null;
  original_object_key: string | null;
  extracted_text_object_key: string | null;
  cleanup_requested_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type IdempotencyRow = {
  deployment_instance_id?: string;
  request_fingerprint: string;
  result_kind: IdempotencyResultKind;
  result_id: string;
  source_id: string | null;
  expires_at: string;
};

type InputDraftRow = {
  id: string;
  deployment_instance_id?: string;
  resume_source_id: string | null;
  company: string;
  title: string;
  jd_text: string;
  revision: number;
  updated_at: string;
};

export class SupabaseSourceObjectStore implements ListableSourceObjectStore {
  readonly #url: string;
  readonly #serviceRoleKey: string;
  readonly #bucket: string;
  readonly #fetch: FetchImplementation;

  constructor({
    url,
    serviceRoleKey,
    bucket,
    fetchImplementation = fetch,
  }: {
    url: string;
    serviceRoleKey: string;
    bucket: string;
    fetchImplementation?: FetchImplementation;
  }) {
    this.#url = url;
    this.#serviceRoleKey = serviceRoleKey;
    this.#bucket = bucket;
    this.#fetch = fetchImplementation;
  }

  async put(object: SourceObject): Promise<void> {
    const response = await this.#fetch(this.#objectUrl(object.key), {
      method: "POST",
      headers: {
        ...this.#headers(),
        "content-type": object.contentType,
        "x-upsert": "false",
      },
      body: Buffer.from(object.bytes),
    });
    if (!response.ok) {
      throw new SourceRepositoryError();
    }
  }

  async read(key: string): Promise<Uint8Array> {
    const response = await this.#fetch(this.#objectUrl(key), {
      headers: this.#headers(),
    });
    if (!response.ok) {
      throw new SourceRepositoryError();
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async remove(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    const response = await this.#fetch(
      new URL(`/storage/v1/object/${encodeURIComponent(this.#bucket)}`, this.#url),
      {
        method: "DELETE",
        headers: {
          ...this.#headers(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ prefixes: keys }),
      },
    );
    if (!response.ok) {
      throw new SourceRepositoryError();
    }
  }

  #objectUrl(key: string): URL {
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    return new URL(
      `/storage/v1/object/${encodeURIComponent(this.#bucket)}/${encodedKey}`,
      this.#url,
    );
  }

  async list(prefix: string): Promise<StoredObjectInfo[]> {
    const result: StoredObjectInfo[] = [];
    const folders = [prefix.replace(/\/$/, "")];
    while (folders.length) {
      const folder = folders.shift()!;
      for (let offset = 0; ; offset += 100) {
        const response = await this.#fetch(new URL(`/storage/v1/object/list/${encodeURIComponent(this.#bucket)}`, this.#url), {
          method: "POST",
          headers: { ...this.#headers(), "content-type": "application/json" },
          body: JSON.stringify({ prefix: folder, limit: 100, offset, sortBy: { column: "name", order: "asc" } }),
        });
        if (!response.ok) throw new SourceRepositoryError();
        const rows = await response.json() as Array<{ name: string; id: string | null; created_at: string | null }>;
        for (const row of rows) {
          if (!row.name || row.name.includes("/") || row.name === "." || row.name === "..") throw new SourceRepositoryError();
          const key = `${folder}/${row.name}`;
          if (row.id === null) folders.push(key);
          else if (row.created_at) result.push({ key, createdAt: row.created_at });
          else throw new SourceRepositoryError();
        }
        if (rows.length < 100) break;
      }
    }
    return result;
  }

  #headers(): Record<string, string> {
    return serviceHeaders(this.#serviceRoleKey);
  }
}

export class SupabaseRunReferenceReader implements SourceReferenceReader {
  readonly #client: SupabaseRestClient;

  constructor({ client }: { client: SupabaseRestClient }) {
    this.#client = client;
  }

  async isReferencedByRun(sourceId: string): Promise<boolean> {
    const rows = await this.#client.json<Array<{ id: string }>>(
      `/rest/v1/runs?select=id&resume_source_id=eq.${encodeURIComponent(sourceId)}&deleted_at=is.null&limit=1`,
    );
    return rows.length > 0;
  }
}

export class SupabaseSourceRepository implements SourceRepository {
  readonly #client: SupabaseRestClient;
  readonly #objectStore: SourceObjectStore;
  readonly #now: () => string;
  readonly #deploymentInstanceId: string;

  constructor({
    client,
    objectStore,
    now = () => new Date().toISOString(),
    deploymentInstanceId = DEFAULT_DEPLOYMENT_INSTANCE_ID,
  }: {
    client: SupabaseRestClient;
    objectStore: SourceObjectStore;
    now?: () => string;
    deploymentInstanceId?: string;
  }) {
    this.#client = client;
    this.#objectStore = objectStore;
    this.#now = now;
    this.#deploymentInstanceId = deploymentInstanceId;
  }

  async createPending(input: CreateSourceRecord): Promise<SourceRecord> {
    const [row] = await this.#client.json<SourceDocumentRow[]>("/rest/v1/source_documents", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        id: input.id,
        deployment_instance_id: this.#deploymentInstanceId,
        status: "UPLOADING",
        input_kind: input.inputKind,
        original_file_name: input.originalFileName,
        media_type: input.mediaType,
        size_bytes: input.sizeBytes,
      }),
    });
    return sourceRecordFromRow(requiredRow(row));
  }

  async markExtracting(sourceId: string): Promise<SourceRecord> {
    return this.#update(sourceId, { status: "EXTRACTING" });
  }

  async markReady(sourceId: string, input: ReadySourceRecord): Promise<SourceRecord> {
    return this.#update(sourceId, {
      status: "READY",
      text_length: input.parsed.textLength,
      page_count: input.parsed.pageCount,
      parser_version: input.parsed.parserVersion,
      error_code: null,
      error_message: null,
      error_retryable: null,
      original_object_key: input.originalObjectKey,
      extracted_text_object_key: input.extractedTextObjectKey,
    });
  }

  async markFailed(sourceId: string, error: SourceError): Promise<SourceRecord> {
    return this.#update(sourceId, {
      status: "FAILED",
      error_code: error.code,
      error_message: error.message,
      error_retryable: error.retryable,
    });
  }

  async get(sourceId: string): Promise<SourceRecord | null> {
    const rows = await this.#client.json<SourceDocumentRow[]>(
      `/rest/v1/source_documents?select=*&id=eq.${encodeURIComponent(sourceId)}&deployment_instance_id=eq.${encodeURIComponent(this.#deploymentInstanceId)}&deleted_at=is.null&limit=1`,
    );
    return rows[0] ? sourceRecordFromRow(rows[0]) : null;
  }

  async delete(sourceId: string): Promise<DeleteSourceResult | null> {
    const row = firstRpcRow(
      await this.#client.rpc<SourceDocumentRow | SourceDocumentRow[] | null>(
        "rolepilot_delete_source_with_reference_check",
        { p_source_id: sourceId, p_deployment_instance_id: this.#deploymentInstanceId },
      ),
    );
    if (!row) return null;
    const source = sourceRecordFromRow(row);
    return source.deletedAt
      ? { kind: "deleted", source }
      : { kind: "pending-cleanup", source };
  }

  async readExtractedText(sourceId: string): Promise<string> {
    const source = await this.get(sourceId);
    if (!source?.extractedTextObjectKey) {
      throw new SourceRepositoryError();
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        await this.#objectStore.read(source.extractedTextObjectKey),
      );
    } catch {
      throw new SourceRepositoryError();
    }
  }

  async #update(
    sourceId: string,
    changes: Partial<SourceDocumentRow>,
  ): Promise<SourceRecord> {
    const [row] = await this.#client.json<SourceDocumentRow[]>(
      `/rest/v1/source_documents?id=eq.${encodeURIComponent(sourceId)}&deployment_instance_id=eq.${encodeURIComponent(this.#deploymentInstanceId)}&deleted_at=is.null`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(changes),
      },
    );
    return sourceRecordFromRow(requiredRow(row));
  }
}

export class SupabaseIdempotencyStore implements IdempotencyStore {
  readonly #client: SupabaseRestClient;
  readonly #now: () => string;
  readonly #deploymentInstanceId: string;

  constructor({
    client,
    now = () => new Date().toISOString(),
    deploymentInstanceId = DEFAULT_DEPLOYMENT_INSTANCE_ID,
  }: {
    client: SupabaseRestClient;
    now?: () => string;
    deploymentInstanceId?: string;
  }) {
    this.#client = client;
    this.#now = now;
    this.#deploymentInstanceId = deploymentInstanceId;
  }

  async get(scope: string, key: string): Promise<IdempotencyRecord | null> {
    const rows = await this.#client.json<IdempotencyRow[]>(
      `/rest/v1/idempotency_keys?select=request_fingerprint,result_kind,result_id,source_id,expires_at,deployment_instance_id&deployment_instance_id=eq.${encodeURIComponent(this.#deploymentInstanceId)}&scope=eq.${encodeURIComponent(scope)}&key=eq.${encodeURIComponent(key)}&expires_at=gt.${encodeURIComponent(this.#now())}&limit=1`,
    );
    const row = rows[0];
    return row
      ? {
          requestFingerprint: row.request_fingerprint,
          resultKind: row.result_kind,
          resultId: row.result_id,
          sourceId: row.source_id,
          expiresAt: row.expires_at,
          deploymentInstanceId: row.deployment_instance_id ?? this.#deploymentInstanceId,
        }
      : null;
  }

  async put(scope: string, key: string, record: IdempotencyRecord): Promise<void> {
    try {
      await this.#client.json<IdempotencyRow[]>("/rest/v1/idempotency_keys", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          deployment_instance_id: this.#deploymentInstanceId,
          scope,
          key,
          request_fingerprint: record.requestFingerprint,
          result_kind: record.resultKind,
          result_id: record.resultId,
          source_id: record.sourceId,
          expires_at: record.expiresAt,
        }),
      });
    } catch (error) {
      if (error instanceof SupabaseRestError && error.code === "23505") {
        throw new IdempotencyKeyConflictError();
      }
      throw error;
    }
  }
}

export class SupabaseDraftRepository implements DraftRepository {
  readonly #client: SupabaseRestClient;
  readonly #deploymentInstanceId: string;

  constructor({ client, deploymentInstanceId = DEFAULT_DEPLOYMENT_INSTANCE_ID }: { client: SupabaseRestClient; deploymentInstanceId?: string }) {
    this.#client = client;
    this.#deploymentInstanceId = deploymentInstanceId;
  }

  async create(input: { id: string } & InputDraftInput): Promise<InputDraftDto> {
    const [row] = await this.#client.json<InputDraftRow[]>("/rest/v1/input_drafts", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        id: input.id,
        deployment_instance_id: this.#deploymentInstanceId,
        resume_source_id: input.resumeSourceId,
        company: input.company,
        title: input.title,
        jd_text: input.jdText,
        revision: 1,
      }),
    });
    return draftFromRow(requiredRow(row));
  }

  async get(draftId: string) {
    const rows = await this.#client.json<InputDraftRow[]>(
      `/rest/v1/input_drafts?select=id,resume_source_id,company,title,jd_text,revision,updated_at,deployment_instance_id&id=eq.${encodeURIComponent(draftId)}&deployment_instance_id=eq.${encodeURIComponent(this.#deploymentInstanceId)}&deleted_at=is.null&limit=1`,
    );
    return rows[0] ? draftFromRow(rows[0]) : null;
  }

  async update(
    draftId: string,
    expectedRevision: number,
    input: InputDraftInput,
  ): Promise<DraftUpdateResult> {
    const rows = await this.#client.json<InputDraftRow[]>(
      `/rest/v1/input_drafts?id=eq.${encodeURIComponent(draftId)}&deployment_instance_id=eq.${encodeURIComponent(this.#deploymentInstanceId)}&revision=eq.${expectedRevision}&deleted_at=is.null`,
      {
        method: "PATCH",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          resume_source_id: input.resumeSourceId,
          company: input.company,
          title: input.title,
          jd_text: input.jdText,
          revision: expectedRevision + 1,
        }),
      },
    );
    if (rows[0]) {
      return { kind: "updated", draft: draftFromRow(rows[0]) };
    }

    const current = await this.get(draftId);
    return current
      ? { kind: "conflict", current }
      : { kind: "not-found" };
  }
}

export class SupabaseRestClient {
  readonly #url: string;
  readonly #serviceRoleKey: string;
  readonly #fetch: FetchImplementation;

  constructor({
    url,
    serviceRoleKey,
    fetchImplementation = fetch,
  }: {
    url: string;
    serviceRoleKey: string;
    fetchImplementation?: FetchImplementation;
  }) {
    this.#url = url;
    this.#serviceRoleKey = serviceRoleKey;
    this.#fetch = fetchImplementation;
  }

  async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.#fetch(new URL(path, this.#url), {
      ...init,
      headers: {
        ...serviceHeaders(this.#serviceRoleKey),
        accept: "application/json",
        "content-type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new SupabaseRestError(await readErrorCode(response));
    }
    if (response.status === 204) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new SourceRepositoryError();
    }
  }

  async rpc<T>(functionName: string, args: Record<string, unknown>): Promise<T> {
    return this.json<T>(`/rest/v1/rpc/${encodeURIComponent(functionName)}`, {
      method: "POST",
      body: JSON.stringify(args),
    });
  }
}

export function createSupabaseSourceInfrastructure({
  url,
  serviceRoleKey,
  bucket,
  artifactBucket = "rolepilot-artifacts",
  exportBucket = "rolepilot-exports",
  deploymentInstanceId = DEFAULT_DEPLOYMENT_INSTANCE_ID,
  fetchImplementation,
}: {
  url: string;
  serviceRoleKey: string;
  bucket: string;
  artifactBucket?: string;
  exportBucket?: string;
  deploymentInstanceId?: string;
  fetchImplementation?: FetchImplementation;
}): {
  client: SupabaseRestClient;
  repository: SourceRepository;
  objectStore: ListableSourceObjectStore;
  artifactObjectStore: ListableSourceObjectStore;
  exportObjectStore: ListableSourceObjectStore;
  idempotencyStore: IdempotencyStore;
  deploymentInstanceId: string;
} {
  const client = new SupabaseRestClient({
    url,
    serviceRoleKey,
    fetchImplementation,
  });
  const objectStore = new SupabaseSourceObjectStore({
    url,
    serviceRoleKey,
    bucket,
    fetchImplementation,
  });
  const artifactObjectStore = new SupabaseSourceObjectStore({
    url,
    serviceRoleKey,
    bucket: artifactBucket,
    fetchImplementation,
  });
  const exportObjectStore = new SupabaseSourceObjectStore({
    url,
    serviceRoleKey,
    bucket: exportBucket,
    fetchImplementation,
  });
  return {
    client,
    repository: new SupabaseSourceRepository({ client, objectStore, deploymentInstanceId }),
    objectStore,
    artifactObjectStore,
    exportObjectStore,
    idempotencyStore: new SupabaseIdempotencyStore({ client, deploymentInstanceId }),
    deploymentInstanceId,
  };
}

export class SupabaseRestError extends SourceRepositoryError {
  readonly code: string | null;

  constructor(code: string | null) {
    super();
    this.name = "SupabaseRestError";
    this.code = code;
  }
}

function sourceRecordFromRow(row: SourceDocumentRow): SourceRecord {
  const error = row.error_code
    ? {
        code: row.error_code,
        message: row.error_message ?? "无法读取这份文档。",
        retryable: row.error_retryable ?? false,
      }
    : null;
  return {
    id: row.id,
    deploymentInstanceId: row.deployment_instance_id ?? DEFAULT_DEPLOYMENT_INSTANCE_ID,
    status: row.status,
    inputKind: row.input_kind,
    originalFileName: row.original_file_name,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    textLength: row.text_length,
    pageCount: row.page_count,
    parserVersion: row.parser_version,
    error,
    originalObjectKey: row.original_object_key,
    extractedTextObjectKey: row.extracted_text_object_key,
    cleanupRequestedAt: row.cleanup_requested_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function draftFromRow(row: InputDraftRow) {
  return {
    id: row.id,
    resumeSourceId: row.resume_source_id,
    company: row.company,
    title: row.title,
    jdText: row.jd_text,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

function requiredRow<T>(row: T | undefined): T {
  if (!row) {
    throw new SourceRepositoryError();
  }
  return row;
}

function firstRpcRow<T>(value: T | T[] | null): T | null {
  const row = Array.isArray(value) ? value[0] ?? null : value;
  return isNullComposite(row) ? null : row;
}

function isNullComposite(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "id" in value && (value as { id?: unknown }).id === null);
}

async function readErrorCode(response: Response): Promise<string | null> {
  try {
    const payload = (await response.json()) as { code?: unknown };
    return typeof payload.code === "string" ? payload.code : null;
  } catch {
    return null;
  }
}

function serviceHeaders(serviceRoleKey: string): Record<string, string> {
  const headers = { apikey: serviceRoleKey };
  return serviceRoleKey.startsWith("sb_")
    ? headers
    : { ...headers, authorization: `Bearer ${serviceRoleKey}` };
}
