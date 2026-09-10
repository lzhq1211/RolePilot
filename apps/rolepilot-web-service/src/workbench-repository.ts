import type { WorkbenchDocumentContent, WorkbenchDocumentVariant } from "web-contracts";

import { DEFAULT_DEPLOYMENT_INSTANCE_ID } from "./deployment.js";
import type { RunRepository } from "./run-repository.js";

export type WorkbenchDocumentRecord = {
  documentId: string;
  runId: string;
  deploymentInstanceId: string;
  variant: WorkbenchDocumentVariant;
  content: WorkbenchDocumentContent;
  revision: number;
  updatedAt: string;
};

export type WorkbenchDocumentsResult =
  | { kind: "active"; documents: WorkbenchDocumentRecord[] }
  | { kind: "not-found" };

export type SaveWorkbenchDocumentInput = {
  runId: string;
  documentId: string;
  variant: WorkbenchDocumentVariant;
  content: WorkbenchDocumentContent;
  expectedRevision: number;
};

export type SaveWorkbenchDocumentResult =
  | { kind: "saved"; document: WorkbenchDocumentRecord }
  | { kind: "conflict" }
  | { kind: "not-found" };

export interface WorkbenchRepository {
  list(runId: string): Promise<WorkbenchDocumentsResult>;
  save(input: SaveWorkbenchDocumentInput): Promise<SaveWorkbenchDocumentResult>;
}

export class InMemoryWorkbenchRepository implements WorkbenchRepository {
  readonly #runs: RunRepository;
  readonly #records: Map<string, WorkbenchDocumentRecord>;
  readonly #runVariants: Map<string, string>;
  readonly #clock: () => string;
  readonly #deploymentInstanceId: string;

  constructor({
    runs,
    clock = () => new Date().toISOString(),
    deploymentInstanceId = DEFAULT_DEPLOYMENT_INSTANCE_ID,
    records = new Map<string, WorkbenchDocumentRecord>(),
    runVariants = new Map<string, string>(),
  }: {
    runs: RunRepository;
    clock?: () => string;
    deploymentInstanceId?: string;
    records?: Map<string, WorkbenchDocumentRecord>;
    runVariants?: Map<string, string>;
  }) {
    this.#runs = runs;
    this.#clock = clock;
    this.#deploymentInstanceId = deploymentInstanceId;
    this.#records = records;
    this.#runVariants = runVariants;
  }

  async list(runId: string): Promise<WorkbenchDocumentsResult> {
    const run = await this.#runs.get(runId);
    if (!run || run.deploymentInstanceId !== this.#deploymentInstanceId) return { kind: "not-found" };
    const documents = Array.from(this.#records.values()).filter(
      (record) => record.runId === runId && record.deploymentInstanceId === this.#deploymentInstanceId,
    );
    return { kind: "active", documents: structuredClone(documents) };
  }

  async save(input: SaveWorkbenchDocumentInput): Promise<SaveWorkbenchDocumentResult> {
    const run = await this.#runs.get(input.runId);
    if (!run || run.deploymentInstanceId !== this.#deploymentInstanceId || run.status !== "COMPLETED") {
      return { kind: "not-found" };
    }

    const current = this.#records.get(input.documentId);
    if (current && (current.runId !== input.runId || current.variant !== input.variant
      || current.deploymentInstanceId !== this.#deploymentInstanceId)) {
      return { kind: "not-found" };
    }
    const variantKey = `${this.#deploymentInstanceId}:${input.runId}:${input.variant}`;
    const variantDocumentId = this.#runVariants.get(variantKey);
    if (variantDocumentId && variantDocumentId !== input.documentId) return { kind: "not-found" };
    if ((current?.revision ?? 0) !== input.expectedRevision) return { kind: "conflict" };

    const document: WorkbenchDocumentRecord = {
      documentId: input.documentId,
      runId: input.runId,
      deploymentInstanceId: this.#deploymentInstanceId,
      variant: input.variant,
      content: structuredClone(input.content),
      revision: input.expectedRevision + 1,
      updatedAt: this.#clock(),
    };
    this.#records.set(document.documentId, document);
    this.#runVariants.set(variantKey, document.documentId);
    return { kind: "saved", document: structuredClone(document) };
  }
}
