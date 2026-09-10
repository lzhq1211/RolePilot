import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  normalizeInputDraft,
  validateInputDraft,
  type CreateRunInput,
  type RunDto,
} from "web-contracts";

import { IdempotencyKeyConflictError } from "./errors.js";
import type { SourceRepository } from "./source-repository.js";
import type {
  CreateRunIdempotentInput,
  RunRepository,
} from "./run-repository.js";
import { RunRepositoryError, toRunDto } from "./run-types.js";
import { DEFAULT_DEPLOYMENT_INSTANCE_ID } from "./deployment.js";

const IDEMPOTENCY_SCOPE = "runs.create";
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export class RunServiceError extends Error {
  readonly code: "REQUEST_INVALID" | "SOURCE_NOT_FOUND" | "SOURCE_NOT_READY" | "SOURCE_TEXT_UNAVAILABLE" | "RUN_NOT_FOUND";
  readonly fieldErrors: Array<{ field: "resume" | "company" | "title" | "jd"; code: string; message: string }> | undefined;

  constructor(
    code: "REQUEST_INVALID" | "SOURCE_NOT_FOUND" | "SOURCE_NOT_READY" | "SOURCE_TEXT_UNAVAILABLE" | "RUN_NOT_FOUND",
    message: string,
    fieldErrors?: RunServiceError["fieldErrors"],
  ) {
    super(message);
    this.name = "RunServiceError";
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

export type RunServiceOptions = {
  sourceRepository: SourceRepository;
  runRepository: RunRepository;
  workDir: string;
  now?: () => Date;
  idFactory?: () => string;
  eventIdFactory?: () => string;
  onRunQueued?: (run: RunDto) => void | Promise<void>;
  cancellationRegistry?: import("./run-cancel.js").RunCancellationRegistry;
  deploymentInstanceId?: string;
  onRunDeleted?: (run: import("./run-types.js").RunRecord) => void | Promise<void>;
};

export class RunService {
  readonly #sourceRepository: SourceRepository;
  readonly #runRepository: RunRepository;
  readonly #workDir: string;
  readonly #now: () => Date;
  readonly #idFactory: () => string;
  readonly #eventIdFactory: () => string;
  readonly #onRunQueued: (run: RunDto) => void | Promise<void>;
  readonly #cancellationRegistry: import("./run-cancel.js").RunCancellationRegistry | undefined;
  readonly #deploymentInstanceId: string;
  readonly #onRunDeleted: (run: import("./run-types.js").RunRecord) => void | Promise<void>;

  constructor({
    sourceRepository,
    runRepository,
    workDir,
    now = () => new Date(),
    idFactory = randomUUID,
    eventIdFactory = randomUUID,
    onRunQueued = () => undefined,
    cancellationRegistry,
    deploymentInstanceId = DEFAULT_DEPLOYMENT_INSTANCE_ID,
    onRunDeleted = () => undefined,
  }: RunServiceOptions) {
    this.#sourceRepository = sourceRepository;
    this.#runRepository = runRepository;
    this.#workDir = workDir;
    this.#now = now;
    this.#idFactory = idFactory;
    this.#eventIdFactory = eventIdFactory;
    this.#onRunQueued = onRunQueued;
    this.#cancellationRegistry = cancellationRegistry;
    this.#deploymentInstanceId = deploymentInstanceId;
    this.#onRunDeleted = onRunDeleted;
  }

  async create(input: CreateRunInput, idempotencyKey: string): Promise<{ run: RunDto; reused: boolean }> {
    const normalizedKey = requireIdempotencyKey(idempotencyKey);
    const normalized = normalizeCreateInput(input);
    const source = await this.#sourceRepository.get(normalized.resumeSourceId);
    if (!source) throw new RunServiceError("SOURCE_NOT_FOUND", "未找到这份简历来源。");
    if (source.status !== "READY" || !source.extractedTextObjectKey || source.deletedAt || source.cleanupRequestedAt) {
      throw new RunServiceError("SOURCE_NOT_READY", "简历来源尚未准备好，无法创建运行。");
    }
    try {
      await this.#sourceRepository.readExtractedText(source.id);
    } catch {
      throw new RunServiceError("SOURCE_TEXT_UNAVAILABLE", "简历文本暂时不可用，无法创建运行。");
    }

    const runId = this.#idFactory();
    const createdAt = this.#now().toISOString();
    const workspace = path.join(this.#workDir, "runs", runId);
    const record: CreateRunIdempotentInput = {
      id: runId,
      resumeSourceId: normalized.resumeSourceId,
      company: normalized.company,
      title: normalized.title,
      jdText: normalized.jdText,
      extractedTextObjectKey: source.extractedTextObjectKey,
      createdAt,
      eventId: this.#eventIdFactory(),
      deploymentInstanceId: this.#deploymentInstanceId,
      idempotencyKey: normalizedKey,
      requestFingerprint: fingerprint(normalized),
      expiresAt: new Date(this.#now().getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
    };

    try {
      const result = await this.#runRepository.createIdempotent(record);
      const run = toRunDto(result.run);
      if (!result.reused) {
        await mkdir(workspace, { recursive: true });
        await this.#notifyQueued(run);
      }
      return { run, reused: result.reused };
    } catch (error) {
      if (error instanceof IdempotencyKeyConflictError) throw error;
      if (error instanceof RunRepositoryError && error.code === "RUN_NOT_RESUMABLE") {
        throw new RunServiceError("SOURCE_NOT_READY", "简历来源尚未准备好，无法创建运行。");
      }
      throw error;
    }
  }

  async claimNext(eventId = this.#eventIdFactory()) {
    return this.#runRepository.claimNext(eventId);
  }

  async startupRecoverRunning(): Promise<number> {
    return this.#runRepository.startupRecoverRunning();
  }

  async get(runId: string) {
    return this.#runRepository.get(runId);
  }

  async list() {
    return this.#runRepository.list();
  }

  async eventsAfter(runId: string, sequence: number) {
    return this.#runRepository.eventsAfter(runId, sequence);
  }

  async delete(runId: string) {
    const current = await this.#runRepository.get(runId, { includeDeleted: true });
    if (!current) return null;
    if (current.deletedAt) return current;
    if (current.status === "QUEUED" || current.status === "RUNNING" || this.#cancellationRegistry?.has(runId)) {
      throw new RunRepositoryError("RUN_CONFLICT");
    }
    const deleted = await this.#runRepository.softDelete(runId);
    if (deleted) await this.#onRunDeleted(deleted);
    return deleted;
  }

  async cancel(runId: string, eventHub?: import("./run-events.js").RunEventHub) {
    const { cancelRun } = await import("./run-cancel.js");
    const cancelled = await cancelRun({ runService: this, runRepository: this.#runRepository, runId, eventHub });
    if (cancelled) this.#cancellationRegistry?.cancel(runId);
    return cancelled;
  }

  get repository(): RunRepository { return this.#runRepository; }

  async #notifyQueued(run: RunDto): Promise<void> {
    try {
      await this.#onRunQueued(run);
    } catch {
      // Queue persistence is authoritative; polling will observe this Run.
    }
  }
}

function normalizeCreateInput(input: CreateRunInput): CreateRunInput {
  if (!input || typeof input !== "object") {
    throw new RunServiceError("REQUEST_INVALID", "创建运行请求无效。");
  }
  const value = input as Record<string, unknown>;
  const expected = ["resumeSourceId", "company", "title", "jdText"];
  if (Object.keys(value).some((key) => !expected.includes(key))) {
    throw new RunServiceError("REQUEST_INVALID", "创建运行请求包含未知字段。");
  }
  const normalized = normalizeInputDraft({
    resumeSourceId: typeof value.resumeSourceId === "string" ? value.resumeSourceId : "",
    company: typeof value.company === "string" ? value.company : "",
    title: typeof value.title === "string" ? value.title : "",
    jdText: typeof value.jdText === "string" ? value.jdText : "",
  });
  const errors = validateInputDraft(normalized, { requireValues: true });
  if (typeof value.resumeSourceId !== "string" || normalized.resumeSourceId === null) {
    errors.unshift({ field: "resume", code: "REQUIRED", message: "请选择并解析简历。" });
  }
  if (errors.length > 0) throw new RunServiceError("REQUEST_INVALID", "创建运行请求无效。", errors);
  return {
    resumeSourceId: normalized.resumeSourceId!,
    company: normalized.company,
    title: normalized.title,
    jdText: normalized.jdText,
  };
}

function requireIdempotencyKey(value: string): string {
  const key = value.trim();
  if (key.length === 0 || key.length > 200) {
    throw new RunServiceError("REQUEST_INVALID", "缺少有效的 Idempotency-Key。");
  }
  return key;
}

function fingerprint(input: CreateRunInput): string {
  return createHash("sha256")
    .update(JSON.stringify([input.resumeSourceId, input.company, input.title, input.jdText]))
    .digest("hex");
}
