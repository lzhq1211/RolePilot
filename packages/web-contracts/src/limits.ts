export const SOURCE_LIMITS = Object.freeze({
  maxFileBytes: 10 * 1024 * 1024,
  maxTextCodePoints: 200_000,
  maxPreviewCodePoints: 12_000,
  maxJdCodePoints: 50_000,
  maxTargetCodePoints: 200,
  draftDebounceMs: 240,
  parserTimeoutMs: 30_000,
  maxDocxEntries: 2_000,
  maxDocxUncompressedBytes: 50 * 1024 * 1024,
  maxDocxPathDepth: 32,
} as const);
