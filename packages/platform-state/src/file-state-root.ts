import fs from "node:fs";
import path from "node:path";

import type { FileStateRoot, FileStateRootOptions } from "./types.js";

function assertNonEmptyString(value: string, label: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value.trim();
}

function assertSimpleSegment(value: string, label: string) {
  const normalized = assertNonEmptyString(value, label);
  if (!/^[a-zA-Z0-9._-]+$/.test(normalized)) {
    throw new Error(
      `${label} must contain only letters, numbers, dots, underscores, or dashes.`,
    );
  }

  return normalized;
}

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseJsonObject(text: string, label: string) {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} contains invalid JSON: ${reason}`);
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`${label} must contain a JSON object.`);
  }

  return parsed;
}

export function createFileStateRoot(
  options: FileStateRootOptions,
): FileStateRoot {
  const rootDir = assertNonEmptyString(options.rootDir, "rootDir");
  const stateDirName = assertSimpleSegment(
    options.stateDirName ?? ".state",
    "stateDirName",
  );
  const stateDir = path.join(rootDir, stateDirName);
  const checkpointsDir = path.join(stateDir, "checkpoints");
  const memoryDir = path.join(stateDir, "memory");

  fs.mkdirSync(checkpointsDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });

  return {
    rootDir,
    stateDir,
    checkpointsDir,
    memoryDir,
    resolveCheckpointPath(runId, threadId) {
      const safeRunId = assertSimpleSegment(runId, "runId");
      const safeThreadId = assertSimpleSegment(threadId, "threadId");
      return path.join(checkpointsDir, safeRunId, `${safeThreadId}.json`);
    },
    resolveMemoryPath(namespace) {
      const safeNamespace = assertSimpleSegment(namespace, "namespace");
      return path.join(memoryDir, `${safeNamespace}.json`);
    },
    readJsonFile(filePath) {
      if (!fs.existsSync(filePath)) {
        return null;
      }

      return parseJsonObject(fs.readFileSync(filePath, "utf8"), filePath);
    },
    writeJsonFile(filePath, value) {
      ensureParentDir(filePath);
      fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
    },
    deleteFile(filePath) {
      if (!fs.existsSync(filePath)) {
        return false;
      }
      fs.unlinkSync(filePath);
      return true;
    },
  };
}

export function createDefaultFileStateRoot(rootDir: string) {
  return createFileStateRoot({ rootDir });
}
