import { SourceRepositoryError } from "./errors.js";
import type { SourceObject } from "./types.js";

export interface SourceObjectStore {
  put(object: SourceObject): Promise<void>;
  read(key: string): Promise<Uint8Array>;
  remove(keys: readonly string[]): Promise<void>;
}

export type StoredObjectInfo = { key: string; createdAt: string };
export interface ListableSourceObjectStore extends SourceObjectStore {
  list(prefix: string): Promise<StoredObjectInfo[]>;
}

export class InMemorySourceObjectStore implements SourceObjectStore {
  readonly #objects = new Map<string, SourceObject>();

  async put(object: SourceObject): Promise<void> {
    this.#objects.set(object.key, {
      ...object,
      bytes: new Uint8Array(object.bytes),
    });
  }

  async read(key: string): Promise<Uint8Array> {
    const object = this.#objects.get(key);
    if (!object) {
      throw new SourceRepositoryError();
    }
    return new Uint8Array(object.bytes);
  }

  async remove(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      this.#objects.delete(key);
    }
  }

  has(key: string): boolean {
    return this.#objects.has(key);
  }

  count(): number {
    return this.#objects.size;
  }
}
