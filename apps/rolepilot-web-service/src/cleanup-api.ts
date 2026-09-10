import { randomUUID } from "node:crypto";
import type { CleanupService } from "./cleanup-service.js";
import { MaintenanceBusyError } from "./maintenance-gate.js";

export function createCleanupApi(service: CleanupService) {
  return {
    async handle(request: Request): Promise<Response> {
      const requestId = randomUUID();
      const url = new URL(request.url);
      const fail = (code: string, message: string, status: number) => Response.json({ error: { code, message, retryable: false, requestId } }, { status, headers: { "x-request-id": requestId } });
      if (url.search || (request.method !== "GET" && (await request.text()).trim())) return fail("REQUEST_INVALID", "请求无效。", 400);
      try {
        if (url.pathname === "/api/maintenance/cleanup" && request.method === "GET") return Response.json(await service.status());
        if (url.pathname === "/api/maintenance/cleanup/retry" && request.method === "POST") {
          await service.retry();
          return new Response(null, { status: 202 });
        }
        if (url.pathname === "/api/instance-data" && request.method === "DELETE") {
          if (request.headers.get("x-rolepilot-confirm") !== "DELETE_ALL") return fail("REQUEST_INVALID", "请确认清空操作。", 400);
          await service.clear();
          return new Response(null, { status: 202 });
        }
        return fail("REQUEST_INVALID", "请求无效。", 400);
      } catch (error) {
        if (error instanceof MaintenanceBusyError) return fail("INSTANCE_BUSY", "请等待当前操作结束。", 409);
        return fail("CLEANUP_UNAVAILABLE", "清理服务暂时不可用。", 503);
      }
    },
  };
}
