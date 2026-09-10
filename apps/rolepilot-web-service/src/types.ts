import type { ParsedDocument } from "document-ingest";
import type {
  ResumeSourceMediaType,
  ResumeSourceStatus,
  SourceError,
} from "web-contracts";

export type SourceInputKind = "file" | "pasted-text";

export type SourceRecord = {
  id: string;
  deploymentInstanceId: string;
  status: ResumeSourceStatus;
  inputKind: SourceInputKind;
  originalFileName: string | null;
  mediaType: ResumeSourceMediaType;
  sizeBytes: number;
  textLength: number | null;
  pageCount: number | null;
  parserVersion: string | null;
  error: SourceError | null;
  originalObjectKey: string | null;
  extractedTextObjectKey: string | null;
  cleanupRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type CreateSourceRecord = Pick<
  SourceRecord,
  "id" | "inputKind" | "originalFileName" | "mediaType" | "sizeBytes"
> & {
  deploymentInstanceId?: string;
};

export type ReadySourceRecord = {
  parsed: ParsedDocument;
  originalObjectKey: string;
  extractedTextObjectKey: string;
};

export type DeleteSourceResult =
  | { kind: "deleted"; source: SourceRecord }
  | { kind: "pending-cleanup"; source: SourceRecord };

export type SourceObject = {
  key: string;
  bytes: Uint8Array;
  contentType: string;
};

export type IdempotencyResultKind = "source" | "run" | "evidence" | "export";

export type IdempotencyRecord = {
  deploymentInstanceId?: string;
  requestFingerprint: string;
  resultKind: IdempotencyResultKind;
  resultId: string;
  sourceId: string | null;
  expiresAt: string;
};
