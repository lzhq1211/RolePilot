import type { ResumeSourceMediaType } from "web-contracts";

export type ParseInput = {
  bytes: Uint8Array;
  originalFileName: string | null;
  declaredMediaType: string | null;
  signal?: AbortSignal;
};

export type ParsedDocument = {
  mediaType: ResumeSourceMediaType;
  text: string;
  textLength: number;
  pageCount: number | null;
  parserVersion: string;
};

export type DocumentParser = {
  parse(input: ParseInput): Promise<ParsedDocument>;
};
