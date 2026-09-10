import { DocumentIngestError } from "./errors.js";

type TxtEncoding = "utf-8" | "utf-16le" | "utf-16be";

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function isPrintableAscii(byte: number): boolean {
  return byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e);
}

function detectBomlessUtf16(bytes: Uint8Array): TxtEncoding | null {
  if (bytes.byteLength < 8 || bytes.byteLength % 2 !== 0) {
    return null;
  }

  const pairCount = Math.min(bytes.byteLength / 2, 512);
  let evenZeros = 0;
  let oddZeros = 0;
  let evenPrintable = 0;
  let oddPrintable = 0;

  for (let index = 0; index < pairCount * 2; index += 2) {
    const even = bytes[index]!;
    const odd = bytes[index + 1]!;
    if (even === 0) {
      evenZeros += 1;
    }
    if (odd === 0) {
      oddZeros += 1;
    }
    if (isPrintableAscii(even)) {
      evenPrintable += 1;
    }
    if (isPrintableAscii(odd)) {
      oddPrintable += 1;
    }
  }

  const hasMostly = (count: number, minimum: number) => count / pairCount >= minimum;
  if (hasMostly(oddZeros, 0.7) && hasMostly(evenPrintable, 0.5)) {
    return "utf-16le";
  }
  if (hasMostly(evenZeros, 0.7) && hasMostly(oddPrintable, 0.5)) {
    return "utf-16be";
  }
  return null;
}

function selectEncoding(bytes: Uint8Array): TxtEncoding {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    return "utf-8";
  }
  if (startsWith(bytes, [0xff, 0xfe])) {
    return "utf-16le";
  }
  if (startsWith(bytes, [0xfe, 0xff])) {
    return "utf-16be";
  }
  return detectBomlessUtf16(bytes) ?? "utf-8";
}

function decode(bytes: Uint8Array, encoding: TxtEncoding): string {
  try {
    return new TextDecoder(encoding, {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
  } catch {
    throw new DocumentIngestError("ENCODING_UNSUPPORTED");
  }
}

export function decodeTxt(bytes: Uint8Array): string {
  const text = decode(bytes, selectEncoding(bytes));
  if (text.includes("\u0000")) {
    throw new DocumentIngestError("ENCODING_UNSUPPORTED");
  }
  return text;
}
