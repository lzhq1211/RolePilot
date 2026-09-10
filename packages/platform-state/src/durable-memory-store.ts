import { createFileStateRoot } from "./file-state-root.js";
import type {
  DurableMemoryRecord,
  FileStateRoot,
  FileStateRootOptions,
} from "./types.js";

type DurableMemoryValueValidator<TValue> = (value: unknown) => value is TValue;

function resolveRoot(options?: FileStateRootOptions | { root: FileStateRoot }) {
  if (options && "root" in options) {
    return options.root;
  }

  return createFileStateRoot(options ?? { rootDir: process.cwd() });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertMemoryRecord(value: unknown): DurableMemoryRecord<unknown> {
  if (!isPlainObject(value)) {
    throw new Error("Durable memory record must be an object.");
  }

  const schemaVersion = Reflect.get(value, "schemaVersion");
  if (schemaVersion !== "v1") {
    throw new Error(
      `Unsupported durable memory schema: ${String(schemaVersion)}.`,
    );
  }
  const namespace = Reflect.get(value, "namespace");
  const updatedAt = Reflect.get(value, "updatedAt");
  if (typeof namespace !== "string" || typeof updatedAt !== "string") {
    throw new Error("Durable memory record is missing required metadata.");
  }

  return {
    schemaVersion: "v1",
    namespace,
    updatedAt,
    value: Reflect.get(value, "value"),
  };
}

export function createDurableMemoryStore(
  options?: FileStateRootOptions | { root: FileStateRoot },
) {
  const root = resolveRoot(options);

  function get(namespace: string): DurableMemoryRecord<unknown> | null;
  function get<TValue>(
    namespace: string,
    validator: DurableMemoryValueValidator<TValue>,
  ): DurableMemoryRecord<TValue> | null;
  function get<TValue>(
    namespace: string,
    validator?: DurableMemoryValueValidator<TValue>,
  ): DurableMemoryRecord<unknown> | DurableMemoryRecord<TValue> | null {
    const filePath = root.resolveMemoryPath(namespace);
    const value = root.readJsonFile(filePath);
    if (!value) {
      return null;
    }

    const record = assertMemoryRecord(value);
    if (!validator) {
      return record;
    }

    if (!validator(record.value)) {
      throw new Error(
        `Durable memory value for namespace \"${namespace}\" failed validation.`,
      );
    }

    return {
      ...record,
      value: record.value,
    };
  }

  return {
    put<TValue>(namespace: string, value: TValue) {
      const record: DurableMemoryRecord<TValue> = {
        schemaVersion: "v1",
        namespace,
        updatedAt: new Date().toISOString(),
        value,
      };
      const filePath = root.resolveMemoryPath(namespace);
      root.writeJsonFile(filePath, record);
      return record;
    },
    get,
    delete(namespace: string) {
      const filePath = root.resolveMemoryPath(namespace);
      return root.deleteFile(filePath);
    },
  };
}
