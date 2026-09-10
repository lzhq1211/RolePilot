import type { SourceError } from "web-contracts";

import { IdempotencyKeyConflictError, SourceRepositoryError } from "./errors.js";
import type { SourceObjectStore } from "./source-object-store.js";
import type {
  CreateSourceRecord,
  DeleteSourceResult,
  IdempotencyRecord,
  ReadySourceRecord,
  SourceRecord,
} from "./types.js";
import { DEFAULT_DEPLOYMENT_INSTANCE_ID } from "./deployment.js";

export interface SourceReferenceReader {
  isReferencedByRun(sourceId: string): Promise<boolean>;
}

export interface SourceRepository {
  createPending(input: CreateSourceRecord): Promise<SourceRecord>;
  markExtracting(sourceId: string): Promise<SourceRecord>;
  markReady(sourceId: string, input: ReadySourceRecord): Promise<SourceRecord>;
  markFailed(sourceId: string, error: SourceError): Promise<SourceRecord>;
  get(sourceId: string): Promise<SourceRecord | null>;
  delete(sourceId: string): Promise<DeleteSourceResult | null>;
  readExtractedText(sourceId: string): Promise<string>;
}

export interface IdempotencyStore {
  get(scope: string, key: string): Promise<IdempotencyRecord | null>;
  put(
    scope: string,
    key: string,
    record: IdempotencyRecord,
  ): Promise<void>;
}

export class InMemorySourceRepository implements SourceRepository {
  readonly #records: Map<string, SourceRecord>;
  readonly #clock: () => string;
  readonly #objectStore: SourceObjectStore;
  readonly #referenceReader: SourceReferenceReader;

  constructor({
    clock = () => new Date().toISOString(),
    objectStore,
    referenceReader,
    records = new Map<string, SourceRecord>(),
  }: {
    clock?: () => string;
    objectStore: SourceObjectStore;
    referenceReader: SourceReferenceReader;
    records?: Map<string, SourceRecord>;
  }) {
    this.#clock = clock;
    this.#objectStore = objectStore;
    this.#referenceReader = referenceReader;
    this.#records = records;
  }

  async createPending(input: CreateSourceRecord): Promise<SourceRecord> {
    if (this.#records.has(input.id)) {
      throw new SourceRepositoryError();
    }

    const now = this.#clock();
    const record: SourceRecord = {
      ...input,
      deploymentInstanceId: input.deploymentInstanceId ?? DEFAULT_DEPLOYMENT_INSTANCE_ID,
      status: "UPLOADING",
      textLength: null,
      pageCount: null,
      parserVersion: null,
      error: null,
      originalObjectKey: null,
      extractedTextObjectKey: null,
      cleanupRequestedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.#records.set(record.id, record);
    return structuredClone(record);
  }

  async markExtracting(sourceId: string): Promise<SourceRecord> {
    return this.#updateActive(sourceId, (record) => ({
      ...record,
      status: "EXTRACTING",
      updatedAt: this.#clock(),
    }));
  }

  async markReady(sourceId: string, input: ReadySourceRecord): Promise<SourceRecord> {
    return this.#updateActive(sourceId, (record) => ({
      ...record,
      status: "READY",
      textLength: input.parsed.textLength,
      pageCount: input.parsed.pageCount,
      parserVersion: input.parsed.parserVersion,
      error: null,
      originalObjectKey: input.originalObjectKey,
      extractedTextObjectKey: input.extractedTextObjectKey,
      updatedAt: this.#clock(),
    }));
  }

  async markFailed(sourceId: string, error: SourceError): Promise<SourceRecord> {
    return this.#updateActive(sourceId, (record) => ({
      ...record,
      status: "FAILED",
      error: structuredClone(error),
      updatedAt: this.#clock(),
    }));
  }

  async get(sourceId: string): Promise<SourceRecord | null> {
    const record = this.#records.get(sourceId);
    return record && !record.deletedAt ? structuredClone(record) : null;
  }

  async delete(sourceId: string): Promise<DeleteSourceResult | null> {
    const record = await this.get(sourceId);
    if (!record) {
      return null;
    }

    if (await this.#referenceReader.isReferencedByRun(sourceId)) {
      const source = await this.#updateActive(sourceId, (active) => ({
        ...active,
        cleanupRequestedAt: this.#clock(),
        updatedAt: this.#clock(),
      }));
      return { kind: "pending-cleanup", source };
    }

    const deletedAt = this.#clock();
    const deleted: SourceRecord = {
      ...record,
      updatedAt: deletedAt,
      deletedAt,
    };
    this.#records.set(sourceId, deleted);
    return { kind: "deleted", source: structuredClone(deleted) };
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

  activeCount(): number {
    return Array.from(this.#records.values()).filter((record) => !record.deletedAt).length;
  }

  async #updateActive(
    sourceId: string,
    update: (record: SourceRecord) => SourceRecord,
  ): Promise<SourceRecord> {
    const current = this.#records.get(sourceId);
    if (!current || current.deletedAt) {
      throw new SourceRepositoryError();
    }
    const next = update(current);
    this.#records.set(sourceId, next);
    return structuredClone(next);
  }
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  readonly #records: Map<string, IdempotencyRecord>;
  readonly #clock: () => string;

  constructor({ clock = () => new Date().toISOString(), records = new Map<string, IdempotencyRecord>() }: {
    clock?: () => string; records?: Map<string, IdempotencyRecord>;
  } = {}) {
    this.#clock = clock;
    this.#records = records;
  }

  async get(scope: string, key: string): Promise<IdempotencyRecord | null> {
    const compoundKey = `${scope}\u0000${key}`;
    const record = this.#records.get(compoundKey);
    if (!record) {
      return null;
    }
    if (record.expiresAt <= this.#clock()) {
      this.#records.delete(compoundKey);
      return null;
    }
    return structuredClone(record);
  }

  async put(scope: string, key: string, record: IdempotencyRecord): Promise<void> {
    const compoundKey = `${scope}\u0000${key}`;
    const current = await this.get(scope, key);
    if (current && current.requestFingerprint !== record.requestFingerprint) {
      throw new IdempotencyKeyConflictError();
    }
    if (!current) {
      this.#records.set(compoundKey, structuredClone(record));
    }
  }
}
