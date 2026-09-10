import type { InputDraftDto, InputDraftInput } from "web-contracts";

export type CreateDraftRecord = InputDraftInput & { id: string; deploymentInstanceId?: string };

export type DraftUpdateResult =
  | { kind: "updated"; draft: InputDraftDto }
  | { kind: "conflict"; current: InputDraftDto }
  | { kind: "not-found" };

export interface DraftRepository {
  create(input: CreateDraftRecord): Promise<InputDraftDto>;
  get(draftId: string): Promise<InputDraftDto | null>;
  update(
    draftId: string,
    expectedRevision: number,
    input: InputDraftInput,
  ): Promise<DraftUpdateResult>;
}

export class InMemoryDraftRepository implements DraftRepository {
  readonly #records: Map<string, InputDraftDto>;
  readonly #clock: () => string;

  constructor({ clock = () => new Date().toISOString(), records = new Map<string, InputDraftDto>() }: {
    clock?: () => string; records?: Map<string, InputDraftDto>;
  } = {}) {
    this.#clock = clock;
    this.#records = records;
  }

  async create(input: CreateDraftRecord): Promise<InputDraftDto> {
    if (this.#records.has(input.id)) {
      throw new Error("Draft id already exists.");
    }

    const draft: InputDraftDto = {
      id: input.id,
      resumeSourceId: input.resumeSourceId,
      company: input.company,
      title: input.title,
      jdText: input.jdText,
      revision: 1,
      updatedAt: this.#clock(),
    };
    this.#records.set(draft.id, draft);
    return structuredClone(draft);
  }

  async get(draftId: string): Promise<InputDraftDto | null> {
    const draft = this.#records.get(draftId);
    return draft ? structuredClone(draft) : null;
  }

  async update(
    draftId: string,
    expectedRevision: number,
    input: InputDraftInput,
  ): Promise<DraftUpdateResult> {
    const current = this.#records.get(draftId);
    if (!current) {
      return { kind: "not-found" };
    }
    if (current.revision !== expectedRevision) {
      return { kind: "conflict", current: structuredClone(current) };
    }

    const updated: InputDraftDto = {
      ...current,
      ...input,
      revision: current.revision + 1,
      updatedAt: this.#clock(),
    };
    this.#records.set(draftId, updated);
    return { kind: "updated", draft: structuredClone(updated) };
  }
}
