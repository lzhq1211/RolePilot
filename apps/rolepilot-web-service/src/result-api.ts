import { randomUUID } from "node:crypto";
import type { ApiErrorResponse } from "web-contracts";
import { ResultService, ResultServiceError } from "./result-service.js";
import { SupabaseRestError } from "./supabase.js";

export type ResultApi = { handle(request: Request): Promise<Response> };

export function createResultApi({ resultService, requestIdFactory = randomUUID }: { resultService: ResultService; requestIdFactory?: () => string }): ResultApi {
  return {
    async handle(request: Request): Promise<Response> {
      const requestId = requestIdFactory();
      try {
        const match = new URL(request.url).pathname.match(/^\/api\/runs\/([^/]+)\/result$/);
        if (!match || request.method !== "GET") throw new ResultServiceError("REQUEST_INVALID");
        return Response.json(await resultService.get(decodeURIComponent(match[1]!)), { headers: { "x-request-id": requestId } });
      } catch (error) {
        if (!(error instanceof ResultServiceError)) logUnexpectedApiError("result", requestId, error);
        const mapped = mapResultError(error);
        const payload: ApiErrorResponse = { error: { code: mapped.code, message: mapped.message, retryable: false, requestId } };
        return Response.json(payload, { status: mapped.status, headers: { "x-request-id": requestId } });
      }
    },
  };
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

function mapResultError(error: unknown): { code: ApiErrorResponse["error"]["code"]; message: string; status: number } {
  if (error instanceof ResultServiceError) {
    if (error.code === "REQUEST_INVALID") return { code: "REQUEST_INVALID", message: "请求路径或方法无效。", status: 400 };
    if (error.code === "RUN_NOT_FOUND") return { code: "RUN_NOT_FOUND", message: "未找到这次运行。", status: 404 };
    if (error.code === "RESULT_NOT_READY") return { code: "RESULT_NOT_READY", message: "运行尚未完成。", status: 409 };
    if (error.code === "RESULT_CONTRACT_INVALID") return { code: "RESULT_CONTRACT_INVALID", message: "结果暂时无法展示。", status: 409 };
    return { code: "RESULT_UNAVAILABLE", message: "结果暂时不可用。", status: 409 };
  }
  if (error instanceof SupabaseRestError && error.code === "22P02") return { code: "REQUEST_INVALID", message: "运行 ID 无效。", status: 400 };
  return { code: "NETWORK_ERROR", message: "服务暂时不可用，请稍后重试。", status: 503 };
}
