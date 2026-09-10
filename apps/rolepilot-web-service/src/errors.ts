import { DocumentIngestError } from "document-ingest";
import type { ApiErrorCode, InputFieldError, SourceError } from "web-contracts";

export class SourceApiError extends Error {
  readonly code: ApiErrorCode;
  readonly retryable: boolean;
  readonly status: number;

  constructor({
    code,
    message,
    retryable = false,
    status,
  }: {
    code: ApiErrorCode;
    message: string;
    retryable?: boolean;
    status: number;
  }) {
    super(message);
    this.name = "SourceApiError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

export class DraftApiError extends Error {
  readonly code: ApiErrorCode;
  readonly retryable: boolean;
  readonly status: number;
  readonly fieldErrors: InputFieldError[] | undefined;

  constructor({
    code,
    message,
    retryable = false,
    status,
    fieldErrors,
  }: {
    code: ApiErrorCode;
    message: string;
    retryable?: boolean;
    status: number;
    fieldErrors?: InputFieldError[];
  }) {
    super(message);
    this.name = "DraftApiError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

export class SourceRepositoryError extends Error {
  constructor() {
    super("Source repository operation failed.");
    this.name = "SourceRepositoryError";
  }
}

export class IdempotencyKeyConflictError extends Error {
  constructor() {
    super("Idempotency key conflicts with a different request.");
    this.name = "IdempotencyKeyConflictError";
  }
}

export function toSourceError(error: unknown): SourceError {
  if (error instanceof DocumentIngestError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }

  return {
    code: "PARSER_FAILED",
    message: "文档暂时无法保存，请重试。",
    retryable: true,
  };
}
