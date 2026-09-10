import assert from "node:assert/strict";
import test from "node:test";

import {
  DOCX_DOCUMENT_INGEST_PARSER_VERSION,
  DocumentIngestError,
  parseDocument,
} from "../dist/index.js";
import { createDocx, createZip } from "./fixtures/docx-fixtures.mjs";

const DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const encoder = new TextEncoder();

function parseDocx(bytes, overrides = {}) {
  return parseDocument({
    bytes,
    originalFileName: "resume.docx",
    declaredMediaType: DOCX_MEDIA_TYPE,
    ...overrides,
  });
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof DocumentIngestError);
    assert.equal(error.code, code);
    return true;
  });
}

test("DOCX extracts paragraph, list, tab, and explicit line-break text in order", async () => {
  const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Experience</w:t><w:tab/><w:t>Platform</w:t><w:br/><w:t>Engineer</w:t></w:r></w:p>
        <w:p><w:r><w:t>Built &amp; operated reliable APIs.</w:t></w:r></w:p>
      </w:body>
    </w:document>`;

  const result = await parseDocx(createDocx({ documentXml }));

  assert.deepEqual(result, {
    mediaType: DOCX_MEDIA_TYPE,
    text: "Experience\tPlatform\nEngineer\nBuilt & operated reliable APIs.",
    textLength: 60,
    pageCount: null,
    parserVersion: DOCX_DOCUMENT_INGEST_PARSER_VERSION,
  });
  assert.equal(result.text.includes("<w:"), false);
});

test("DOCX accepts the regular-file Unix mode used by common ZIP writers", async () => {
  const result = await parseDocx(
    createDocx({
      extraEntries: [{ name: "word/styles.xml", data: "<styles/>", externalAttributes: 0x81b40000 }],
    }),
  );
  assert.equal(result.text, "Lin Yu");
});

test("DOCX preserves empty paragraph boundaries as newlines", async () => {
  const documentXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:p><w:r><w:t>After blank</w:t></w:r></w:p></w:body></w:document>`;
  const result = await parseDocx(createDocx({ documentXml }));
  assert.equal(result.text, "\nAfter blank");
});

test("DOCX rejects non-Open XML containers and malformed XML as structured errors", async () => {
  await expectCode(parseDocx(encoder.encode("not a zip")), "CONTENT_SIGNATURE_MISMATCH");
  await expectCode(parseDocx(createZip([])), "DOCX_INVALID");
  await expectCode(
    parseDocx(createDocx(), { declaredMediaType: "application/octet-stream" }),
    "UNSUPPORTED_MEDIA_TYPE",
  );
  await expectCode(
    parseDocx(createZip([{ name: "word/document.xml", data: "<w:document/>" }])),
    "DOCX_INVALID",
  );
  await expectCode(parseDocx(createDocx({ documentXml: "<w:document><w:body><w:p><w:t>broken" })), "DOCX_INVALID");
  await expectCode(parseDocx(createDocx({ documentXml: "<w:document xmlns:w=\"x\"><w:body><w:p/></w:body></w:document>" })), "EMPTY_DOCUMENT");
});

test("DOCX rejects doc/docm extensions, macro entries, and external relationships", async () => {
  await expectCode(
    parseDocx(createDocx(), { originalFileName: "resume.doc" }),
    "UNSUPPORTED_EXTENSION",
  );
  await expectCode(
    parseDocx(createDocx(), { originalFileName: "resume.docm" }),
    "UNSUPPORTED_EXTENSION",
  );
  await expectCode(
    parseDocx(createDocx({ extraEntries: [{ name: "word/vbaProject.bin", data: "macro" }] })),
    "DOCX_INVALID",
  );
  await expectCode(
    parseDocx(
      createDocx({
        rootRelationships: `<Relationships><Relationship Target="word/document.xml"/><Relationship TargetMode="External" Target="https://example.test/document.xml"/></Relationships>`,
      }),
    ),
    "DOCX_INVALID",
  );
  await expectCode(
    parseDocx(
      createDocx({
        rootRelationships: `<Relationships><Relationship Target="word/document.xml"/><Relationship TargetMode="&#x45;xternal" Target="https://example.test/document.xml"/></Relationships>`,
      }),
    ),
    "DOCX_INVALID",
  );
});

test("DOCX rejects path traversal, symlinks, and archive limits before extraction", async () => {
  await expectCode(
    parseDocx(createDocx({ extraEntries: [{ name: "../outside.txt", data: "unsafe" }] })),
    "DOCX_INVALID",
  );
  await expectCode(
    parseDocx(createDocx({ extraEntries: [{ name: "word/link", data: "unsafe", externalAttributes: 0xa0000000 }] })),
    "DOCX_INVALID",
  );
  const deepPath = `${Array.from({ length: 33 }, () => "nested").join("/")}/entry.xml`;
  await expectCode(parseDocx(createDocx({ extraEntries: [{ name: deepPath, data: "unsafe" }] })), "DOCX_INVALID");
  const tooManyEntries = Array.from({ length: 2_001 }, (_, index) => ({
    name: `extra/${index}.xml`,
    data: "x",
  }));
  await expectCode(parseDocx(createDocx({ extraEntries: tooManyEntries })), "DOCX_ARCHIVE_LIMIT");
  await expectCode(
    parseDocx(
      createDocx({
        extraEntries: [{ name: "word/huge.xml", data: "x", declaredUncompressedSize: 50 * 1024 * 1024 + 1 }],
      }),
    ),
    "DOCX_ARCHIVE_LIMIT",
  );
});

test("DOCX applies the shared extracted-text limit", async () => {
  const longText = "a".repeat(200_001);
  const documentXml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${longText}</w:t></w:r></w:p></w:body></w:document>`;
  await expectCode(parseDocx(createDocx({ documentXml })), "TEXT_TOO_LONG");
});

test("same DOCX input produces byte-equivalent parser output on repeat", async () => {
  const input = createDocx();
  const first = await parseDocx(input);
  const second = await parseDocx(input);

  assert.deepEqual(second, first);
  assert.deepEqual(encoder.encode(JSON.stringify(second)), encoder.encode(JSON.stringify(first)));
});
