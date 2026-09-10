import { SOURCE_LIMITS } from "web-contracts";

import { DocumentIngestError } from "./errors.js";

export const DOCUMENT_INGEST_PARSER_VERSION = "document-ingest/pdf-v1";
export const DOCX_DOCUMENT_INGEST_PARSER_VERSION = "document-ingest/docx-v1";

export function countCodePoints(text: string): number {
  return Array.from(text).length;
}

export function assertWithinFileSizeLimit(bytes: Uint8Array): void {
  if (bytes.byteLength > SOURCE_LIMITS.maxFileBytes) {
    throw new DocumentIngestError("FILE_TOO_LARGE");
  }
}

export function assertWithinTextLengthLimit(text: string): number {
  const textLength = countCodePoints(text);
  if (textLength > SOURCE_LIMITS.maxTextCodePoints) {
    throw new DocumentIngestError("TEXT_TOO_LONG");
  }
  return textLength;
}
