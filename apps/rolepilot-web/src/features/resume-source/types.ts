import type { ApiError, ResumeSourceDto } from "web-contracts";

export type ResumeInputMode = "file" | "pasted-text";

export type ResumeSourceUiError = Pick<ApiError, "code" | "message" | "retryable">;

export type ResumeSourceUiState =
  | { kind: "empty" }
  | { kind: "uploading"; fileName: string; requestId: string }
  | { kind: "extracting"; fileName: string; requestId: string }
  | { kind: "ready"; source: ResumeSourceDto }
  | { kind: "failed"; previous: ResumeSourceDto | null; error: ResumeSourceUiError };
