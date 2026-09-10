import type {
  ApiError,
  ApiErrorResponse,
  InputDraftDto,
  InputDraftInput,
  InputFieldError,
} from "web-contracts";

import { createClientRequestId } from "../resume-source/api";

const DRAFT_COLLECTION_PATH = "/api/input-drafts";

export class InputDraftRequestError extends Error {
  readonly apiError: Pick<ApiError, "code" | "message" | "retryable"> & {
    fieldErrors?: InputFieldError[];
  };

  constructor(
    apiError: Pick<ApiError, "code" | "message" | "retryable"> & {
      fieldErrors?: InputFieldError[];
    },
  ) {
    super(apiError.message);
    this.name = "InputDraftRequestError";
    this.apiError = apiError;
  }
}

export function createInputDraft(
  input: InputDraftInput,
  { signal }: { signal: AbortSignal },
): Promise<InputDraftDto> {
  return requestDraft({
    path: DRAFT_COLLECTION_PATH,
    method: "POST",
    body: input,
    signal,
  });
}

export function getInputDraft(
  draftId: string,
  { signal }: { signal: AbortSignal },
): Promise<InputDraftDto> {
  return requestDraft({
    path: `${DRAFT_COLLECTION_PATH}/${encodeURIComponent(draftId)}`,
    method: "GET",
    signal,
  });
}

export function updateInputDraft(
  draftId: string,
  revision: number,
  input: InputDraftInput,
  { signal }: { signal: AbortSignal },
): Promise<InputDraftDto> {
  return requestDraft({
    path: `${DRAFT_COLLECTION_PATH}/${encodeURIComponent(draftId)}`,
    method: "PUT",
    body: input,
    revision,
    signal,
  });
}

async function requestDraft({
  path,
  method,
  body,
  revision,
  signal,
}: {
  path: string;
  method: "GET" | "POST" | "PUT";
  body?: InputDraftInput;
  revision?: number;
  signal: AbortSignal;
}): Promise<InputDraftDto> {
  const requestId = createClientRequestId();
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      signal,
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...(revision === undefined ? {} : { "If-Match": String(revision) }),
        "X-Request-ID": requestId,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new InputDraftRequestError(networkError());
  }

  const payload = await readJson(response);
  if (!response.ok) {
    throw new InputDraftRequestError(readApiError(payload));
  }
  if (!isInputDraftDto(payload)) {
    throw new InputDraftRequestError(networkError());
  }
  return payload;
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new InputDraftRequestError(networkError());
  }
  try {
    return await response.json();
  } catch {
    throw new InputDraftRequestError(networkError());
  }
}

function readApiError(payload: unknown) {
  if (isApiErrorResponse(payload)) return payload.error;
  return networkError();
}

function isApiErrorResponse(payload: unknown): payload is ApiErrorResponse {
  if (!payload || typeof payload !== "object" || !("error" in payload)) return false;
  const error = payload.error;
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    "message" in error &&
    typeof error.message === "string" &&
    "retryable" in error &&
    typeof error.retryable === "boolean"
  );
}

function isInputDraftDto(payload: unknown): payload is InputDraftDto {
  return (
    !!payload &&
    typeof payload === "object" &&
    "id" in payload &&
    typeof payload.id === "string" &&
    "revision" in payload &&
    typeof payload.revision === "number" &&
    "company" in payload &&
    typeof payload.company === "string" &&
    "title" in payload &&
    typeof payload.title === "string" &&
    "jdText" in payload &&
    typeof payload.jdText === "string"
  );
}

function networkError() {
  return {
    code: "NETWORK_ERROR" as const,
    message: "服务暂时不可用，请稍后重试。",
    retryable: true,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
