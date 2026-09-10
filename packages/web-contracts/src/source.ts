export const RESUME_SOURCE_STATUSES = ["UPLOADING", "EXTRACTING", "READY", "FAILED"] as const;
export type ResumeSourceStatus = (typeof RESUME_SOURCE_STATUSES)[number];

export const RESUME_SOURCE_MEDIA_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
] as const;
export type ResumeSourceMediaType = (typeof RESUME_SOURCE_MEDIA_TYPES)[number];

export const SOURCE_ERROR_CODES = [
  "FILE_TOO_LARGE",
  "UNSUPPORTED_EXTENSION",
  "UNSUPPORTED_MEDIA_TYPE",
  "CONTENT_SIGNATURE_MISMATCH",
  "EMPTY_DOCUMENT",
  "TEXT_TOO_LONG",
  "ENCODING_UNSUPPORTED",
  "PDF_TEXT_UNAVAILABLE",
  "PDF_ENCRYPTED",
  "DOCX_INVALID",
  "DOCX_ARCHIVE_LIMIT",
  "PARSER_TIMEOUT",
  "PARSER_FAILED",
] as const;
export type SourceErrorCode = (typeof SOURCE_ERROR_CODES)[number];

export type SourceError = {
  code: SourceErrorCode;
  message: string;
  retryable: boolean;
};

export type ResumeSourceDto = {
  id: string;
  status: ResumeSourceStatus;
  inputKind: "file" | "pasted-text";
  originalFileName: string | null;
  mediaType: ResumeSourceMediaType;
  sizeBytes: number;
  textLength: number | null;
  pageCount: number | null;
  previewText: string | null;
  parserVersion: string | null;
  error: SourceError | null;
  createdAt: string;
  updatedAt: string;
};
