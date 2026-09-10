import { randomUUID } from "node:crypto";

import type {
  ApiErrorResponse,
  InputDraftDto,
  InputDraftInput,
  InputFieldError,
} from "web-contracts";

import { DraftApiError } from "./errors.js";
import { DraftService } from "./draft-service.js";
import { SupabaseRestError } from "./supabase.js";

const COLLECTION_PATH = "/api/input-drafts";

export type DraftApi = {
  handle(request: Request): Promise<Response>;
};

export function createDraftApi({
  draftService,
  requestIdFactory = randomUUID,
}: {
  draftService: DraftService;
  requestIdFactory?: () => string;
}): DraftApi {
  return {
    async handle(request: Request): Promise<Response> {
      const requestId = requestIdFactory();
      try {
        const url = new URL(request.url);
        if (url.pathname === COLLECTION_PATH && request.method === "POST") {
          return jsonResponse(
            await draftService.create(await readDraftInput(request)),
            201,
            requestId,
          );
        }

        const draftId = readDraftId(url.pathname);
        if (draftId && request.method === "GET") {
          const draft = await draftService.get(draftId);
          if (!draft) throw draftNotFound();
          return jsonResponse(draft, 200, requestId);
        }

        if (draftId && request.method === "PUT") {
          const result = await draftService.update(
            draftId,
            readExpectedRevision(request),
            await readDraftInput(request),
          );
          if (result.kind === "not-found") throw draftNotFound();
          if (result.kind === "conflict") throw draftConflict();
          return jsonResponse(result.draft, 200, requestId);
        }

        throw new DraftApiError({
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

async function readDraftInput(request: Request): Promise<InputDraftInput> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new DraftApiError({
      code: "REQUEST_INVALID",
      message: "Content-Type 必须是 application/json。",
      status: 400,
    });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    throw new DraftApiError({
      code: "REQUEST_INVALID",
      message: "请求正文不是有效 JSON。",
      status: 400,
    });
  }
  if (!payload || typeof payload !== "object") {
    throw invalidDraftInput();
  }

  const record = payload as Record<string, unknown>;
  const fieldErrors: InputFieldError[] = [];
  const resumeSourceId = readSourceId(record.resumeSourceId, fieldErrors);
  const company = readText(record.company, "company", "公司名称", fieldErrors);
  const title = readText(record.title, "title", "岗位名称", fieldErrors);
  const jdText = readText(record.jdText, "jd", "JD", fieldErrors);
  if (fieldErrors.length > 0) {
    throw invalidDraftInput(fieldErrors);
  }

  return { resumeSourceId, company, title, jdText };
}

function readSourceId(value: unknown, errors: InputFieldError[]): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    errors.push({ field: "resume", code: "INVALID", message: "简历来源无效。" });
    return null;
  }
  return value;
}

function readText(
  value: unknown,
  field: "company" | "title" | "jd",
  label: string,
  errors: InputFieldError[],
): string {
  if (typeof value !== "string") {
    errors.push({ field, code: "INVALID", message: `${label}格式无效。` });
    return "";
  }
  return value;
}

function readExpectedRevision(request: Request): number {
  const raw = request.headers.get("if-match")?.trim() ?? "";
  if (!/^\d+$/.test(raw)) {
    throw new DraftApiError({
      code: "REQUEST_INVALID",
      message: "更新 Draft 必须携带有效的 If-Match revision。",
      status: 400,
    });
  }
  const revision = Number(raw);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new DraftApiError({
      code: "REQUEST_INVALID",
      message: "更新 Draft 必须携带有效的 If-Match revision。",
      status: 400,
    });
  }
  return revision;
}

function readDraftId(pathname: string): string | null {
  const match = new RegExp(`^${COLLECTION_PATH}/([^/]+)$`).exec(pathname);
  return match ? decodeURIComponent(match[1]!) : null;
}

function draftNotFound(): DraftApiError {
  return new DraftApiError({
    code: "DRAFT_NOT_FOUND",
    message: "未找到这份输入草稿。",
    status: 404,
  });
}

function draftConflict(): DraftApiError {
  return new DraftApiError({
    code: "DRAFT_CONFLICT",
    message: "输入草稿已被其他请求更新，请重新读取后选择保留版本。",
    status: 409,
  });
}

function invalidDraftInput(fieldErrors?: InputFieldError[]): DraftApiError {
  return new DraftApiError({
    code: "REQUEST_INVALID",
    message: "输入草稿格式无效。",
    status: 400,
    fieldErrors,
  });
}

function jsonResponse(payload: InputDraftDto, status: number, requestId: string): Response {
  return Response.json(payload, {
    status,
    headers: { "x-request-id": requestId },
  });
}

function errorResponse(error: unknown, requestId: string): Response {
  if (!(error instanceof DraftApiError)) logUnexpectedApiError("draft", requestId, error);
  const safeError =
    error instanceof DraftApiError
      ? error
      : error instanceof SupabaseRestError && error.code === "22P02"
        ? new DraftApiError({
            code: "REQUEST_INVALID",
            message: "草稿 ID 无效。",
            retryable: false,
            status: 400,
          })
      : new DraftApiError({
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
      ...(safeError.fieldErrors ? { fieldErrors: safeError.fieldErrors } : {}),
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
