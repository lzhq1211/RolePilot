import type { DraftApi } from "./draft-api.js";
import type { RunApi } from "./run-api.js";
import type { ResultApi } from "./result-api.js";
import type { SourceApi } from "./source-api.js";
import type { WorkbenchApi } from "./workbench-api.js";
import { MaintenanceBusyError, type MaintenanceGate } from "./maintenance-gate.js";

export type WebApi = {
  handle(request: Request): Promise<Response>;
};

const retiredExportResponse = (): Response => Response.json(
  { error: { code: "EXPORT_UNAVAILABLE", message: "导出功能已退役，请在排版工作台手动保存或使用浏览器打印 PDF。", retryable: false, requestId: crypto.randomUUID() } },
  { status: 410 },
);

export function createWebApi({
  sourceApi,
  draftApi,
  runApi,
  resultApi,
  workbenchApi,
  cleanupApi,
  providerConfigApi,
  gate,
}: {
  sourceApi: SourceApi;
  draftApi: DraftApi;
  runApi?: RunApi;
  resultApi?: ResultApi;
  workbenchApi?: WorkbenchApi;
  cleanupApi?: WebApi;
  providerConfigApi?: WebApi;
  gate?: MaintenanceGate;
}): WebApi {
  const route = async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/input-drafts" || pathname.startsWith("/api/input-drafts/")) return draftApi.handle(request);
    if (providerConfigApi && pathname === "/api/provider-config") return providerConfigApi.handle(request);
    if (workbenchApi && /^\/api\/runs\/[^/]+\/workbench(?:\/|$)/.test(pathname)) return workbenchApi.handle(request);
    if (resultApi && pathname.startsWith("/api/runs/") && pathname.endsWith("/result")) return resultApi.handle(request);
    if ((pathname.startsWith("/api/runs/") && pathname.endsWith("/exports")) || pathname.startsWith("/api/exports/")) return retiredExportResponse();
    if (runApi && (pathname === "/api/runs" || pathname.startsWith("/api/runs/"))) return runApi.handle(request);
    return sourceApi.handle(request);
  };
  return {
    async handle(request: Request) {
      const pathname = new URL(request.url).pathname;
      if (cleanupApi && (pathname.startsWith("/api/maintenance/cleanup") || pathname === "/api/instance-data")) return cleanupApi.handle(request);
      try {
        return gate && !["GET", "HEAD", "OPTIONS"].includes(request.method) ? await gate.write(() => route(request)) : await route(request);
      } catch (error) {
        if (!(error instanceof MaintenanceBusyError)) throw error;
        return Response.json({ error: { code: "INSTANCE_BUSY", message: "实例正在清理，请稍后重试。", retryable: true, requestId: crypto.randomUUID() } }, { status: 409 });
      }
    },
  };
}
