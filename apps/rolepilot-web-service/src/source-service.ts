import { createHash, randomUUID } from "node:crypto";

import {
  documentParser as defaultDocumentParser,
  DocumentIngestError,
  validateDocumentInput,
  type DocumentParser,
} from "document-ingest";
import {
  SOURCE_LIMITS,
  type ResumeSourceMediaType,
  type ResumeSourceDto,
  type SourceError,
} from "web-contracts";

import {
  IdempotencyKeyConflictError,
  SourceApiError,
  toSourceError,
} from "./errors.js";
import type { SourceObjectStore } from "./source-object-store.js";
import type { IdempotencyStore, SourceRepository } from "./source-repository.js";
import type { DeleteSourceResult, SourceInputKind, SourceRecord } from "./types.js";
import { DEFAULT_DEPLOYMENT_INSTANCE_ID, instanceObjectKey } from "./deployment.js";

const IDEMPOTENCY_SCOPE = "resume-sources.create";
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export type CreateSourceInput = {
  inputKind: SourceInputKind;
  bytes: Uint8Array;
  originalFileName: string | null;
  declaredMediaType: string | null;
};

export class SourceService {
  readonly #repository: SourceRepository;
  readonly #objectStore: SourceObjectStore;
  readonly #idempotencyStore: IdempotencyStore;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #documentParser: DocumentParser;
  readonly #parserTimeoutMs: number;
  readonly #deploymentInstanceId: string;
  readonly #deferCleanup: boolean;
  readonly #onCleanupFailed: (sourceId: string) => Promise<void>;

  constructor({
    repository,
    objectStore,
    idempotencyStore,
    now = () => new Date(),
    idFactory = randomUUID,
    documentParser = defaultDocumentParser,
    parserTimeoutMs = SOURCE_LIMITS.parserTimeoutMs,
    deploymentInstanceId = DEFAULT_DEPLOYMENT_INSTANCE_ID,
    deferCleanup = false,
    onCleanupFailed = async () => undefined,
  }: {
    repository: SourceRepository;
    objectStore: SourceObjectStore;
    idempotencyStore: IdempotencyStore;
    now?: () => Date;
    idFactory?: () => string;
    documentParser?: DocumentParser;
    parserTimeoutMs?: number;
    deploymentInstanceId?: string;
    deferCleanup?: boolean;
    onCleanupFailed?: (sourceId: string) => Promise<void>;
  }) {
    this.#repository = repository;
    this.#objectStore = objectStore;
    this.#idempotencyStore = idempotencyStore;
    this.#now = now;
    this.#idFactory = idFactory;
    this.#documentParser = documentParser;
    this.#parserTimeoutMs = parserTimeoutMs;
    this.#deploymentInstanceId = deploymentInstanceId;
    this.#deferCleanup = deferCleanup;
    this.#onCleanupFailed = onCleanupFailed;
  }

  async create(input: CreateSourceInput, idempotencyKey: string): Promise<ResumeSourceDto> {
    const normalizedKey = this.#requireIdempotencyKey(idempotencyKey);
    const mediaType = this.#validateCreateInput(input);

    const fingerprint = requestFingerprint(input);
    const existing = await this.#idempotencyStore.get(IDEMPOTENCY_SCOPE, normalizedKey);
    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        throw idempotencyConflict();
      }
      if (existing.resultKind !== "source" || !existing.sourceId) {
        throw idempotencyConflict();
      }
      const source = await this.#repository.get(existing.sourceId);
      if (!source) {
        throw idempotencyConflict();
      }
      return this.#toDto(source);
    }

    const sourceId = this.#idFactory();
    const source = await this.#repository.createPending({
      id: sourceId,
      inputKind: input.inputKind,
      originalFileName: input.originalFileName,
      mediaType,
      sizeBytes: input.bytes.byteLength,
      deploymentInstanceId: this.#deploymentInstanceId,
    });
    const completed = await this.#processSource(source, input);

    try {
      await this.#idempotencyStore.put(IDEMPOTENCY_SCOPE, normalizedKey, {
        requestFingerprint: fingerprint,
        resultKind: "source",
        resultId: sourceId,
        sourceId,
        expiresAt: new Date(this.#now().getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
      });
    } catch (error) {
      if (!(error instanceof IdempotencyKeyConflictError)) {
        throw error;
      }

      const winner = await this.#idempotencyStore.get(IDEMPOTENCY_SCOPE, normalizedKey);
      if (!winner || winner.requestFingerprint !== fingerprint) {
        throw idempotencyConflict();
      }
      if (winner.resultKind !== "source" || !winner.sourceId) {
        throw idempotencyConflict();
      }
      const existingSource = await this.#repository.get(winner.sourceId);
      if (!existingSource) {
        throw idempotencyConflict();
      }
      await this.#discardDuplicate(completed);
      return this.#toDto(existingSource);
    }

    return this.#toDto(completed);
  }

  async get(sourceId: string): Promise<ResumeSourceDto | null> {
    const source = await this.#repository.get(sourceId);
    return source ? this.#toDto(source) : null;
  }

  async delete(sourceId: string): Promise<DeleteSourceResult | null> {
    const result = await this.#repository.delete(sourceId);
    if (!result || result.kind === "pending-cleanup" || this.#deferCleanup) {
      return result;
    }

    const keys = [
      result.source.originalObjectKey,
      result.source.extractedTextObjectKey,
    ].filter((key): key is string => key !== null);
    if (keys.length > 0) {
      await this.#objectStore.remove(keys);
    }
    return result;
  }

  async #processSource(source: SourceRecord, input: CreateSourceInput): Promise<SourceRecord> {
    const originalKey = instanceObjectKey(this.#deploymentInstanceId, "sources", source.id, "original.bin");
    const extractedKey = instanceObjectKey(this.#deploymentInstanceId, "sources", source.id, "extracted.txt");
    const temporaryOriginalKey = `${instanceObjectKey(this.#deploymentInstanceId, "sources", source.id, "tmp")}/${this.#idFactory()}.original.bin`;
    const temporaryExtractedKey = `${instanceObjectKey(this.#deploymentInstanceId, "sources", source.id, "tmp")}/${this.#idFactory()}.extracted.txt`;
    const createdKeys: string[] = [];

    try {
      await this.#objectStore.put({
        key: temporaryOriginalKey,
        bytes: input.bytes,
        contentType: input.declaredMediaType ?? "application/octet-stream",
      });
      createdKeys.push(temporaryOriginalKey);
      await this.#repository.markExtracting(source.id);

      const parsed = await parseWithTimeout(
        this.#documentParser,
        {
          bytes: input.bytes,
          originalFileName:
            input.originalFileName ?? "pasted-resume.txt",
          declaredMediaType: input.declaredMediaType ?? "text/plain",
        },
        this.#parserTimeoutMs,
      );
      const extractedBytes = new TextEncoder().encode(parsed.text);

      await this.#objectStore.put({
        key: temporaryExtractedKey,
        bytes: extractedBytes,
        contentType: "text/plain; charset=utf-8",
      });
      createdKeys.push(temporaryExtractedKey);
      await this.#objectStore.put({
        key: originalKey,
        bytes: input.bytes,
        contentType: input.declaredMediaType ?? "application/octet-stream",
      });
      createdKeys.push(originalKey);
      await this.#objectStore.put({
        key: extractedKey,
        bytes: extractedBytes,
        contentType: "text/plain; charset=utf-8",
      });
      createdKeys.push(extractedKey);
      await this.#objectStore.remove([temporaryOriginalKey, temporaryExtractedKey]);

      return this.#repository.markReady(source.id, {
        parsed,
        originalObjectKey: originalKey,
        extractedTextObjectKey: extractedKey,
      });
    } catch (error) {
      const sourceError = toSourceError(error);
      try {
        await this.#objectStore.remove(createdKeys);
      } catch {
        await this.#onCleanupFailed(source.id);
        return this.#repository.markFailed(source.id, {
          code: "PARSER_FAILED",
          message: "文档暂时无法保存，请重试。",
          retryable: true,
        });
      }
      return this.#repository.markFailed(source.id, sourceError);
    }
  }

  async #discardDuplicate(source: SourceRecord): Promise<void> {
    const result = await this.#repository.delete(source.id);
    if (!result || result.kind === "pending-cleanup" || this.#deferCleanup) {
      return;
    }
    const keys = [
      result.source.originalObjectKey,
      result.source.extractedTextObjectKey,
    ].filter((key): key is string => key !== null);
    if (keys.length > 0) {
      await this.#objectStore.remove(keys);
    }
  }

  async #toDto(source: SourceRecord): Promise<ResumeSourceDto> {
    const previewText =
      source.status === "READY"
        ? preview(await this.#repository.readExtractedText(source.id))
        : null;

    return {
      id: source.id,
      status: source.status,
      inputKind: source.inputKind,
      originalFileName: source.originalFileName,
      mediaType: source.mediaType,
      sizeBytes: source.sizeBytes,
      textLength: source.textLength,
      pageCount: source.pageCount,
      previewText,
      parserVersion: source.parserVersion,
      error: source.error,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    };
  }

  #requireIdempotencyKey(key: string): string {
    const normalized = key.trim();
    if (!normalized) {
      throw new SourceApiError({
        code: "REQUEST_INVALID",
        message: "缺少 Idempotency-Key。",
        status: 400,
      });
    }
    return normalized;
  }

  #validateCreateInput(input: CreateSourceInput): ResumeSourceMediaType {
    if (input.bytes.byteLength > SOURCE_LIMITS.maxFileBytes) {
      throw new SourceApiError({
        code: "FILE_TOO_LARGE",
        message: "文件超过 10 MiB 限制。",
        status: 413,
      });
    }
    if (input.inputKind === "file" && !isSafeFileName(input.originalFileName)) {
      throw new SourceApiError({
        code: "REQUEST_INVALID",
        message: "文件名无效。",
        status: 400,
      });
    }

    try {
      const format = validateDocumentInput({
        bytes: input.bytes,
        originalFileName: input.originalFileName ?? "pasted-resume.txt",
        declaredMediaType: input.declaredMediaType ?? "text/plain",
      });
      if (format === "pdf") {
        return "application/pdf";
      }
      if (format === "docx") {
        return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      }
      return "text/plain";
    } catch (error) {
      if (!(error instanceof DocumentIngestError)) {
        throw error;
      }
      throw new SourceApiError({
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        status: error.code === "FILE_TOO_LARGE" ? 413 : 400,
      });
    }
  }
}

async function parseWithTimeout(
  parser: DocumentParser,
  input: Parameters<DocumentParser["parse"]>[0],
  timeoutMs: number,
) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      parser.parse({ ...input, signal: controller.signal }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new DocumentIngestError("PARSER_TIMEOUT"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function requestFingerprint(input: CreateSourceInput): string {
  const hash = createHash("sha256");
  hash.update(input.inputKind);
  hash.update("\u0000");
  hash.update(input.originalFileName ?? "");
  hash.update("\u0000");
  hash.update(input.declaredMediaType ?? "");
  hash.update("\u0000");
  hash.update(input.bytes);
  return `sha256:${hash.digest("hex")}`;
}

function preview(text: string): string {
  return Array.from(text).slice(0, SOURCE_LIMITS.maxPreviewCodePoints).join("");
}

function isSafeFileName(fileName: string | null): boolean {
  return Boolean(fileName && fileName.trim() && !/[\\/\u0000]/.test(fileName));
}

function idempotencyConflict(): SourceApiError {
  return new SourceApiError({
    code: "IDEMPOTENCY_CONFLICT",
    message: "此 Idempotency-Key 已用于不同请求。",
    status: 409,
  });
}
