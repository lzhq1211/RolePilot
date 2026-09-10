import { validateDocumentInput } from "./detect-format.js";
import { DocumentIngestError } from "./errors.js";
import {
  assertWithinFileSizeLimit,
  assertWithinTextLengthLimit,
  DOCUMENT_INGEST_PARSER_VERSION,
} from "./limits.js";
import { hasUsableText, normalizeText } from "./normalize-text.js";
import { decodeTxt } from "./parse-txt.js";
import { parsePdf } from "./parse-pdf.js";
import { parseDocx } from "./parse-docx.js";
import type { DocumentParser, ParseInput, ParsedDocument } from "./types.js";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DocumentIngestError("PARSER_FAILED");
  }
}

export async function parseDocument(input: ParseInput): Promise<ParsedDocument> {
  throwIfAborted(input.signal);
  assertWithinFileSizeLimit(input.bytes);
  const format = validateDocumentInput(input);
  if (format === "pdf") {
    return parsePdf(input);
  }
  if (format === "docx") {
    return parseDocx(input);
  }

  const text = normalizeText(decodeTxt(input.bytes));
  throwIfAborted(input.signal);
  if (!hasUsableText(text)) {
    throw new DocumentIngestError("EMPTY_DOCUMENT");
  }

  return {
    mediaType: "text/plain",
    text,
    textLength: assertWithinTextLengthLimit(text),
    pageCount: null,
    parserVersion: DOCUMENT_INGEST_PARSER_VERSION,
  };
}

export const documentParser: DocumentParser = {
  parse: parseDocument,
};
