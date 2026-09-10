import { inflateRawSync } from "node:zlib";

import { SOURCE_LIMITS } from "web-contracts";

import { DocumentIngestError } from "./errors.js";
import {
  assertWithinTextLengthLimit,
  DOCX_DOCUMENT_INGEST_PARSER_VERSION,
} from "./limits.js";
import { hasUsableText, normalizeText } from "./normalize-text.js";
import type { ParseInput, ParsedDocument } from "./types.js";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const MAIN_DOCUMENT_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

type ZipEntry = {
  name: string;
  flags: number;
  compressionMethod: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  dataOffset: number;
  externalAttributes: number;
};

export async function parseDocx(input: ParseInput): Promise<ParsedDocument> {
  throwIfAborted(input.signal);

  try {
    const entries = parseZipArchive(input.bytes);
    const entryMap = new Map<string, ZipEntry>();
    for (const entry of entries) {
      if (entryMap.has(entry.name)) {
        throw new DocumentIngestError("DOCX_INVALID");
      }
      entryMap.set(entry.name, entry);
    }

    const contentTypes = readRequiredXml(entryMap, input.bytes, "[Content_Types].xml");
    const rootRelationships = readRequiredXml(entryMap, input.bytes, "_rels/.rels");
    const documentXml = readRequiredXml(entryMap, input.bytes, "word/document.xml");

    validateContentTypes(contentTypes);
    validateRootRelationships(rootRelationships);
    validateRelationships(entries, entryMap, input.bytes);
    validateDocumentXml(documentXml);

    const text = normalizeText(extractDocumentText(documentXml)).replace(/\n+$/g, "");
    if (!hasUsableText(text)) {
      throw new DocumentIngestError("EMPTY_DOCUMENT");
    }
    throwIfAborted(input.signal);

    return {
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      text,
      textLength: assertWithinTextLengthLimit(text),
      pageCount: null,
      parserVersion: DOCX_DOCUMENT_INGEST_PARSER_VERSION,
    };
  } catch (error) {
    if (error instanceof DocumentIngestError) {
      throw error;
    }
    throw new DocumentIngestError("DOCX_INVALID");
  }
}

function parseZipArchive(bytes: Uint8Array): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(bytes);
  const diskNumber = readUint16(bytes, eocdOffset + 4);
  const centralDirectoryDisk = readUint16(bytes, eocdOffset + 6);
  const entriesOnDisk = readUint16(bytes, eocdOffset + 8);
  const entryCount = readUint16(bytes, eocdOffset + 10);
  const centralDirectorySize = readUint32(bytes, eocdOffset + 12);
  const centralDirectoryOffset = readUint32(bytes, eocdOffset + 16);
  const commentLength = readUint16(bytes, eocdOffset + 20);

  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff ||
    eocdOffset + 22 + commentLength !== bytes.byteLength
  ) {
    throw new DocumentIngestError("DOCX_INVALID");
  }
  if (entryCount > SOURCE_LIMITS.maxDocxEntries) {
    throw new DocumentIngestError("DOCX_ARCHIVE_LIMIT");
  }

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (
    centralDirectoryEnd < centralDirectoryOffset ||
    centralDirectoryEnd > eocdOffset ||
    centralDirectoryEnd > bytes.byteLength
  ) {
    throw new DocumentIngestError("DOCX_INVALID");
  }

  const entries: ZipEntry[] = [];
  const dataRanges: Array<{ start: number; end: number }> = [];
  let offset = centralDirectoryOffset;
  let totalUncompressedBytes = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > centralDirectoryEnd || readUint32(bytes, offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new DocumentIngestError("DOCX_INVALID");
    }

    const flags = readUint16(bytes, offset + 8);
    const compressionMethod = readUint16(bytes, offset + 10);
    const crc32 = readUint32(bytes, offset + 16);
    const compressedSize = readUint32(bytes, offset + 20);
    const uncompressedSize = readUint32(bytes, offset + 24);
    const fileNameLength = readUint16(bytes, offset + 28);
    const extraLength = readUint16(bytes, offset + 30);
    const commentLengthForEntry = readUint16(bytes, offset + 32);
    const externalAttributes = readUint32(bytes, offset + 38);
    const localHeaderOffset = readUint32(bytes, offset + 42);
    const nameStart = offset + 46;
    const entryEnd = nameStart + fileNameLength + extraLength + commentLengthForEntry;
    if (entryEnd < nameStart || entryEnd > centralDirectoryEnd) {
      throw new DocumentIngestError("DOCX_INVALID");
    }

    const name = decodeZipName(bytes.subarray(nameStart, nameStart + fileNameLength));
    validateEntryName(name, externalAttributes);
    if ((flags & 0x0001) !== 0) {
      throw new DocumentIngestError("DOCX_INVALID");
    }
    if (uncompressedSize > SOURCE_LIMITS.maxDocxUncompressedBytes) {
      throw new DocumentIngestError("DOCX_ARCHIVE_LIMIT");
    }
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > SOURCE_LIMITS.maxDocxUncompressedBytes) {
      throw new DocumentIngestError("DOCX_ARCHIVE_LIMIT");
    }

    const dataOffset = validateLocalHeader(
      bytes,
      localHeaderOffset,
      name,
      compressionMethod,
      compressedSize,
      centralDirectoryOffset,
    );
    const dataEnd = dataOffset + compressedSize;
    if (dataEnd < dataOffset || dataEnd > centralDirectoryOffset) {
      throw new DocumentIngestError("DOCX_INVALID");
    }
    dataRanges.push({ start: localHeaderOffset, end: dataEnd });
    entries.push({
      name,
      flags,
      compressionMethod,
      crc32,
      compressedSize,
      uncompressedSize,
      dataOffset,
      externalAttributes,
    });
    offset = entryEnd;
  }

  if (offset !== centralDirectoryEnd) {
    throw new DocumentIngestError("DOCX_INVALID");
  }
  dataRanges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < dataRanges.length; index += 1) {
    if (dataRanges[index]!.start < dataRanges[index - 1]!.end) {
      throw new DocumentIngestError("DOCX_INVALID");
    }
  }
  return entries;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimumOffset = Math.max(0, bytes.byteLength - 22 - 0xffff);
  for (let offset = bytes.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (offset >= 0 && readUint32(bytes, offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new DocumentIngestError("DOCX_INVALID");
}

function validateLocalHeader(
  bytes: Uint8Array,
  offset: number,
  expectedName: string,
  expectedCompressionMethod: number,
  compressedSize: number,
  centralDirectoryOffset: number,
): number {
  if (offset + 30 > centralDirectoryOffset || readUint32(bytes, offset) !== LOCAL_FILE_SIGNATURE) {
    throw new DocumentIngestError("DOCX_INVALID");
  }
  const flags = readUint16(bytes, offset + 6);
  const compressionMethod = readUint16(bytes, offset + 8);
  const fileNameLength = readUint16(bytes, offset + 26);
  const extraLength = readUint16(bytes, offset + 28);
  const nameStart = offset + 30;
  const dataOffset = nameStart + fileNameLength + extraLength;
  if (
    (flags & 0x0001) !== 0 ||
    compressionMethod !== expectedCompressionMethod ||
    dataOffset < nameStart ||
    dataOffset > centralDirectoryOffset ||
    decodeZipName(bytes.subarray(nameStart, nameStart + fileNameLength)) !== expectedName
  ) {
    throw new DocumentIngestError("DOCX_INVALID");
  }
  if (dataOffset + compressedSize > centralDirectoryOffset) {
    throw new DocumentIngestError("DOCX_INVALID");
  }
  return dataOffset;
}

function validateEntryName(name: string, externalAttributes: number): void {
  const parts = name.split("/");
  const depth = name.endsWith("/") ? parts.length - 1 : parts.length;
  const unixFileType = (externalAttributes >>> 16) & 0xf000;
  if (
    !name ||
    name.includes("\u0000") ||
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[a-z]:/i.test(name) ||
    depth > SOURCE_LIMITS.maxDocxPathDepth ||
    parts.some((part, index) => part === ".." || part === "." || (part === "" && index !== parts.length - 1)) ||
    (unixFileType !== 0 && unixFileType !== 0x4000 && unixFileType !== 0x8000)
  ) {
    throw new DocumentIngestError("DOCX_INVALID");
  }
}

function readRequiredXml(
  entries: Map<string, ZipEntry>,
  bytes: Uint8Array,
  name: string,
): string {
  const entry = entries.get(name);
  if (!entry || name.endsWith("/")) {
    throw new DocumentIngestError("DOCX_INVALID");
  }
  return decodeXml(extractEntry(bytes, entry));
}

function extractEntry(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const compressed = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  let output: Uint8Array;
  try {
    if (entry.compressionMethod === 0) {
      output = compressed;
    } else if (entry.compressionMethod === 8) {
      output = inflateRawSync(compressed, {
        maxOutputLength: SOURCE_LIMITS.maxDocxUncompressedBytes,
      });
    } else {
      throw new DocumentIngestError("DOCX_INVALID");
    }
  } catch (error) {
    if (error instanceof DocumentIngestError) {
      throw error;
    }
    throw new DocumentIngestError("DOCX_INVALID");
  }
  if (output.byteLength !== entry.uncompressedSize || crc32(output) !== entry.crc32) {
    throw new DocumentIngestError("DOCX_INVALID");
  }
  return output;
}

function validateContentTypes(xml: string): void {
  if (!/<(?:[a-z][\w.-]*:)?Types\b/i.test(xml) || /macroenabled|vbaproject/i.test(xml)) {
    throw new DocumentIngestError("DOCX_INVALID");
  }
  const hasMainDocument = [...xml.matchAll(/<(?:[a-z][\w.-]*:)?Override\b[^>]*>/gi)].some((match) => {
    const attributes = xmlAttributes(match[0]);
    return (
      attributes.PartName?.toLowerCase() === "/word/document.xml" &&
      attributes.ContentType === MAIN_DOCUMENT_CONTENT_TYPE
    );
  });
  if (!hasMainDocument) {
    throw new DocumentIngestError("DOCX_INVALID");
  }
}

function validateRootRelationships(xml: string): void {
  if (!/<(?:[a-z][\w.-]*:)?Relationships\b/i.test(xml)) {
    throw new DocumentIngestError("DOCX_INVALID");
  }
  const hasDocumentTarget = [...xml.matchAll(/<(?:[a-z][\w.-]*:)?Relationship\b[^>]*>/gi)].some((match) => {
    const attributes = xmlAttributes(match[0]);
    return attributes.Target === "word/document.xml" || attributes.Target === "/word/document.xml";
  });
  if (!hasDocumentTarget) {
    throw new DocumentIngestError("DOCX_INVALID");
  }
}

function validateRelationships(
  entries: readonly ZipEntry[],
  entryMap: Map<string, ZipEntry>,
  bytes: Uint8Array,
): void {
  for (const entry of entries) {
    if (entry.name.toLowerCase().includes("vbaproject")) {
      throw new DocumentIngestError("DOCX_INVALID");
    }
    if (!entry.name.toLowerCase().endsWith(".rels")) {
      continue;
    }
    const xml = readRequiredXml(entryMap, bytes, entry.name);
    for (const match of xml.matchAll(/<(?:[a-z][\w.-]*:)?Relationship\b[^>]*>/gi)) {
      const attributes = xmlAttributes(match[0]);
      if (
        attributes.TargetMode?.toLowerCase() === "external" ||
        /^(?:https?:|file:|data:|\\\\|\/\/)/i.test(attributes.Target ?? "")
      ) {
        throw new DocumentIngestError("DOCX_INVALID");
      }
    }
  }
}

function validateDocumentXml(xml: string): void {
  if (!/<w:document\b[^>]*>/i.test(xml) || !/<w:body\b[^>]*>/i.test(xml)) {
    throw new DocumentIngestError("DOCX_INVALID");
  }
  if (
    [...xml.matchAll(/<w:p\b[^>]*>/gi)].filter((match) => !/\/\s*>$/.test(match[0])).length !==
      [...xml.matchAll(/<\/w:p\s*>/gi)].length ||
    [...xml.matchAll(/<w:t\b[^>]*>/gi)].filter((match) => !/\/\s*>$/.test(match[0])).length !==
      [...xml.matchAll(/<\/w:t\s*>/gi)].length
  ) {
    throw new DocumentIngestError("DOCX_INVALID");
  }
}

function extractDocumentText(xml: string): string {
  const paragraphs: string[] = [];
  const paragraphPattern = /<w:p\b[^>]*\/\s*>|<w:p\b[^>]*>([\s\S]*?)<\/w:p\s*>/gi;
  for (const match of xml.matchAll(paragraphPattern)) {
    const body = match[1] ?? "";
    let paragraph = "";
    const tokenPattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t\s*>|<w:(tab|br|cr)\b[^>]*\/\s*>/gi;
    for (const token of body.matchAll(tokenPattern)) {
      if (token[1] !== undefined) {
        paragraph += decodeXmlText(token[1]);
      } else if (token[2] === "tab") {
        paragraph += "\t";
      } else {
        paragraph += "\n";
      }
    }
    paragraphs.push(paragraph);
  }
  return paragraphs.join("\n");
}

function decodeXml(bytes: Uint8Array): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
    validateXmlWellFormed(withoutBom);
    return withoutBom;
  } catch {
    throw new DocumentIngestError("DOCX_INVALID");
  }
}

function validateXmlWellFormed(xml: string): void {
  const stack: string[] = [];
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    if (start === -1) {
      break;
    }
    if (xml.slice(start, start + 4) === "<!--") {
      const commentEnd = xml.indexOf("-->", start + 4);
      if (commentEnd === -1) {
        throw new DocumentIngestError("DOCX_INVALID");
      }
      cursor = commentEnd + 3;
      continue;
    }
    if (xml.slice(start, start + 9) === "<![CDATA[") {
      const cdataEnd = xml.indexOf("]]>", start + 9);
      if (cdataEnd === -1) {
        throw new DocumentIngestError("DOCX_INVALID");
      }
      cursor = cdataEnd + 3;
      continue;
    }
    const end = findXmlTagEnd(xml, start + 1);
    if (end === -1) {
      throw new DocumentIngestError("DOCX_INVALID");
    }
    const tag = xml.slice(start + 1, end).trim();
    if (!tag || tag.startsWith("?") || tag.startsWith("!")) {
      cursor = end + 1;
      continue;
    }
    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      if (!/^[a-z_][\w:.-]*$/i.test(name) || stack.pop() !== name) {
        throw new DocumentIngestError("DOCX_INVALID");
      }
    } else {
      const selfClosing = /\/\s*$/.test(tag);
      const opening = selfClosing ? tag.replace(/\/\s*$/, "").trim() : tag;
      const nameMatch = /^([a-z_][\w:.-]*)\b/i.exec(opening);
      if (!nameMatch || !xmlTagAttributesAreQuoted(opening.slice(nameMatch[0].length))) {
        throw new DocumentIngestError("DOCX_INVALID");
      }
      if (!selfClosing) {
        stack.push(nameMatch[1]!);
      }
    }
    cursor = end + 1;
  }
  if (stack.length > 0) {
    throw new DocumentIngestError("DOCX_INVALID");
  }
}

function findXmlTagEnd(xml: string, start: number): number {
  let quote: string | null = null;
  for (let index = start; index < xml.length; index += 1) {
    const character = xml[index]!;
    if (quote) {
      if (character === quote) {
        quote = null;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function xmlTagAttributesAreQuoted(attributes: string): boolean {
  let quote: string | null = null;
  for (const character of attributes.trim()) {
    if (quote) {
      if (character === quote) {
        quote = null;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    }
  }
  return quote === null;
}

function decodeXmlText(value: string): string {
  if (value.includes("<") || value.includes("\u0000")) {
    throw new DocumentIngestError("DOCX_INVALID");
  }
  const decoded = value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (entity, body: string) => {
      if (body === "amp") return "&";
      if (body === "lt") return "<";
      if (body === "gt") return ">";
      if (body === "quot") return '"';
      if (body === "apos") return "'";
      const codePoint = body.toLowerCase().startsWith("#x")
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        throw new DocumentIngestError("DOCX_INVALID");
      }
      return String.fromCodePoint(codePoint);
    },
  );
  if (/&(?:#x?[0-9a-f]+|[a-z][\w.-]*);/i.test(decoded)) {
    throw new DocumentIngestError("DOCX_INVALID");
  }
  return decoded;
}

function xmlAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of tag.matchAll(/([a-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    attributes[match[1]!] = decodeXmlText(match[2] ?? match[3] ?? "");
  }
  return attributes;
}

function decodeZipName(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DocumentIngestError("DOCX_INVALID");
  }
}

function readUint16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) {
    throw new DocumentIngestError("DOCX_INVALID");
  }
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) {
    throw new DocumentIngestError("DOCX_INVALID");
  }
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  ) >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DocumentIngestError("PARSER_FAILED");
  }
}
