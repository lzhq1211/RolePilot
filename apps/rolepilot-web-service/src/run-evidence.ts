import { randomUUID, createHash } from "node:crypto";
import { validateRunEvidenceInput } from "web-contracts";
import type { RunEventHub } from "./run-events.js";
import type { RunRepository } from "./run-repository.js";
import type { RunService } from "./run-service.js";
import type { SourceObjectStore } from "./source-object-store.js";
import { DEFAULT_DEPLOYMENT_INSTANCE_ID, instanceObjectKey } from "./deployment.js";

export interface RunEvidenceObjectStore { put(key: string, text: string): Promise<void>; read(key: string): Promise<string>; remove?(key: string): Promise<void>; }
export class InMemoryRunEvidenceObjectStore implements RunEvidenceObjectStore {
  readonly #objects = new Map<string, string>();
  async put(key: string, text: string) { this.#objects.set(key, text); }
  async read(key: string) { const value = this.#objects.get(key); if (value === undefined) throw new Error("EVIDENCE_NOT_FOUND"); return value; }
  async remove(key: string) { this.#objects.delete(key); }
}

export function createTextEvidenceObjectStore(objectStore: SourceObjectStore): RunEvidenceObjectStore {
  return {
    async put(key, text) {
      await objectStore.put({ key, bytes: new TextEncoder().encode(text), contentType: "text/plain; charset=utf-8" });
    },
    async read(key) {
      return new TextDecoder("utf-8", { fatal: true }).decode(await objectStore.read(key));
    },
    async remove(key) {
      await objectStore.remove([key]);
    },
  };
}

export async function submitRunEvidence({ runService, runRepository, objectStore, runId, evidenceText, eventHub, idFactory = randomUUID, now = () => new Date(), deploymentInstanceId = DEFAULT_DEPLOYMENT_INSTANCE_ID }: { runService: RunService; runRepository: RunRepository; objectStore: RunEvidenceObjectStore; runId: string; evidenceText: string; eventHub?: RunEventHub; idFactory?: () => string; now?: () => Date; deploymentInstanceId?: string }) {
  const validation = validateRunEvidenceInput({ evidenceText });
  if (!validation.valid) throw new Error("REQUEST_INVALID");
  const run = await runService.get(runId);
  if (!run) return null;
  if (run.status !== "NEEDS_USER_INPUT" || run.pendingUserQuestions.length === 0) throw new Error("RUN_NOT_RESUMABLE");
  const id = idFactory();
  const key = `${instanceObjectKey(deploymentInstanceId, "runs", runId, `evidence/${id}.txt`)}`;
  await objectStore.put(key, evidenceText);
  const evidence = await runRepository.createEvidence({ id, runId, deploymentInstanceId, requestFingerprint: createHash("sha256").update(evidenceText).digest("hex"), storageObjectKey: key, byteLength: Buffer.byteLength(evidenceText), characterLength: [...evidenceText].length });
  const current = await runService.get(runId);
  if (!current) throw new Error("RUN_NOT_FOUND");
  const event = { id: idFactory(), runId, sequence: current.lastEventSequence + 1, type: "run.status" as const, payload: { runId, status: "QUEUED" as const, stopReason: null, failureCode: null }, createdAt: now().toISOString() };
  await runRepository.transition({ runId, expectedStatus: "NEEDS_USER_INPUT", nextStatus: "QUEUED", currentStep: current.currentStep, stepStatuses: current.stepStatuses, stopReason: null, failureCode: null, completedAt: null, pendingUserQuestions: [], event });
  eventHub?.publish(event);
  return evidence;
}
