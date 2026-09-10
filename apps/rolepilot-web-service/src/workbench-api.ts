import { randomUUID } from "node:crypto";

import type { ApiErrorResponse, WorkbenchDto, WorkbenchSaveResponseDto } from "web-contracts";

import { SupabaseRestError } from "./supabase.js";
import { WorkbenchService, WorkbenchServiceError } from "./workbench-service.js";

export type WorkbenchApi = { handle(request: Request): Promise<Response> };

export function createWorkbenchApi({
  workbenchService,
  requestIdFactory = randomUUID,
}: {
  workbenchService: WorkbenchService;
  requestIdFactory?: () => string;
}): WorkbenchApi {
  return {
    async handle(request: Request): Promise<Response> {
      const requestId = requestIdFactory();
      try {
        const route = readRoute(new URL(request.url).pathname);
        if (!route) throw new WorkbenchServiceError("REQUEST_INVALID");
        if (route.kind === "workbench" && request.method === "GET") {
          return jsonResponse(await workbenchService.get(route.runId), requestId);
        }
        if (route.kind === "document" && request.method === "PUT") {
          const input = await readSaveInput(request);
          return jsonResponse(
            await workbenchService.save(route.runId, route.documentId, input.content, input.expectedRevision),
            requestId,
          );
        }
        throw new WorkbenchServiceError("REQUEST_INVALID");
      } catch (error) {
        return errorResponse(error, requestId);
      }
    },
  };
}

async function readSaveInput(request: Request): Promise<{ content: unknown; expectedRevision: number }> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new WorkbenchServiceError("REQUEST_INVALID");
  }
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new WorkbenchServiceError("REQUEST_INVALID");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkbenchServiceError("REQUEST_INVALID");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "content" && key !== "expectedRevision")
    || !("content" in record) || !Number.isSafeInteger(record.expectedRevision) || (record.expectedRevision as number) < 0) {
    throw new WorkbenchServiceError("REQUEST_INVALID");
  }
  return { content: record.content, expectedRevision: record.expectedRevision as number };
}

function readRoute(pathname: string):
  | { kind: "workbench"; runId: string }
  | { kind: "document"; runId: string; documentId: string }
  | null {
  const document = /^\/api\/runs\/([^/]+)\/workbench\/documents\/([^/]+)$/.exec(pathname);
  if (document) return { kind: "document", runId: decode(document[1]!), documentId: decode(document[2]!) };
  const workbench = /^\/api\/runs\/([^/]+)\/workbench$/.exec(pathname);
  return workbench ? { kind: "workbench", runId: decode(workbench[1]!) } : null;
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new WorkbenchServiceError("REQUEST_INVALID");
  }
}

function jsonResponse(payload: WorkbenchDto | WorkbenchSaveResponseDto, requestId: string): Response {
  return Response.json(payload, { headers: { "x-request-id": requestId } });
}

function errorResponse(error: unknown, requestId: string): Response {
  if (!(error instanceof WorkbenchServiceError)) logUnexpectedApiError("workbench", requestId, error);
  const mapped = mapError(error);
  const payload: ApiErrorResponse = {
    error: {
      code: mapped.code,
      message: mapped.message,
      retryable: mapped.retryable,
      requestId,
    },
  };
  return Response.json(payload, { status: mapped.status, headers: { "x-request-id": requestId } });
}

function mapError(error: unknown): {
  code: ApiErrorResponse["error"]["code"];
  message: string;
  retryable: boolean;
  status: number;
} {
  if (error instanceof WorkbenchServiceError) {
    if (error.code === "REQUEST_INVALID") return { code: error.code, message: "工作台请求无效。", retryable: false, status: 400 };
    if (error.code === "RUN_NOT_FOUND") return { code: error.code, message: "未找到这次运行。", retryable: false, status: 404 };
    if (error.code === "WORKBENCH_DOCUMENT_NOT_FOUND") return { code: error.code, message: "未找到这份工作台文档。", retryable: false, status: 404 };
    if (error.code === "WORKBENCH_REVISION_CONFLICT") return { code: error.code, message: "文档已被其他保存更新，请重新读取后再保存。", retryable: false, status: 409 };
    if (error.code === "RESULT_NOT_READY") return { code: error.code, message: "运行尚未完成。", retryable: false, status: 409 };
    if (error.code === "RESULT_CONTRACT_INVALID") return { code: error.code, message: "工作台结果合同无效。", retryable: false, status: 409 };
    return { code: "RESULT_UNAVAILABLE", message: "工作台结果暂时不可用。", retryable: false, status: 409 };
  }
  if (error instanceof SupabaseRestError && (error.code === "22P02" || error.code === "23514")) {
    return { code: "REQUEST_INVALID", message: "工作台请求无效。", retryable: false, status: 400 };
  }
  return { code: "NETWORK_ERROR", message: "服务暂时不可用，请稍后重试。", retryable: true, status: 503 };
}

function logUnexpectedApiError(scope: string, requestId: string, error: unknown): void {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  process.stderr.write(`[RolePilot] ${scope} request ${requestId} failed: ${detail}\n`);
}
