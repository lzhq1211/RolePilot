import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  DOCUMENT_INGEST_PARSER_VERSION,
  DocumentIngestError,
  parseDocument,
} from "../dist/index.js";
import {
  createTextPdf,
  encryptedPdfBytes,
  malformedPdfBytes,
} from "./fixtures/pdf-fixtures.mjs";

const encoder = new TextEncoder();

function fixtureBytes(fileName) {
  return new Uint8Array(fs.readFileSync(new URL(`./fixtures/${fileName}`, import.meta.url)));
}

function parseTxt(bytes, overrides = {}) {
  return parseDocument({
    bytes,
    originalFileName: "resume.txt",
    declaredMediaType: "text/plain",
    ...overrides,
  });
}

function parsePdf(bytes, overrides = {}) {
  return parseDocument({
    bytes,
    originalFileName: "resume.pdf",
    declaredMediaType: "application/pdf",
    ...overrides,
  });
}

function encodeUtf16Be(text) {
  const encoded = new Uint8Array(text.length * 2);
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    encoded[index * 2] = codeUnit >> 8;
    encoded[index * 2 + 1] = codeUnit & 0xff;
  }
  return encoded;
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof DocumentIngestError);
    assert.equal(error.code, code);
    return true;
  });
}

test("TXT fixture is parsed deterministically with shared metadata", async () => {
  const input = fixtureBytes("utf8-resume.txt");
  const result = await parseTxt(input);

  assert.deepEqual(result, {
    mediaType: "text/plain",
    text: "Lin Yu\nBackend Engineer\n\nBuilt reliable APIs.\n",
    textLength: 46,
    pageCount: null,
    parserVersion: DOCUMENT_INGEST_PARSER_VERSION,
  });
  assert.equal(DOCUMENT_INGEST_PARSER_VERSION, "document-ingest/pdf-v1");
});

test("TXT normalizes UTF-8 BOM and every newline form without trimming body text", async () => {
  const bytes = new Uint8Array([
    0xef,
    0xbb,
    0xbf,
    ...encoder.encode("  Lin Yu  \r\nPlatform Engineer\rBuilt APIs\n"),
  ]);

  const result = await parseTxt(bytes, {
    declaredMediaType: "text/plain; charset=utf-8",
  });

  assert.equal(result.text, "  Lin Yu  \nPlatform Engineer\nBuilt APIs\n");
  assert.equal(result.textLength, 40);
});

test("TXT accepts UTF-16 LE and BE only through an explicit BOM or clear byte pattern", async () => {
  const leBody = new Uint8Array(Buffer.from("Lin Yu\r\n工程师", "utf16le"));
  const le = new Uint8Array([0xff, 0xfe, ...leBody]);
  const beBody = encodeUtf16Be("Lin Yu\r\n工程师");
  const be = new Uint8Array([0xfe, 0xff, ...beBody]);
  const bomlessLe = new Uint8Array(Buffer.from("Lin Yu\nBackend", "utf16le"));

  assert.equal((await parseTxt(le)).text, "Lin Yu\n工程师");
  assert.equal((await parseTxt(be)).text, "Lin Yu\n工程师");
  assert.equal((await parseTxt(bomlessLe)).text, "Lin Yu\nBackend");
});

test("TXT rejects blank, malformed, oversized, and binary-like input", async () => {
  await expectCode(parseTxt(encoder.encode(" \n\t\r")), "EMPTY_DOCUMENT");
  await expectCode(parseTxt(new Uint8Array([0xc3, 0x28])), "ENCODING_UNSUPPORTED");
  await expectCode(
    parseTxt(encoder.encode("a".repeat(200_001))),
    "TEXT_TOO_LONG",
  );
  await expectCode(parseTxt(new Uint8Array(10 * 1024 * 1024 + 1)), "FILE_TOO_LARGE");
  await expectCode(parseTxt(new Uint8Array([0x4c, 0x00, 0x69])), "ENCODING_UNSUPPORTED");
});

test("TXT rejects extension, declared media type, and binary signature mismatches", async () => {
  const plainText = encoder.encode("Lin Yu");

  await expectCode(
    parseTxt(plainText, { originalFileName: "resume.pdf" }),
    "UNSUPPORTED_MEDIA_TYPE",
  );
  await expectCode(
    parseTxt(plainText, { declaredMediaType: "application/pdf" }),
    "UNSUPPORTED_MEDIA_TYPE",
  );
  await expectCode(
    parseTxt(encoder.encode("%PDF-1.7\nnot a text upload")),
    "CONTENT_SIGNATURE_MISMATCH",
  );
  await expectCode(
    parseTxt(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x61, 0x62])),
    "CONTENT_SIGNATURE_MISMATCH",
  );
});

test("PDF extracts text in page order with one LF between pages", async () => {
  const input = createTextPdf([
    ["Lin Yu", "Platform Engineer"],
    ["Built reliable APIs."],
  ]);

  const result = await parsePdf(input);

  assert.deepEqual(result, {
    mediaType: "application/pdf",
    text: "Lin Yu\nPlatform Engineer\nBuilt reliable APIs.",
    textLength: 45,
    pageCount: 2,
    parserVersion: DOCUMENT_INGEST_PARSER_VERSION,
  });
});

test("PDF rejects text-unavailable, encrypted, and malformed fixtures safely", async () => {
  await expectCode(parsePdf(createTextPdf([[]])), "PDF_TEXT_UNAVAILABLE");
  await expectCode(parsePdf(encryptedPdfBytes()), "PDF_ENCRYPTED");
  await expectCode(parsePdf(malformedPdfBytes()), "PARSER_FAILED");
});

test("same PDF input produces byte-equivalent parser output on repeat", async () => {
  const input = createTextPdf([["Lin Yu"], ["Platform Engineer"]]);
  const first = await parsePdf(input);
  const second = await parsePdf(input);

  assert.deepEqual(second, first);
  assert.deepEqual(
    encoder.encode(JSON.stringify(second)),
    encoder.encode(JSON.stringify(first)),
  );
});

test("same TXT input produces byte-equivalent parser output on repeat", async () => {
  const input = fixtureBytes("utf8-resume.txt");
  const first = await parseTxt(input);
  const second = await parseTxt(input);

  assert.deepEqual(second, first);
  assert.deepEqual(
    encoder.encode(JSON.stringify(second)),
    encoder.encode(JSON.stringify(first)),
  );
});
