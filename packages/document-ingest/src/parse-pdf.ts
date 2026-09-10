import {
  getDocument,
  InvalidPDFException,
  PasswordException,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";

import { DocumentIngestError } from "./errors.js";
import {
  assertWithinTextLengthLimit,
  DOCUMENT_INGEST_PARSER_VERSION,
} from "./limits.js";
import { hasUsableText, normalizeText } from "./normalize-text.js";
import type { ParseInput, ParsedDocument } from "./types.js";

export async function parsePdf(input: ParseInput): Promise<ParsedDocument> {
  throwIfAborted(input.signal);

  const loadingTask = getDocument({
    data: input.bytes.slice(),
    disableAutoFetch: true,
    disableFontFace: true,
    disableRange: true,
    disableStream: true,
    enableXfa: false,
    isImageDecoderSupported: false,
    isOffscreenCanvasSupported: false,
    maxImageSize: 0,
    stopAtErrors: true,
    useSystemFonts: false,
    useWasm: false,
    useWorkerFetch: false,
    verbosity: 0,
  });

  let document: PDFDocumentProxy | undefined;
  try {
    document = await waitForDocument(loadingTask, input.signal);
    const pageTexts: string[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      throwIfAborted(input.signal);
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pageTexts.push(pageText(content.items));
    }

    const text = normalizeText(pageTexts.map(trimTrailingLineFeeds).join("\n"));
    if (!hasUsableText(text)) {
      throw new DocumentIngestError("PDF_TEXT_UNAVAILABLE");
    }

    return {
      mediaType: "application/pdf",
      text,
      textLength: assertWithinTextLengthLimit(text),
      pageCount: document.numPages,
      parserVersion: DOCUMENT_INGEST_PARSER_VERSION,
    };
  } catch (error) {
    throw toDocumentIngestError(error);
  } finally {
    await destroyPdf(loadingTask);
  }
}

function pageText(items: readonly unknown[]): string {
  return items
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const { hasEOL, str } = item as { str?: unknown; hasEOL?: unknown };
      if (typeof str !== "string") {
        return "";
      }
      return hasEOL ? `${str}\n` : str;
    })
    .join("");
}

function trimTrailingLineFeeds(text: string): string {
  return text.replace(/\n+$/g, "");
}

async function waitForDocument(
  loadingTask: PDFDocumentLoadingTask,
  signal: AbortSignal | undefined,
): Promise<PDFDocumentProxy> {
  if (!signal) {
    return loadingTask.promise;
  }
  if (signal.aborted) {
    await loadingTask.destroy();
    throw new DocumentIngestError("PARSER_FAILED");
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      void loadingTask.destroy();
      reject(new DocumentIngestError("PARSER_FAILED"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    loadingTask.promise.then(
      (document) => {
        signal.removeEventListener("abort", onAbort);
        resolve(document);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DocumentIngestError("PARSER_FAILED");
  }
}

function toDocumentIngestError(error: unknown): DocumentIngestError {
  if (error instanceof DocumentIngestError) {
    return error;
  }
  if (error instanceof PasswordException || error?.constructor === PasswordException) {
    return new DocumentIngestError("PDF_ENCRYPTED");
  }
  if (error instanceof InvalidPDFException || error?.constructor === InvalidPDFException) {
    return new DocumentIngestError("PARSER_FAILED");
  }
  return new DocumentIngestError("PARSER_FAILED");
}

async function destroyPdf(loadingTask: PDFDocumentLoadingTask): Promise<void> {
  try {
    await loadingTask.destroy();
  } catch {
    // 清理失败不能覆盖稳定的解析错误。
  }
}
