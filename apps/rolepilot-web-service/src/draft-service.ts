import { randomUUID } from "node:crypto";

import {
  normalizeInputDraft,
  validateInputDraft,
  type InputDraftDto,
  type InputDraftInput,
} from "web-contracts";

import { DraftApiError } from "./errors.js";
import type { DraftRepository, DraftUpdateResult } from "./draft-repository.js";
import { DEFAULT_DEPLOYMENT_INSTANCE_ID } from "./deployment.js";

export class DraftService {
  readonly #repository: DraftRepository;
  readonly #idFactory: () => string;
  readonly #deploymentInstanceId: string;

  constructor({
    repository,
    idFactory = randomUUID,
    deploymentInstanceId = DEFAULT_DEPLOYMENT_INSTANCE_ID,
  }: {
    repository: DraftRepository;
    idFactory?: () => string;
    deploymentInstanceId?: string;
  }) {
    this.#repository = repository;
    this.#idFactory = idFactory;
    this.#deploymentInstanceId = deploymentInstanceId;
  }

  async create(input: InputDraftInput): Promise<InputDraftDto> {
    const normalized = this.#validateAndNormalize(input);
    return this.#repository.create({ id: this.#idFactory(), deploymentInstanceId: this.#deploymentInstanceId, ...normalized });
  }

  async get(draftId: string): Promise<InputDraftDto | null> {
    return this.#repository.get(draftId);
  }

  async update(
    draftId: string,
    expectedRevision: number,
    input: InputDraftInput,
  ): Promise<DraftUpdateResult> {
    const normalized = this.#validateAndNormalize(input);
    return this.#repository.update(draftId, expectedRevision, normalized);
  }

  #validateAndNormalize(input: InputDraftInput): InputDraftInput {
    const normalized = normalizeInputDraft(input);
    const fieldErrors = validateInputDraft(normalized);
    if (fieldErrors.length > 0) {
      throw new DraftApiError({
        code: "REQUEST_INVALID",
        message: "输入内容无效。",
        status: 400,
        fieldErrors,
      });
    }
    return normalized;
  }
}
