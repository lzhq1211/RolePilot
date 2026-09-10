import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { InputDraftDto, CleanupFailureCode } from "web-contracts";
import { createRunRepositoryState, InMemoryRunRepository } from "./run-repository.js";
import { InMemorySourceRepository, InMemoryIdempotencyStore } from "./source-repository.js";
import { InMemoryDraftRepository } from "./draft-repository.js";
import { InMemoryWorkbenchRepository, type WorkbenchDocumentRecord } from "./workbench-repository.js";
import type { ListableSourceObjectStore, StoredObjectInfo } from "./source-object-store.js";
import type { SourceRecord, IdempotencyRecord, SourceObject } from "./types.js";
import { LocalCleanupRepository } from "./local-cleanup-repository.js";

export async function atomicWrite(file: string, bytes: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}

export class LocalObjectStore implements ListableSourceObjectStore {
  constructor(readonly root: string) {}
  #path(key: string): string {
    if (!key || path.isAbsolute(key) || key.includes("\\") || key.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Invalid local object key.");
    return path.join(this.root, key);
  }
  async put(object: SourceObject): Promise<void> { await atomicWrite(this.#path(object.key), object.bytes); }
  async read(key: string): Promise<Uint8Array> { return readFile(this.#path(key)); }
  async remove(keys: readonly string[]): Promise<void> {
    for (const key of keys) await rm(this.#path(key), { force: true });
  }
  async list(prefix: string): Promise<StoredObjectInfo[]> {
    const result: StoredObjectInfo[] = [];
    const walk = async (directory: string): Promise<void> => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile()) {
          const key = path.relative(this.root, file).split(path.sep).join("/");
          if (key.startsWith(prefix)) result.push({ key, createdAt: (await stat(file)).mtime.toISOString() });
        }
      }
    };
    await walk(this.root);
    return result;
  }
}

export function createLocalState() {
  return {
    ...createRunRepositoryState(),
    sources: new Map<string, SourceRecord>(),
    sourceIdempotency: new Map<string, IdempotencyRecord>(),
    drafts: new Map<string, InputDraftDto>(),
    documents: new Map<string, WorkbenchDocumentRecord>(),
    runVariants: new Map<string, string>(),
    cleanup: new Map<string, { maintaining: boolean; lastScanAt: string | null; errorCode: CleanupFailureCode | null }>([["status", { maintaining: false, lastScanAt: null, errorCode: null }]]),
    cleanupFailures: new Map<string, CleanupFailureCode>(),
  };
}
export type LocalState = ReturnType<typeof createLocalState>;

/** One service process owns this directory. Each repository call commits all metadata together. */
export class LocalMetadata {
  readonly state = createLocalState();
  #tail: Promise<unknown> = Promise.resolve();
  constructor(readonly file: string) {}
  async load(): Promise<void> {
    try { this.#restore(await readFile(this.file, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  #snapshot(): string {
    return JSON.stringify({ schemaVersion: 1, ...Object.fromEntries(Object.entries(this.state).map(([name, values]) => [name, [...values]])) }, null, 2);
  }
  #restore(text: string): void {
    const data = JSON.parse(text);
    if (data.schemaVersion !== 1 || Object.keys(this.state).some((name) => !Array.isArray(data[name]) || data[name].some((entry: unknown) => !Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string"))) throw new Error("Invalid local metadata; refusing to reset stored data.");
    for (const [name, values] of Object.entries(this.state)) {
      values.clear();
      for (const [key, value] of data[name]) values.set(key, value);
    }
  }
  transaction<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#tail.then(async () => {
      const before = this.#snapshot();
      try {
        const result = await operation();
        const after = this.#snapshot();
        if (after !== before) await atomicWrite(this.file, after);
        return result;
      } catch (error) { this.#restore(before); throw error; }
    });
    this.#tail = pending.catch(() => undefined);
    return pending;
  }
  repository<T extends object>(repository: T): T {
    return new Proxy(repository, { get: (target, key) => {
      const value = Reflect.get(target, key);
      return typeof value === "function"
        ? (...args: unknown[]) => this.transaction(() => value.apply(target, args))
        : value;
    } });
  }
}

export async function createLocalInfrastructure(root: string, deploymentInstanceId: string) {
  const metadata = new LocalMetadata(path.join(root, "metadata.json"));
  await metadata.load();
  const state = metadata.state;
  const stores = {
    sources: new LocalObjectStore(path.join(root, "sources")),
    artifacts: new LocalObjectStore(path.join(root, "artifacts")),
    exports: new LocalObjectStore(path.join(root, "exports")),
  };
  // Internal calls use raw repositories to remain inside the caller's transaction.
  const runs = new InMemoryRunRepository({ state });
  const sources = new InMemorySourceRepository({ records: state.sources, objectStore: stores.sources,
    referenceReader: { isReferencedByRun: async (id) => await runs.isReferencedByRun(id) || [...state.drafts.values()].some((draft) => draft.resumeSourceId === id) } });
  const cleanup = new LocalCleanupRepository(state, stores, deploymentInstanceId);
  return {
    metadata, stores, deploymentInstanceId,
    repository: metadata.repository(sources),
    runRepository: metadata.repository(runs),
    draftRepository: metadata.repository(new InMemoryDraftRepository({ records: state.drafts })),
    workbenchRepository: metadata.repository(new InMemoryWorkbenchRepository({ runs, deploymentInstanceId, records: state.documents, runVariants: state.runVariants })),
    idempotencyStore: metadata.repository(new InMemoryIdempotencyStore({ records: state.sourceIdempotency })),
    cleanupRepository: metadata.repository(cleanup),
    objectStore: stores.sources, artifactObjectStore: stores.artifacts, exportObjectStore: stores.exports,
    startupRecoverSources: () => metadata.transaction(async () => {
      for (const source of state.sources.values()) if (!source.deletedAt && ["UPLOADING", "EXTRACTING"].includes(source.status)) {
        await sources.markFailed(source.id, { code: "PARSER_FAILED", message: "文件处理被服务重启中断，请重新上传。", retryable: true });
      }
    }),
  };
}
