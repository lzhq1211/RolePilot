import type { ApiError, ApiErrorResponse, ResumeSourceDto } from "web-contracts";

const SOURCE_COLLECTION_PATH = "/api/resume-sources";

export class ResumeSourceRequestError extends Error {
  readonly apiError: Pick<ApiError, "code" | "message" | "retryable">;

  constructor(apiError: Pick<ApiError, "code" | "message" | "retryable">) {
    super(apiError.message);
    this.name = "ResumeSourceRequestError";
    this.apiError = apiError;
  }
}

export function createClientRequestId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function createPastedResumeSource({
  text,
  requestId,
  signal,
}: {
  text: string;
  requestId: string;
  signal: AbortSignal;
}): Promise<ResumeSourceDto> {
  return requestSource({
    body: JSON.stringify({ inputKind: "pasted-text", text }),
    headers: { "content-type": "application/json" },
    requestId,
    signal,
  });
}

export async function createFileResumeSource({
  file,
  requestId,
  signal,
}: {
  file: File;
  requestId: string;
  signal: AbortSignal;
}): Promise<ResumeSourceDto> {
  const body = new FormData();
  body.append("file", file);
  return requestSource({ body, headers: {}, requestId, signal });
}

export async function getResumeSource({
  sourceId,
  signal,
}: {
  sourceId: string;
  signal: AbortSignal;
}): Promise<ResumeSourceDto> {
  let response: Response;
  try {
    response = await fetch(`${SOURCE_COLLECTION_PATH}/${encodeURIComponent(sourceId)}`, {
      headers: { "X-Request-ID": createClientRequestId() },
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw networkError();
  }

  const payload = await readJson(response);
  if (!response.ok) {
    throw new ResumeSourceRequestError(readApiError(payload));
  }
  if (!isResumeSourceDto(payload)) {
    throw networkError();
  }
  return payload;
}

async function requestSource({
  body,
  headers,
  requestId,
  signal,
}: {
  body: BodyInit;
  headers: HeadersInit;
  requestId: string;
  signal: AbortSignal;
}): Promise<ResumeSourceDto> {
  let response: Response;
  try {
    response = await fetch(SOURCE_COLLECTION_PATH, {
      body,
      headers: {
        ...headers,
        "Idempotency-Key": `resume-source-${requestId}`,
        "X-Request-ID": requestId,
      },
      method: "POST",
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw networkError();
  }

  const payload = await readJson(response);
  if (!response.ok) {
    throw new ResumeSourceRequestError(readApiError(payload));
  }
  if (!isResumeSourceDto(payload)) {
    throw networkError();
  }
  return payload;
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw networkError();
  }
  try {
    return await response.json();
  } catch {
    throw networkError();
  }
}

function readApiError(payload: unknown): Pick<ApiError, "code" | "message" | "retryable"> {
  if (isApiErrorResponse(payload)) {
    return payload.error;
  }
  return networkError().apiError;
}

function isApiErrorResponse(payload: unknown): payload is ApiErrorResponse {
  if (!payload || typeof payload !== "object" || !("error" in payload)) {
    return false;
  }
  const { error } = payload;
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

function isResumeSourceDto(payload: unknown): payload is ResumeSourceDto {
  return (
    !!payload &&
    typeof payload === "object" &&
    "id" in payload &&
    typeof payload.id === "string" &&
    "status" in payload &&
    typeof payload.status === "string" &&
    "inputKind" in payload &&
    (payload.inputKind === "file" || payload.inputKind === "pasted-text")
  );
}

function networkError(): ResumeSourceRequestError {
  return new ResumeSourceRequestError({
    code: "NETWORK_ERROR",
    message: "服务暂时不可用，请稍后重试。",
    retryable: true,
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
