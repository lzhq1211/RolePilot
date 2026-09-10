export type RuntimeCheckpointSnapshot = {
  schemaVersion: string;
  [key: string]: unknown;
};

export type CheckpointRecord<
  TSnapshot extends RuntimeCheckpointSnapshot = RuntimeCheckpointSnapshot,
> = {
  schemaVersion: "v1";
  checkpointId: string;
  runId: string;
  threadId: string;
  planFingerprint: string;
  createdAt: string;
  snapshot: TSnapshot;
};

export type SaveCheckpointInput<
  TSnapshot extends RuntimeCheckpointSnapshot = RuntimeCheckpointSnapshot,
> = {
  checkpointId: string;
  runId: string;
  threadId: string;
  planFingerprint: string;
  createdAt?: string;
  snapshot: TSnapshot;
};

export type ResumeCheckpointInput = {
  runId: string;
  threadId: string;
  planFingerprint: string;
  expectedCheckpointId?: string;
};

export interface CheckpointStore {
  save<TSnapshot extends RuntimeCheckpointSnapshot>(
    input: SaveCheckpointInput<TSnapshot>,
  ): CheckpointRecord<TSnapshot>;
  readLatest<TSnapshot extends RuntimeCheckpointSnapshot>(input: {
    runId: string;
    threadId: string;
  }): CheckpointRecord<TSnapshot> | null;
  resume<TSnapshot extends RuntimeCheckpointSnapshot>(
    input: ResumeCheckpointInput,
  ): CheckpointRecord<TSnapshot>;
}

export type DurableMemoryRecord<TValue = unknown> = {
  schemaVersion: "v1";
  namespace: string;
  updatedAt: string;
  value: TValue;
};

export interface DurableMemoryStore {
  put<TValue>(namespace: string, value: TValue): DurableMemoryRecord<TValue>;
  get<TValue>(namespace: string): DurableMemoryRecord<TValue> | null;
  delete(namespace: string): boolean;
}

export type FileStateRootOptions = {
  rootDir: string;
  stateDirName?: string;
};

export type FileStateRoot = {
  rootDir: string;
  stateDir: string;
  checkpointsDir: string;
  memoryDir: string;
  resolveCheckpointPath(runId: string, threadId: string): string;
  resolveMemoryPath(namespace: string): string;
  readJsonFile(filePath: string): unknown | null;
  writeJsonFile(filePath: string, value: unknown): void;
  deleteFile(filePath: string): boolean;
};
