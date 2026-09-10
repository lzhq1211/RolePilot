import { parseResumeContentV3, type WorkbenchDocumentVariant } from "web-contracts";

import { DEFAULT_DEPLOYMENT_INSTANCE_ID } from "./deployment.js";
import { SupabaseRestClient } from "./supabase.js";
import type {
  SaveWorkbenchDocumentInput,
  SaveWorkbenchDocumentResult,
  WorkbenchDocumentRecord,
  WorkbenchDocumentsResult,
  WorkbenchRepository,
} from "./workbench-repository.js";

type WorkbenchDocumentValue = {
  documentId: unknown;
  runId: unknown;
  deploymentInstanceId: unknown;
  variant: unknown;
  content: unknown;
  revision: unknown;
  updatedAt: unknown;
};

type SaveResultValue = {
  kind?: unknown;
  document?: unknown;
};

export class SupabaseWorkbenchRepository implements WorkbenchRepository {
  readonly #client: SupabaseRestClient;
  readonly #deploymentInstanceId: string;

  constructor({
    client,
    deploymentInstanceId = DEFAULT_DEPLOYMENT_INSTANCE_ID,
  }: {
    client: SupabaseRestClient;
    deploymentInstanceId?: string;
  }) {
    this.#client = client;
    this.#deploymentInstanceId = deploymentInstanceId;
  }

  async list(runId: string): Promise<WorkbenchDocumentsResult> {
    const value = await this.#client.rpc<unknown>("rolepilot_read_workbench_documents", {
      p_run_id: runId,
      p_deployment_instance_id: this.#deploymentInstanceId,
    });
    if (value === null) return { kind: "not-found" };
    if (!Array.isArray(value)) throw new TypeError("Workbench document list is invalid.");
    return { kind: "active", documents: value.map(readDocument) };
  }

  async save(input: SaveWorkbenchDocumentInput): Promise<SaveWorkbenchDocumentResult> {
    const value = await this.#client.rpc<SaveResultValue>("rolepilot_save_workbench_document", {
      p_run_id: input.runId,
      p_deployment_instance_id: this.#deploymentInstanceId,
      p_document_id: input.documentId,
      p_variant: input.variant,
      p_content: input.content,
      p_expected_revision: input.expectedRevision,
    });
    if (value?.kind === "not-found") return { kind: "not-found" };
    if (value?.kind === "conflict") return { kind: "conflict" };
    if (value?.kind === "saved") return { kind: "saved", document: readDocument(value.document) };
    throw new TypeError("Workbench save result is invalid.");
  }
}

function readDocument(value: unknown): WorkbenchDocumentRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Workbench document is invalid.");
  }
  const row = value as WorkbenchDocumentValue;
  if (typeof row.documentId !== "string" || typeof row.runId !== "string"
    || typeof row.deploymentInstanceId !== "string" || !isVariant(row.variant)
    || !Number.isSafeInteger(row.revision) || (row.revision as number) < 1
    || typeof row.updatedAt !== "string") {
    throw new TypeError("Workbench document fields are invalid.");
  }
  const content = parseResumeContentV3(row.content);
  if (content.documentId !== row.documentId) throw new TypeError("Workbench document identity is invalid.");
  return {
    documentId: row.documentId,
    runId: row.runId,
    deploymentInstanceId: row.deploymentInstanceId,
    variant: row.variant,
    content,
    revision: row.revision as number,
    updatedAt: row.updatedAt,
  };
}

function isVariant(value: unknown): value is WorkbenchDocumentVariant {
  return value === "original" || value === "generated";
}
