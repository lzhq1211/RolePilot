import {
  CheckpointNotFoundError,
  CheckpointTargetMismatchError,
  PlanFingerprintMismatchError,
  StaleCheckpointError,
  UnsupportedCheckpointSchemaError,
} from "./errors.js";
import { createFileStateRoot } from "./file-state-root.js";
import type {
  CheckpointRecord,
  CheckpointStore,
  FileStateRoot,
  FileStateRootOptions,
  ResumeCheckpointInput,
  RuntimeCheckpointSnapshot,
  SaveCheckpointInput,
} from "./types.js";

function createRecord<TSnapshot extends RuntimeCheckpointSnapshot>(
  input: SaveCheckpointInput<TSnapshot>,
): CheckpointRecord<TSnapshot> {
  return {
    schemaVersion: "v1",
    checkpointId: input.checkpointId,
    runId: input.runId,
    threadId: input.threadId,
    planFingerprint: input.planFingerprint,
    createdAt: input.createdAt ?? new Date().toISOString(),
    snapshot: assertCheckpointSnapshotShape(input.snapshot),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertStringArray(value: unknown, label: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new UnsupportedCheckpointSchemaError(
      `${label} must be an array of strings.`,
    );
  }
}

function assertCheckpointSnapshotShape<
  TSnapshot extends RuntimeCheckpointSnapshot,
>(value: unknown): TSnapshot {
  if (!isPlainObject(value)) {
    throw new UnsupportedCheckpointSchemaError(
      "Checkpoint snapshot must be an object.",
    );
  }

  if (Reflect.get(value, "schemaVersion") !== "v1") {
    throw new UnsupportedCheckpointSchemaError(
      `Unsupported checkpoint snapshot schema: ${String(
        Reflect.get(value, "schemaVersion"),
      )}.`,
    );
  }

  const graph = Reflect.get(value, "graph");
  if (!isPlainObject(graph)) {
    throw new UnsupportedCheckpointSchemaError(
      "Checkpoint snapshot graph must be an object.",
    );
  }

  const tasks = Reflect.get(graph, "tasks");
  if (!isPlainObject(tasks)) {
    throw new UnsupportedCheckpointSchemaError(
      "Checkpoint snapshot graph.tasks must be an object.",
    );
  }

  assertStringArray(
    Reflect.get(graph, "taskOrder"),
    "Checkpoint snapshot graph.taskOrder",
  );

  const events = Reflect.get(value, "events");
  if (!Array.isArray(events)) {
    throw new UnsupportedCheckpointSchemaError(
      "Checkpoint snapshot events must be an array.",
    );
  }

  const stopReason = Reflect.get(value, "stopReason");
  if (stopReason !== null && typeof stopReason !== "string") {
    throw new UnsupportedCheckpointSchemaError(
      "Checkpoint snapshot stopReason must be a string or null.",
    );
  }

  const nextSequence = Reflect.get(value, "nextSequence");
  if (
    typeof nextSequence !== "number" ||
    !Number.isInteger(nextSequence) ||
    nextSequence < 1
  ) {
    throw new UnsupportedCheckpointSchemaError(
      "Checkpoint snapshot nextSequence must be a positive integer.",
    );
  }

  const manifest = Reflect.get(value, "manifest");
  if (!isPlainObject(manifest)) {
    throw new UnsupportedCheckpointSchemaError(
      "Checkpoint snapshot manifest must be an object.",
    );
  }

  if (Reflect.get(manifest, "schemaVersion") !== "v1") {
    throw new UnsupportedCheckpointSchemaError(
      "Checkpoint snapshot manifest schemaVersion must be v1.",
    );
  }

  assertStringArray(
    Reflect.get(manifest, "taskOrder"),
    "Checkpoint snapshot manifest.taskOrder",
  );
  assertStringArray(
    Reflect.get(manifest, "completedTaskIds"),
    "Checkpoint snapshot manifest.completedTaskIds",
  );
  assertStringArray(
    Reflect.get(manifest, "failedTaskIds"),
    "Checkpoint snapshot manifest.failedTaskIds",
  );

  const manifestStopReason = Reflect.get(manifest, "stopReason");
  if (manifestStopReason !== null && typeof manifestStopReason !== "string") {
    throw new UnsupportedCheckpointSchemaError(
      "Checkpoint snapshot manifest.stopReason must be a string or null.",
    );
  }

  const eventCount = Reflect.get(manifest, "eventCount");
  if (
    typeof eventCount !== "number" ||
    !Number.isInteger(eventCount) ||
    eventCount < 0
  ) {
    throw new UnsupportedCheckpointSchemaError(
      "Checkpoint snapshot manifest.eventCount must be a non-negative integer.",
    );
  }

  return value as TSnapshot;
}

function assertRecordShape<TSnapshot extends RuntimeCheckpointSnapshot>(
  value: unknown,
): CheckpointRecord<TSnapshot> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UnsupportedCheckpointSchemaError(
      "Checkpoint record must be an object.",
    );
  }

  const schemaVersion = Reflect.get(value, "schemaVersion");
  if (schemaVersion !== "v1") {
    throw new UnsupportedCheckpointSchemaError(
      `Unsupported checkpoint record schema: ${String(schemaVersion)}.`,
    );
  }

  const snapshotValue = Reflect.get(value, "snapshot");
  if (
    !snapshotValue ||
    typeof snapshotValue !== "object" ||
    Array.isArray(snapshotValue)
  ) {
    throw new UnsupportedCheckpointSchemaError(
      "Checkpoint record is missing required metadata.",
    );
  }

  const snapshotSchemaVersion = Reflect.get(snapshotValue, "schemaVersion");
  if (snapshotSchemaVersion !== "v1") {
    throw new UnsupportedCheckpointSchemaError(
      `Unsupported checkpoint snapshot schema: ${String(snapshotSchemaVersion)}.`,
    );
  }

  const checkpointId = Reflect.get(value, "checkpointId");
  const runId = Reflect.get(value, "runId");
  const threadId = Reflect.get(value, "threadId");
  const planFingerprint = Reflect.get(value, "planFingerprint");
  const createdAt = Reflect.get(value, "createdAt");

  if (
    typeof checkpointId !== "string" ||
    typeof runId !== "string" ||
    typeof threadId !== "string" ||
    typeof planFingerprint !== "string" ||
    typeof createdAt !== "string"
  ) {
    throw new UnsupportedCheckpointSchemaError(
      "Checkpoint record is missing required metadata.",
    );
  }

  return {
    schemaVersion,
    checkpointId,
    runId,
    threadId,
    planFingerprint,
    createdAt,
    snapshot: assertCheckpointSnapshotShape<TSnapshot>(snapshotValue),
  };
}

function resolveRoot(options?: FileStateRootOptions | { root: FileStateRoot }) {
  if (options && "root" in options) {
    return options.root;
  }

  return createFileStateRoot(options ?? { rootDir: process.cwd() });
}

export function createCheckpointStore(
  options?: FileStateRootOptions | { root: FileStateRoot },
): CheckpointStore {
  const root = resolveRoot(options);

  function readRecord<TSnapshot extends RuntimeCheckpointSnapshot>(input: {
    runId: string;
    threadId: string;
  }) {
    const filePath = root.resolveCheckpointPath(input.runId, input.threadId);
    const value = root.readJsonFile(filePath);
    if (!value) {
      return null;
    }
    return assertRecordShape<TSnapshot>(value);
  }

  function resume<TSnapshot extends RuntimeCheckpointSnapshot>(
    input: ResumeCheckpointInput,
  ) {
    const record = readRecord<TSnapshot>(input);
    if (!record) {
      throw new CheckpointNotFoundError(
        `No checkpoint found for run "${input.runId}" and thread "${input.threadId}".`,
      );
    }

    if (record.runId !== input.runId || record.threadId !== input.threadId) {
      throw new CheckpointTargetMismatchError(
        `Checkpoint target mismatch for run "${input.runId}" and thread "${input.threadId}".`,
      );
    }

    if (
      input.expectedCheckpointId &&
      record.checkpointId !== input.expectedCheckpointId
    ) {
      throw new StaleCheckpointError(
        `Stale checkpoint: expected "${input.expectedCheckpointId}" but found "${record.checkpointId}".`,
      );
    }

    if (record.planFingerprint !== input.planFingerprint) {
      throw new PlanFingerprintMismatchError(
        `Checkpoint plan fingerprint mismatch: expected "${input.planFingerprint}" but found "${record.planFingerprint}".`,
      );
    }

    return record;
  }

  return {
    save<TSnapshot extends RuntimeCheckpointSnapshot>(
      input: SaveCheckpointInput<TSnapshot>,
    ) {
      const record = createRecord(input);
      const filePath = root.resolveCheckpointPath(
        record.runId,
        record.threadId,
      );
      root.writeJsonFile(filePath, record);
      return record;
    },
    readLatest<TSnapshot extends RuntimeCheckpointSnapshot>(input: {
      runId: string;
      threadId: string;
    }) {
      return readRecord<TSnapshot>(input);
    },
    resume,
  };
}
