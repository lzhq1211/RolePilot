import type { CleanupFailureCode, CleanupStatusDto } from "web-contracts";

export type CleanupTarget = { kind: "run" | "source" | "export"; id: string };
export type CleanupObject = { bucket: "sources" | "artifacts" | "exports"; key: string };

export interface CleanupRepository {
  status(): Promise<CleanupStatusDto>;
  beginClear(): Promise<void>;
  finishClear(): Promise<void>;
  pending(limit: number): Promise<CleanupTarget[]>;
  objects(target: CleanupTarget): Promise<CleanupObject[]>;
  finish(target: CleanupTarget): Promise<void>;
  fail(target: CleanupTarget, code: CleanupFailureCode): Promise<void>;
  retry(): Promise<void>;
  scan(at: string, errorCode: CleanupFailureCode | null): Promise<void>;
  expire(at: string): Promise<void>;
  hasActiveExecution(): Promise<boolean>;
  canRemoveDirectory(runId: string): Promise<boolean>;
  canSweepObject(object: CleanupObject): Promise<boolean>;
  finishSweptObject(object: CleanupObject): Promise<void>;
}
