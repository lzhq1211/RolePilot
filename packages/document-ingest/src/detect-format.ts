import { DocumentIngestError } from "./errors.js";
import type { ParseInput } from "./types.js";

export type DocumentFormat = "docx" | "pdf" | "txt";

type BinarySignature = "pdf" | "zip" | "ole" | null;

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function detectBinarySignature(bytes: Uint8Array): BinarySignature {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return "pdf";
  }
  if (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return "zip";
  }
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return "ole";
  }
  return null;
}

function getExtension(originalFileName: string | null): string | null {
  if (!originalFileName) {
    return null;
  }

  const fileName = originalFileName.trim();
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex > 0 ? fileName.slice(dotIndex).toLowerCase() : null;
}

function normalizeDeclaredMediaType(mediaType: string | null): string | null {
  if (!mediaType) {
    return null;
  }
  return mediaType.split(";", 1)[0]?.trim().toLowerCase() || null;
}

export function validateDocumentInput(input: ParseInput): DocumentFormat {
  const extension = getExtension(input.originalFileName);
  const mediaType = normalizeDeclaredMediaType(input.declaredMediaType);
  const signature = detectBinarySignature(input.bytes);

  if (extension === ".pdf") {
    if (mediaType !== null && mediaType !== "application/pdf") {
      throw new DocumentIngestError("UNSUPPORTED_MEDIA_TYPE");
    }
    if (signature !== "pdf") {
      throw new DocumentIngestError("CONTENT_SIGNATURE_MISMATCH");
    }
    return "pdf";
  }

  if (extension === ".docx") {
    if (
      mediaType !== null &&
      mediaType !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      throw new DocumentIngestError("UNSUPPORTED_MEDIA_TYPE");
    }
    if (signature !== "zip") {
      throw new DocumentIngestError("CONTENT_SIGNATURE_MISMATCH");
    }
    return "docx";
  }

  if (extension !== ".txt") {
    throw new DocumentIngestError("UNSUPPORTED_EXTENSION");
  }

  if (mediaType !== null && mediaType !== "text/plain") {
    throw new DocumentIngestError("UNSUPPORTED_MEDIA_TYPE");
  }

  if (signature !== null) {
    throw new DocumentIngestError("CONTENT_SIGNATURE_MISMATCH");
  }
  return "txt";
}

export function validateTxtInput(input: ParseInput): void {
  if (validateDocumentInput(input) !== "txt") {
    throw new DocumentIngestError("UNSUPPORTED_EXTENSION");
  }
}
