import { readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { RunRepository } from "./run-repository.js";
import type { SourceObjectStore } from "./source-object-store.js";
import type { RunArtifactRecord } from "./run-types.js";

export const DIAGNOSTIC_JOURNAL = ".diagnostic-publication.json";
export type DiagnosticJournal = {
  runId: string;
  deploymentInstanceId: string;
  errorCode: "DIAGNOSTIC_PUBLICATION_FAILED" | null;
  attempts: number;
  metadataComplete: boolean;
  artifacts: RunArtifactRecord[];
};

export async function writeDiagnosticJournal(root: string, journal: DiagnosticJournal) {
  const file = path.join(root, DIAGNOSTIC_JOURNAL);
  await writeFile(`${file}.tmp`, JSON.stringify(journal), "utf8");
  await rename(`${file}.tmp`, file);
}

export async function publishArtifactBytes(repository: RunRepository, store: SourceObjectStore, record: RunArtifactRecord, bytes: Uint8Array, at: string) {
  await store.put({ key: record.storageObjectKey, bytes, contentType: record.mimeType });
  await repository.updateArtifactStatus(record.id, "PUBLISHED", at);
}

export async function retryRunDiagnostics(root: string, runId: string, instance: string, repository: RunRepository, store: SourceObjectStore): Promise<boolean> {
  let journal: DiagnosticJournal;
  try { journal = JSON.parse(await readFile(path.join(root, DIAGNOSTIC_JOURNAL), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
  if (journal.runId !== runId || journal.deploymentInstanceId !== instance || !Array.isArray(journal.artifacts)) throw new Error("Invalid diagnostic journal ownership.");
  const run = await repository.get(runId, { includeDeleted: true });
  if (!run || run.deletedAt) return true;
  journal.attempts += 1;
  try {
    if (!journal.metadataComplete) throw new Error("Diagnostic metadata registration requires recovery before local cleanup.");
    for (const entry of journal.artifacts) {
      const record = await repository.getArtifact(entry.id);
      if (!record || record.runId !== runId || record.deploymentInstanceId !== instance || record.role !== "supporting") throw new Error("Invalid diagnostic artifact ownership.");
      if (record.status === "PUBLISHED") continue;
      if (record.status !== "STAGED") throw new Error("Diagnostic artifact is no longer staged.");
      const absolute = path.resolve(root, record.relativePath);
      if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("Diagnostic path escapes run workspace.");
      await publishArtifactBytes(repository, store, record, new Uint8Array(await readFile(absolute)), new Date().toISOString());
    }
    await rm(path.join(root, DIAGNOSTIC_JOURNAL), { force: true });
    return true;
  } catch {
    journal.errorCode = "DIAGNOSTIC_PUBLICATION_FAILED";
    await writeDiagnosticJournal(root, journal);
    process.stderr.write(`[RolePilot] run ${runId}: DIAGNOSTIC_PUBLICATION_FAILED (attempt ${journal.attempts})\n`);
    return false;
  }
}
