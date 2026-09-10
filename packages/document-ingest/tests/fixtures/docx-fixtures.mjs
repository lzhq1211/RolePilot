import { deflateRawSync } from "node:zlib";

const encoder = new TextEncoder();
const MAIN_DOCUMENT_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";

const DEFAULT_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="${MAIN_DOCUMENT_CONTENT_TYPE}"/>
</Types>`;

const DEFAULT_ROOT_RELATIONSHIPS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DEFAULT_DOCUMENT = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>Lin Yu</w:t></w:r></w:p></w:body>
</w:document>`;

export function createDocx({
  documentXml = DEFAULT_DOCUMENT,
  contentTypes = DEFAULT_CONTENT_TYPES,
  rootRelationships = DEFAULT_ROOT_RELATIONSHIPS,
  extraEntries = [],
} = {}) {
  return createZip([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rootRelationships },
    { name: "word/document.xml", data: documentXml },
    ...extraEntries,
  ]);
}

export function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const rawData = toBytes(entry.data ?? "");
    const method = entry.compressionMethod ?? 8;
    const compressedData = method === 8 ? new Uint8Array(deflateRawSync(rawData)) : rawData;
    const crc = crc32(rawData);
    const uncompressedSize = entry.declaredUncompressedSize ?? rawData.byteLength;
    const compressedSize = entry.declaredCompressedSize ?? compressedData.byteLength;
    const flags = entry.flags ?? 0x0800;
    const externalAttributes = entry.externalAttributes ?? 0;

    const local = new Uint8Array(30 + name.byteLength + compressedData.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, flags, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, compressedSize, true);
    localView.setUint32(22, uncompressedSize, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    local.set(compressedData, 30 + name.byteLength);
    localParts.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, flags, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, compressedSize, true);
    centralView.setUint32(24, uncompressedSize, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(38, externalAttributes, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.byteLength;
  }

  const centralDirectorySize = centralParts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(offset + centralDirectorySize + 22);
  let cursor = 0;
  for (const part of localParts) {
    output.set(part, cursor);
    cursor += part.byteLength;
  }
  for (const part of centralParts) {
    output.set(part, cursor);
    cursor += part.byteLength;
  }
  const eocd = new DataView(output.buffer, cursor, 22);
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralDirectorySize, true);
  eocd.setUint32(16, offset, true);
  return output;
}

function toBytes(data) {
  return typeof data === "string" ? encoder.encode(data) : new Uint8Array(data);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
