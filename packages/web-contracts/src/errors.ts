import type { SourceErrorCode } from "./source.js";
import type { InputFieldError } from "./draft.js";

export const API_ERROR_CODES = [
  "SOURCE_NOT_FOUND",
  "DRAFT_NOT_FOUND",
  "DRAFT_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "REQUEST_INVALID",
  "NETWORK_ERROR",
  "RUN_CONFLICT",
  "RUN_NOT_FOUND",
  "RUN_NOT_CANCELLABLE",
  "RUN_NOT_RESUMABLE",
  "EVENT_CURSOR_INVALID",
  "DELETE_CONFIRMATION_REQUIRED",
  "SOURCE_TEXT_UNAVAILABLE",
  "RESULT_NOT_READY",
  "RESULT_UNAVAILABLE",
  "RESULT_CONTRACT_INVALID",
  "WORKBENCH_DOCUMENT_NOT_FOUND",
  "WORKBENCH_REVISION_CONFLICT",
  "EXPORT_UNAVAILABLE",
  "INSTANCE_BUSY",
  "CLEANUP_UNAVAILABLE",
] as const;

export type ApiErrorCode = SourceErrorCode | (typeof API_ERROR_CODES)[number];

export type ApiError = {
  code: ApiErrorCode;
  message: string;
  retryable: boolean;
  requestId: string;
  fieldErrors?: InputFieldError[];
};

export type ApiErrorResponse = { error: ApiError };
