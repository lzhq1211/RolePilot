import { randomUUID } from "node:crypto";

import type { ApiErrorResponse, ResumeSourceDto } from "web-contracts";

import { SourceApiError } from "./errors.js";
import { SourceService } from "./source-service.js";
import { SupabaseRestError } from "./supabase.js";

const COLLECTION_PATH = "/api/resume-sources";

export type SourceApi = {
  handle(request: Request): Promise<Response>;
};

export function createSourceApi({
  sourceService,
  requestIdFactory = randomUUID,
}: {
  sourceService: SourceService;
  requestIdFactory?: () => string;
}): SourceApi {
  return {
    async handle(request: Request): Promise<Response> {
      const requestId = requestIdFactory();
      try {
        const url = new URL(request.url);
        if (url.pathname === COLLECTION_PATH && request.method === "POST") {
          return jsonResponse(
            await sourceService.create(
              await readCreateInput(request),
              request.headers.get("idempotency-key") ?? "",
            ),
            201,
            requestId,
          );
        }

        const sourceId = readSourceId(url.pathname);
        if (sourceId && request.method === "GET") {
          const source = await sourceService.get(sourceId);
          if (!source) {
            throw sourceNotFound();
          }
          return jsonResponse(source, 200, requestId);
        }

        if (sourceId && request.method === "DELETE") {
          const result = await sourceService.delete(sourceId);
          if (!result) {
            throw sourceNotFound();
          }
          if (result.kind === "pending-cleanup") {
            return jsonResponse(await sourceService.get(sourceId), 202, requestId);
          }
          return new Response(null, {
            status: 204,
            headers: { "x-request-id": requestId },
          });
        }

        throw new SourceApiError({
          code: "REQUEST_INVALID",
          message: "请求路径或方法无效。",
          status: 404,
        });
      } catch (error) {
        return errorResponse(error, requestId);
      }
    },
  };
}

async function readCreateInput(request: Request) {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.startsWith("application/json")) {
    return readPastedText(await readJson(request));
  }
  if (contentType.startsWith("multipart/form-data")) {
    return readMultipartFile(await request.formData());
  }
  throw new SourceApiError({
    code: "REQUEST_INVALID",
    message: "Content-Type 必须是 application/json 或 multipart/form-data。",
    status: 400,
  });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new SourceApiError({
      code: "REQUEST_INVALID",
      message: "请求正文不是有效 JSON。",
      status: 400,
    });
  }
}

function readPastedText(payload: unknown) {
  if (
    !payload ||
    typeof payload !== "object" ||
    !(
      "inputKind" in payload &&
      "text" in payload &&
      payload.inputKind === "pasted-text" &&
      typeof payload.text === "string"
    )
  ) {
    throw new SourceApiError({
      code: "REQUEST_INVALID",
      message: "粘贴简历请求无效。",
      status: 400,
    });
  }

  return {
    inputKind: "pasted-text" as const,
    bytes: new TextEncoder().encode(payload.text),
    originalFileName: null,
    declaredMediaType: "text/plain",
  };
}

async function readMultipartFile(formData: FormData) {
  const value = formData.get("file");
  if (!isFileUpload(value)) {
    throw new SourceApiError({
      code: "REQUEST_INVALID",
      message: "上传请求缺少 file。",
      status: 400,
    });
  }

  return {
    inputKind: "file" as const,
    bytes: new Uint8Array(await value.arrayBuffer()),
    originalFileName: value.name,
    declaredMediaType: value.type || null,
  };
}

function isFileUpload(
  value: FormDataEntryValue | null,
): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    typeof value.arrayBuffer === "function" &&
    "name" in value &&
    typeof value.name === "string" &&
    "type" in value &&
    typeof value.type === "string"
  );
}

function readSourceId(pathname: string): string | null {
  const match = /^\/api\/resume-sources\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

function sourceNotFound(): SourceApiError {
  return new SourceApiError({
    code: "SOURCE_NOT_FOUND",
    message: "未找到这份简历来源。",
    status: 404,
  });
}

function jsonResponse(
  payload: ResumeSourceDto | null,
  status: number,
  requestId: string,
): Response {
  return Response.json(payload, {
    status,
    headers: { "x-request-id": requestId },
  });
}

function errorResponse(error: unknown, requestId: string): Response {
  if (!(error instanceof SourceApiError)) logUnexpectedApiError("source", requestId, error);
  const safeError =
    error instanceof SourceApiError
      ? error
      : error instanceof SupabaseRestError && error.code === "22P02"
        ? new SourceApiError({
            code: "REQUEST_INVALID",
            message: "简历来源 ID 无效。",
            retryable: false,
            status: 400,
          })
      : new SourceApiError({
          code: "NETWORK_ERROR",
          message: "服务暂时不可用，请稍后重试。",
          retryable: true,
          status: 503,
        });
  const payload: ApiErrorResponse = {
    error: {
      code: safeError.code,
      message: safeError.message,
      retryable: safeError.retryable,
      requestId,
    },
  };
  return Response.json(payload, {
    status: safeError.status,
    headers: { "x-request-id": requestId },
  });
}

function logUnexpectedApiError(scope: string, requestId: string, error: unknown): void {
  const detail = formatError(error);
  process.stderr.write(`[RolePilot] ${scope} request ${requestId} failed: ${detail}\n`);
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = "code" in error && typeof error.code === "string" ? ` [${error.code}]` : "";
  return `${error.name}${code}: ${error.message}`;
}
