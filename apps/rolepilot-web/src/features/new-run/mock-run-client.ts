import type { CreateRunInput } from "web-contracts";

export type MockRunResult = Readonly<{
  runId: string;
  input: CreateRunInput;
}>;

export type MockRunRequestOptions = {
  idempotencyKey: string;
  signal?: AbortSignal;
};

export class MockRunClient {
  readonly #runIdFactory: () => string;
  readonly #requests: CreateRunInput[] = [];
  readonly #results = new Map<string, MockRunResult>();

  constructor({ runIdFactory = defaultRunId } = {}) {
    this.#runIdFactory = runIdFactory;
  }

  async create(input: CreateRunInput, { idempotencyKey, signal }: MockRunRequestOptions): Promise<MockRunResult> {
    throwIfAborted(signal);
    assertCreateRunInput(input);
    const key = idempotencyKey.trim();
    if (!key) throw new Error("MockRunClient requires an idempotency key.");

    const existing = this.#results.get(key);
    if (existing) {
      if (!sameInput(existing.input, input)) {
        throw new Error("MockRunClient idempotency key conflicts with a different input.");
      }
      return existing;
    }

    const snapshot = Object.freeze({ ...input });
    const result = Object.freeze({
      runId: `mock-${this.#runIdFactory()}`,
      input: snapshot,
    });
    this.#results.set(key, result);
    this.#requests.push(snapshot);
    return result;
  }

  get requests(): readonly CreateRunInput[] {
    return this.#requests;
  }
}

function assertCreateRunInput(input: CreateRunInput): void {
  if (!input || typeof input !== "object") {
    throw new Error("MockRunClient received an invalid CreateRunInput.");
  }

  const keys = Object.keys(input).sort();
  const expectedKeys = ["company", "jdText", "resumeSourceId", "title"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error("MockRunClient received unexpected CreateRunInput fields.");
  }

  for (const [field, value] of Object.entries(input)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`MockRunClient received an invalid ${field} field.`);
    }
  }
}

function sameInput(left: CreateRunInput, right: CreateRunInput): boolean {
  return (
    left.resumeSourceId === right.resumeSourceId &&
    left.company === right.company &&
    left.title === right.title &&
    left.jdText === right.jdText
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new DOMException("The operation was aborted.", "AbortError");
  throw error;
}

function defaultRunId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
