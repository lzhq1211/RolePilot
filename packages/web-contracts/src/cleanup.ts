export type CleanupFailureCode = "CLEANUP_STORAGE_FAILED" | "CLEANUP_METADATA_FAILED" | "CLEANUP_SCAN_FAILED";
export type CleanupStatusDto = {
  maintaining: boolean;
  pending: number;
  failed: number;
  failures: Array<{ kind: "run" | "source" | "export"; id: string; code: CleanupFailureCode }>;
  lastScanAt: string | null;
  errorCode: CleanupFailureCode | null;
};
